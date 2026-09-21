(() => {
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const setText = (n, t) => { t = String(t); if (n._t !== t) { n.textContent = t; n._t = t; } };
const PALETTE = ['#e8a33d', '#2fb5c9', '#c96bd8', '#e5604d', '#7cc04a', '#5b8def', '#e0c341', '#9aa7b4'];
const toolHex = no => (no > 0 ? PALETTE[(no - 1) % PALETTE.length] : '#9aa7b4');
const hexRGB = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const BLUE = [0.24, 0.48, 1.0], GREEN = [0.21, 0.77, 0.39], NEUTRAL = [0.62, 0.68, 0.75], STEEL = [0.5, 0.55, 0.61];
// Tri-dexel's fused mesh is a one-time, static extraction (see rebuild()) - it never needs to
// track S.res, the CUTTING grids' resolution (which is what actually controls accuracy). Deliberately
// decoupled: on a real 71,984-move job, fusing at S.res's own default (360) measured 1.5s/1.65M
// triangles/40MB versus 122ms/250k triangles/6MB at this fixed, still-detailed target - a cost with
// no accuracy payoff, since the surface is only ever built once and never re-extracted live.
const TRI_FUSE_TARGET = 140;

const S = {
  prog: null, name: '', tools: [], simTools: new Map(), sim: null, sims: new Map(), planes: new Map(), snaps: [], finalH: null, finalOp: null,
  tau: 0, cur: { i: 0, f: 0 }, playing: false, speed: 30, pendingSeek: null, mode: 'progress', res: 360,
  token: 0, ready: false, curOp: -1, limited: false, stats: {}, needsRender: true, stock: null,
  path: 'op', rapids: false, holder: true, ghost: true, hudTool: -1, hudLine: -1, toolsDirty: false, setup: null, fixtures: true, stepMode: false,
  lastChainable: null, chainSeed: null, chainCoverage: null,
};

/* ================= viewer ================= */
const vp = $('vp');
let renderer, scene, camera;
try {
  if (!window.THREE) throw new Error('three.js did not load (offline or blocked). Check the network connection.');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
} catch (e) {
  $('fatal').hidden = false; $('fatalTxt').textContent = String(e.message || e);
  return;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
vp.insertBefore(renderer.domElement, vp.firstChild);
scene = new THREE.Scene();
camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
camera.up.set(0, 0, 1);
scene.add(new THREE.AmbientLight(0xffffff, 0.62));
const dl1 = new THREE.DirectionalLight(0xffffff, 0.78); dl1.position.set(0.5, -0.8, 1.4); scene.add(dl1);
const dl2 = new THREE.DirectionalLight(0xffffff, 0.3); dl2.position.set(-1, 0.6, 0.4); scene.add(dl2);

const invalidate = () => { S.needsRender = true; };
const orb = { tx: 0, ty: 0, tz: 0, az: -0.8, el: 0.6, dist: 220 };
function applyCamera() {
  const ce = Math.cos(orb.el);
  camera.position.set(orb.tx + orb.dist * ce * Math.cos(orb.az), orb.ty + orb.dist * ce * Math.sin(orb.az), orb.tz + orb.dist * Math.sin(orb.el));
  camera.up.set(0, 0, 1);
  camera.lookAt(orb.tx, orb.ty, orb.tz);
  camera.updateMatrixWorld();
  invalidate();
}
function resize() {
  const w = vp.clientWidth || 300, h = vp.clientHeight || 300;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(vp); else window.addEventListener('resize', resize);

function panBy(dx, dy) {
  const s = (2 * orb.dist * Math.tan(camera.fov * Math.PI / 360)) / (vp.clientHeight || 600);
  const m = camera.matrixWorld.elements;
  orb.tx += (-dx * m[0] + dy * m[4]) * s; orb.ty += (-dx * m[1] + dy * m[5]) * s; orb.tz += (-dx * m[2] + dy * m[6]) * s;
  applyCamera();
}
// World-space AABB across every plane's stock box (base plane's transform is identity, so this
// is bit-identical to using S.sim alone whenever there are no tilted planes). On a tri-dexel job,
// S.planes only holds the oblique fallback plane(s) (see rebuild()) - S.td.box (already in world
// coordinates) is merged in too, or the camera would fit around just the oblique sliver and miss
// the fused tri-dexel bulk entirely.
function worldPlaneBounds() {
  const b = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity };
  for (const [id, pl] of S.planes) {
    const sim = pl.sim, def = S.prog.planes.find(p => p.id === id), m = def.matrix, [ox, oy, oz] = def.origin;
    const x1 = sim.x0 + sim.nx * sim.dx, y1 = sim.y0 + sim.ny * sim.dy;
    for (const lx of [sim.x0, x1]) for (const ly of [sim.y0, y1]) for (const lz of [sim.zBot, sim.zTop]) {
      const wx = ox + m[0][0] * lx + m[0][1] * ly + m[0][2] * lz;
      const wy = oy + m[1][0] * lx + m[1][1] * ly + m[1][2] * lz;
      const wz = oz + m[2][0] * lx + m[2][1] * ly + m[2][2] * lz;
      if (wx < b.xmin) b.xmin = wx; if (wx > b.xmax) b.xmax = wx;
      if (wy < b.ymin) b.ymin = wy; if (wy > b.ymax) b.ymax = wy;
      if (wz < b.zmin) b.zmin = wz; if (wz > b.zmax) b.zmax = wz;
    }
  }
  if (S.triDexel && S.td) {
    const t = S.td.box;
    if (t.xmin < b.xmin) b.xmin = t.xmin; if (t.xmax > b.xmax) b.xmax = t.xmax;
    if (t.ymin < b.ymin) b.ymin = t.ymin; if (t.ymax > b.ymax) b.ymax = t.ymax;
    if (t.zmin < b.zmin) b.zmin = t.zmin; if (t.zmax > b.zmax) b.zmax = t.zmax;
  }
  return b;
}
function setView(name) {
  const have = S.sim || S.triDexel;
  if (name === 'fit' || name === 'iso') { orb.az = -0.8; orb.el = 0.6; }
  if (name === 'top') { orb.az = -Math.PI / 2; orb.el = 1.52; }
  if (name === 'front') { orb.az = -Math.PI / 2; orb.el = 0.04; }
  if (have && (name === 'fit' || name === 'iso' || name === 'top' || name === 'front')) {
    const b = worldPlaneBounds(), W = b.xmax - b.xmin, H = b.ymax - b.ymin, T = b.zmax - b.zmin;
    orb.tx = (b.xmin + b.xmax) / 2; orb.ty = (b.ymin + b.ymax) / 2; orb.tz = b.zmax - Math.min(T, 25) / 2;
    orb.dist = Math.max(W, H, T) * 1.9 + 30;
  }
  applyCamera();
}
const ptrs = new Map(); let moved = 0;
const cv = renderer.domElement;
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; });
cv.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const nx = e.clientX, ny = e.clientY;
  if (ptrs.size === 1) {
    const dx = nx - p.x, dy = ny - p.y; moved += Math.abs(dx) + Math.abs(dy);
    if (e.shiftKey || (e.buttons & 6)) panBy(dx, dy);
    else { orb.az -= dx * 0.008; orb.el = clamp(orb.el + dy * 0.008, -1.52, 1.52); applyCamera(); }
  } else if (ptrs.size === 2) {
    let other = null; for (const [id, q] of ptrs) if (id !== e.pointerId) other = q;
    const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(nx - other.x, ny - other.y);
    moved += 20;
    if (d0 > 0 && d1 > 0) { orb.dist = clamp(orb.dist * d0 / d1, 8, 6000); }
    panBy((nx - p.x) / 2, (ny - p.y) / 2);
  }
  p.x = nx; p.y = ny;
});
const endPtr = e => { const had = ptrs.delete(e.pointerId); if (had && ptrs.size === 0 && moved < 6 && e.type === 'pointerup') pickAt(e.clientX, e.clientY); };
cv.addEventListener('pointerup', endPtr); cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('wheel', e => { e.preventDefault(); orb.dist = clamp(orb.dist * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012)), 8, 6000); applyCamera(); }, { passive: false });

/* ---------- stock mesh (height field, corner vertices) ---------- */
const STOCK = { group: new THREE.Group(), top: null };
scene.add(STOCK.group);
// 3+2 Phase 3: one extra stock mesh per tilted plane, held here (STOCK itself stays the base
// plane's mesh, unchanged). Each tilted mesh's geometry is built entirely in that plane's own
// local coordinates - identical code to the base plane - and placed in world space purely by
// positioning/rotating its group with that plane's origin/matrix from engine.js.
const TILT_ROOT = new THREE.Group(); scene.add(TILT_ROOT);
// Tri-dexel: one fused, world-frame mesh covering every ALIGNED plane at once (see engine.js's
// buildTriDexel/fuseTriDexel). No group transform needed - fuseTriDexel's output is already in
// world coordinates, unlike TILT_ROOT's children which live in their own plane's local frame.
// Only ever holds 0 or 1 mesh. Real-only fixture/toolpath/tool code needs no changes at all to
// work with this - it was already drawn in this same world/WCS frame.
const TRI_ROOT = new THREE.Group(); scene.add(TRI_ROOT);
function planeQuaternion(m) {
  const m4 = new THREE.Matrix4().set(
    m[0][0], m[0][1], m[0][2], 0,
    m[1][0], m[1][1], m[1][2], 0,
    m[2][0], m[2][1], m[2][2], 0,
    0, 0, 0, 1
  );
  return new THREE.Quaternion().setFromRotationMatrix(m4);
}
function clearGroup(g) {
  for (const c of g.children.slice()) {
    g.remove(c);
    c.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
  }
}
function computeZV(sim, h, out, vi0, vi1, vj0, vj1) {
  const nx = sim.nx, ny = sim.ny, vx = nx + 1;
  for (let j = vj0; j <= vj1; j++) {
    const ja = j > 0 ? j - 1 : 0, jb = j < ny ? j : ny - 1;
    for (let i = vi0; i <= vi1; i++) {
      const ia = i > 0 ? i - 1 : 0, ib = i < nx ? i : nx - 1;
      out[j * vx + i] = 0.25 * (h[ja * nx + ia] + h[ja * nx + ib] + h[jb * nx + ia] + h[jb * nx + ib]);
    }
  }
}
// sim/finalH: which plane. stock: the mesh-holder object to (re)build into (STOCK for the base
// plane, one per tilted plane otherwise - see buildTiltStocks). Every tilted plane's stock.group
// is positioned/rotated by that plane's own transform, so the geometry itself stays in the
// plane's local coordinates, exactly like the base plane's always has been.
function buildStock(sim, stock, finalH) {
  clearGroup(stock.group);
  const nx = sim.nx, ny = sim.ny, vx = nx + 1, vy = ny + 1, nv = vx * vy;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const k = j * vx + i; pos[k * 3] = sim.x0 + i * sim.dx; pos[k * 3 + 1] = sim.y0 + j * sim.dy; pos[k * 3 + 2] = sim.zTop; nor[k * 3 + 2] = 1;
  }
  const idx = new Uint32Array(nx * ny * 6); let q = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = d; idx[q++] = a; idx[q++] = d; idx[q++] = c;
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aNor = new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('normal', aNor); geo.setAttribute('color', aCol);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const top = new THREE.Mesh(geo, mat); top.frustumCulled = false; stock.group.add(top);
  Object.assign(stock, { top, aPos, aNor, aCol, pos, nor, col, vx, zv: new Float32Array(nv).fill(sim.zTop), zvF: new Float32Array(nv) });
  computeZV(sim, finalH, stock.zvF, 0, nx, 0, ny);

  // side walls follow the outline of the top surface
  const per = [];
  for (let i = 0; i < nx; i++) per.push([i, 0, 0, -1]);
  for (let j = 0; j < ny; j++) per.push([nx, j, 1, 0]);
  for (let i = nx; i > 0; i--) per.push([i, ny, 0, 1]);
  for (let j = ny; j > 0; j--) per.push([0, j, -1, 0]);
  const m = per.length, sp = new Float32Array(m * 6), sn = new Float32Array(m * 6), sc = new Float32Array(m * 6), si = new Uint32Array(m * 6);
  per.forEach((p, k) => {
    const x = sim.x0 + p[0] * sim.dx, y = sim.y0 + p[1] * sim.dy;
    for (let s = 0; s < 2; s++) {
      const o = (2 * k + s) * 3;
      sp[o] = x; sp[o + 1] = y; sp[o + 2] = s ? sim.zBot : sim.zTop; sn[o] = p[2]; sn[o + 1] = p[3];
      sc[o] = STEEL[0]; sc[o + 1] = STEEL[1]; sc[o + 2] = STEEL[2];
    }
    const k1 = (k + 1) % m, t = 2 * k, b = 2 * k + 1, t1 = 2 * k1, b1 = 2 * k1 + 1;
    si.set([t, b, b1, t, b1, t1], k * 6);
  });
  const sg = new THREE.BufferGeometry();
  const aSp = new THREE.BufferAttribute(sp, 3).setUsage(THREE.DynamicDrawUsage);
  sg.setAttribute('position', aSp); sg.setAttribute('normal', new THREE.BufferAttribute(sn, 3)); sg.setAttribute('color', new THREE.BufferAttribute(sc, 3)); sg.setIndex(new THREE.BufferAttribute(si, 1));
  const skirt = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); skirt.frustumCulled = false;
  stock.group.add(skirt); Object.assign(stock, { per, sp, aSp });

  // underside
  const x0 = sim.x0, x1 = sim.x0 + nx * sim.dx, y0 = sim.y0, y1 = sim.y0 + ny * sim.dy, zb = sim.zBot;
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, y0, zb, x1, y0, zb, x1, y1, zb, x0, y1, zb]), 3));
  bg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]), 3));
  bg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12).fill(0.4), 3));
  bg.setIndex([0, 1, 2, 0, 2, 3]);
  stock.group.add(new THREE.Mesh(bg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));

  // outline of the original stock block
  const W = x1 - x0, H = y1 - y0, T = sim.zTop - sim.zBot;
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, T)), new THREE.LineBasicMaterial({ color: 0x8595a6, transparent: true, opacity: 0.6 }));
  ghost.position.set(x0 + W / 2, y0 + H / 2, sim.zBot + T / 2); ghost.visible = S.ghost;
  stock.group.add(ghost); stock.ghost = ghost;
}
const TOOL_RGB = new Map();
function paint(sim, stock, vi0, vi1, vj0, vj1) {
  const nx = sim.nx, ny = sim.ny, vx = nx + 1, dx = sim.dx, dy = sim.dy;
  const { zv, zvF, pos, nor, col } = stock, h = sim.h, ops = sim.op, progress = S.mode === 'progress', P = S.prog;
  for (let j = vj0; j <= vj1; j++) {
    const jl = j > 0 ? j - 1 : j, jr = j < ny ? j + 1 : j;
    for (let i = vi0; i <= vi1; i++) {
      const k = j * vx + i, il = i > 0 ? i - 1 : i, ir = i < nx ? i + 1 : i;
      pos[k * 3 + 2] = zv[k];
      const gx = (zv[j * vx + ir] - zv[j * vx + il]) / ((ir - il) * dx), gy = (zv[jr * vx + i] - zv[jl * vx + i]) / ((jr - jl) * dy);
      const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
      nor[k * 3] = -gx * inv; nor[k * 3 + 1] = -gy * inv; nor[k * 3 + 2] = inv;
      let c;
      if (progress) {
        const t = clamp((zv[k] - zvF[k]) / 0.06, 0, 1);
        col[k * 3] = GREEN[0] + (BLUE[0] - GREEN[0]) * t; col[k * 3 + 1] = GREEN[1] + (BLUE[1] - GREEN[1]) * t; col[k * 3 + 2] = GREEN[2] + (BLUE[2] - GREEN[2]) * t;
      } else {
        const ja = j > 0 ? j - 1 : 0, jb = j < ny ? j : ny - 1, ia = i > 0 ? i - 1 : 0, ib = i < nx ? i : nx - 1;
        let best = ja * nx + ia, bh = h[best], t2 = ja * nx + ib;
        if (h[t2] < bh) { bh = h[t2]; best = t2; }
        t2 = jb * nx + ia; if (h[t2] < bh) { bh = h[t2]; best = t2; }
        t2 = jb * nx + ib; if (h[t2] < bh) { best = t2; }
        const o = ops[best];
        c = o ? TOOL_RGB.get(P.ops[o - 1].tool) || NEUTRAL : NEUTRAL;
        col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
      }
    }
  }
}
function refreshStock(sim, stock, full) {
  if (!sim || !stock.top) return;
  let i0 = sim.di0, i1 = sim.di1, j0 = sim.dj0, j1 = sim.dj1;
  if (full) { i0 = 0; i1 = sim.nx - 1; j0 = 0; j1 = sim.ny - 1; }
  if (i1 < i0 || j1 < j0) return;
  const nx = sim.nx, ny = sim.ny, vx = nx + 1;
  const v1i = Math.min(nx, i1 + 1), v1j = Math.min(ny, j1 + 1);
  computeZV(sim, sim.h, stock.zv, i0, v1i, j0, v1j);
  const p0i = Math.max(0, i0 - 1), p1i = Math.min(nx, v1i + 1), p0j = Math.max(0, j0 - 1), p1j = Math.min(ny, v1j + 1);
  paint(sim, stock, p0i, p1i, p0j, p1j);
  const off = full ? 0 : p0j * vx * 3, cnt = full ? -1 : (p1j - p0j + 1) * vx * 3;
  for (const a of [stock.aPos, stock.aNor, stock.aCol]) { a.updateRange.offset = off; a.updateRange.count = cnt; a.needsUpdate = true; }
  const zv = stock.zv, sp = stock.sp;
  stock.per.forEach((p, k) => { sp[(2 * k) * 3 + 2] = zv[p[1] * vx + p[0]]; });
  stock.aSp.needsUpdate = true;
  sim.clearDirty(); invalidate();
}

/* ---------- tools ---------- */
const toolGroups = new Map();
const toolScene = new THREE.Group(); scene.add(toolScene);
function latheZ(points, segs, mat) {
  const g = new THREE.LatheGeometry(points.map(p => new THREE.Vector2(Math.max(p[0], 0.001), p[1])), segs);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, mat);
}
function cutterProfile(t) {
  const R = t.D / 2, Lc = t.flute, T = NC.simTool(t), pr = [];
  if (t.type === 'ball') { for (let a = 0; a <= 90; a += 10) { const r = a * Math.PI / 180; pr.push([R * Math.sin(r), R - R * Math.cos(r)]); } }
  else if (t.type === 'bull') { pr.push([0, 0], [T.r0, 0]); for (let a = 10; a <= 90; a += 10) { const r = a * Math.PI / 180; pr.push([T.r0 + T.rc * Math.sin(r), T.rc - T.rc * Math.cos(r)]); } }
  else if (t.type === 'drill' || t.type === 'chamfer') { pr.push([0, 0]); if (T.r0 > 0) pr.push([T.r0, 0]); pr.push([R, (R - T.r0) * T.slope]); }
  else pr.push([0, 0], [R, 0]);
  pr.push([R, Lc]);
  return pr;
}
function makeToolGroup(t) {
  const g = new THREE.Group();
  const side = THREE.DoubleSide;
  g.add(latheZ(cutterProfile(t), 32, new THREE.MeshLambertMaterial({ color: new THREE.Color(toolHex(t.no)), side })));
  g.add(latheZ([[t.D / 2, t.flute], [t.D / 2, t.stick]], 32, new THREE.MeshLambertMaterial({ color: 0xaab4bf, side })));
  const hp = [[0.001, t.stick]]; let y = t.stick;
  for (const s of NC.holderSegments(t)) { hp.push([s.d0 / 2, y]); y += s.h; hp.push([s.d1 / 2, y]); }
  hp.push([0.001, y]);
  const holder = latheZ(hp, 40, new THREE.MeshLambertMaterial({ color: 0x505a65, side }));
  holder.visible = S.holder; g.userData.holder = holder; g.add(holder);
  g.visible = false; g.frustumCulled = false;
  return g;
}
function buildToolGroups() {
  clearGroup(toolScene); toolGroups.clear(); S.hudTool = -1; S.activeTool = null;
  TOOL_RGB.clear();
  for (const t of S.tools) { toolGroups.set(t.no, makeToolGroup(t)); toolScene.add(toolGroups.get(t.no)); TOOL_RGB.set(t.no, hexRGB(toolHex(t.no))); }
}
function toolPos(i, f) {
  const P = S.prog, n = P.n, ii = Math.min(i, n - 1), ff = i >= n ? 1 : f;
  const sx = ii > 0 ? P.X[ii - 1] : P.init.x, sy = ii > 0 ? P.Y[ii - 1] : P.init.y, sz = ii > 0 ? P.Z[ii - 1] : P.init.z;
  return [sx + (P.X[ii] - sx) * ff, sy + (P.Y[ii] - sy) * ff, sz + (P.Z[ii] - sz) * ff, ii];
}
function updateTool() {
  const P = S.prog; if (!P || !P.n) return;
  const [x, y, z, ii] = toolPos(S.cur.i, S.cur.f), no = P.TL[ii];
  if (S.activeTool !== no) { const a = toolGroups.get(S.activeTool); if (a) a.visible = false; S.activeTool = no; }
  const g = toolGroups.get(no); if (!g) return;
  g.visible = true;
  if (g.position.x !== x || g.position.y !== y || g.position.z !== z || S.toolShown !== no) { g.position.set(x, y, z); S.toolShown = no; invalidate(); }
}

/* ---------- workholding from the Fusion export script ---------- */
const fixScene = new THREE.Group(); scene.add(fixScene);
function buildFixtures() {
  clearGroup(fixScene);
  for (const f of (S.setup && S.setup.fixtures) || []) {
    if (!f.positions || !f.indices || f.positions.length < 9) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(f.positions), 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(f.indices), 1));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8592a0, side: THREE.DoubleSide }));
    m.frustumCulled = false; fixScene.add(m);
  }
  fixScene.visible = S.fixtures; invalidate();
}
const stockFromSetup = s => ({ xmin: s.xmin, xmax: s.xmax, ymin: s.ymin, ymax: s.ymax, zbot: s.zmin, ztop: s.zmax });
// The exported setup JSON's wcs shape ({origin_raw, originUnit, x, y, z, originMM}) into the
// {origin, x, y, z} shape NC.transformPoints expects - originMM is the already-resolved origin.
const wcsFrame = w => ({ origin: w.originMM, x: w.x, y: w.y, z: w.z });
// Cross-checks so a wrong placement announces itself instead of silently drawing the vise in the wrong place.
function checkSetup(P, st, setup, chained) {
  const out = [];
  if (!setup) return out;
  const R = Math.max(...P.tools.map(t => t.D / 2)); let near = 0, n = 0;
  for (let i = 0; i < P.n; i++) if (P.K[i]) {
    n++;
    if (P.X[i] > st.xmin - R && P.X[i] < st.xmax + R && P.Y[i] > st.ymin - R && P.Y[i] < st.ymax + R && P.Z[i] > st.zbot - 1 && P.Z[i] < st.ztop + 1) near++;
  }
  if (n && near / n < 0.5) out.push(`Only ${Math.round(100 * near / n)}% of the cutting moves are inside the stock box. Either this setup file belongs to a different setup, or its coordinates do not line up with the program.`);
  // How deep does workholding sink into the stock? Pins and clamps entering by a few mm are normal;
  // a fixture in the wrong place sinks in much further. Sample across each triangle, because a big flat
  // vise face has almost no vertices to test.
  let depth = 0;
  for (const f of setup.fixtures || []) {
    const p = f.positions, ix = f.indices;
    for (let t = 0; t + 2 < ix.length; t += 3) {
      const a0 = ix[t] * 3, b0 = ix[t + 1] * 3, c0 = ix[t + 2] * 3;
      if (Math.max(p[a0], p[b0], p[c0]) < st.xmin || Math.min(p[a0], p[b0], p[c0]) > st.xmax || Math.max(p[a0 + 1], p[b0 + 1], p[c0 + 1]) < st.ymin || Math.min(p[a0 + 1], p[b0 + 1], p[c0 + 1]) > st.ymax || Math.max(p[a0 + 2], p[b0 + 2], p[c0 + 2]) < st.zbot || Math.min(p[a0 + 2], p[b0 + 2], p[c0 + 2]) > st.ztop) continue;
      const n = Math.min(24, Math.max(1, Math.ceil(Math.max(Math.hypot(p[b0] - p[a0], p[b0 + 1] - p[a0 + 1], p[b0 + 2] - p[a0 + 2]), Math.hypot(p[c0] - p[a0], p[c0 + 1] - p[a0 + 1], p[c0 + 2] - p[a0 + 2])) / 2)));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const s = i / n, r = j / n, w = 1 - s - r, x = w * p[a0] + s * p[b0] + r * p[c0], y = w * p[a0 + 1] + s * p[b0 + 1] + r * p[c0 + 1], z = w * p[a0 + 2] + s * p[b0 + 2] + r * p[c0 + 2];
        const dp = Math.min(x - st.xmin, st.xmax - x, y - st.ymin, st.ymax - y, z - st.zbot, st.ztop - z);
        if (dp > depth) depth = dp;
      }
    }
  }
  if (depth > 5) out.push(`Workholding sinks ${depth.toFixed(1)} mm into the stock box, so the fixture position may be off. (Pins and clamps entering the stock by a few mm are normal.)`);
  // Workholding should touch or nearly touch the stock. If nothing is close, it is probably in different coordinates.
  const fxs = setup.fixtures || [];
  if (fxs.length) {
    let best = 1e9;
    for (const f of fxs) {
      const q = f.positions; let lx = 1e9, ly = 1e9, lz = 1e9, hx = -1e9, hy = -1e9, hz = -1e9;
      for (let i = 0; i < q.length; i += 3) { if (q[i] < lx) lx = q[i]; if (q[i] > hx) hx = q[i]; if (q[i + 1] < ly) ly = q[i + 1]; if (q[i + 1] > hy) hy = q[i + 1]; if (q[i + 2] < lz) lz = q[i + 2]; if (q[i + 2] > hz) hz = q[i + 2]; }
      best = Math.min(best, Math.hypot(Math.max(0, lx - st.xmax, st.xmin - hx), Math.max(0, ly - st.ymax, st.ymin - hy), Math.max(0, lz - st.ztop, st.zbot - hz)));
    }
    if (best > 5) out.push(`The nearest workholding part is ${Math.round(best)} mm from the stock box, so it is probably in different coordinates and is not drawn where the stock is.`);
  }
  if (setup.stockMode != null && setup.stockMode !== 0 && setup.stockMode !== 1 && !(setup.stockMode === 7 && chained)) out.push('This setup uses solid or previous-setup stock. Only its bounding box is used here.');
  if (setup.check && setup.check.status === 'mismatch') out.push('The export script found the part outside the stock box once moved into setup coordinates, so its transform may be wrong.');
  return out;
}

/* ---------- toolpath lines ---------- */
const PATH = { feed: null, rapid: null };
function buildPaths() {
  for (const k of ['feed', 'rapid']) if (PATH[k]) { scene.remove(PATH[k]); PATH[k].geometry.dispose(); PATH[k].material.dispose(); PATH[k] = null; }
  const P = S.prog, n = P.n, fp = new Float32Array(n * 6), rp = new Float32Array(n * 6);
  let px = P.init.x, py = P.init.y, pz = P.init.z;
  for (let i = 0; i < n; i++) {
    const x = P.X[i], y = P.Y[i], z = P.Z[i], on = P.K[i] ? fp : rp, off = P.K[i] ? rp : fp, o = i * 6;
    on[o] = px; on[o + 1] = py; on[o + 2] = pz; on[o + 3] = x; on[o + 4] = y; on[o + 5] = z;
    off[o] = x; off[o + 1] = y; off[o + 2] = z; off[o + 3] = x; off[o + 4] = y; off[o + 5] = z;
    px = x; py = y; pz = z;
  }
  const mk = (arr, color, opacity) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    l.frustumCulled = false; l.renderOrder = 5; scene.add(l); return l;
  };
  PATH.feed = mk(fp, 0x14b8d8, 0.85); PATH.rapid = mk(rp, 0xf29d1f, 0.45);
  applyPaths();
}
function opRange(k) {
  const P = S.prog, a = P.ops[k].move, b = k + 1 < P.ops.length ? P.ops[k + 1].move : P.n;
  return [a, b];
}
function applyPaths() {
  if (!PATH.feed) return;
  const P = S.prog; let a = 0, b = P.n;
  if (S.path === 'op' && S.curOp >= 0 && P.ops.length) [a, b] = opRange(S.curOp);
  for (const k of ['feed', 'rapid']) {
    PATH[k].geometry.setDrawRange(a * 2, (b - a) * 2);
    PATH[k].visible = S.path !== 'off' && (k === 'feed' || S.rapids);
  }
  invalidate();
}

/* ---------- probe (click the stock to see which tool machined it) ---------- */
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickAt(cx, cy) {
  if (S.triDexel) return pickAtTri(cx, cy);
  const sim = S.sim; if (!sim || !S.ready) return;
  const r = cv.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  let t0 = 0, t1 = 1e9;
  const slabs = [[sim.x0, sim.x0 + sim.nx * sim.dx, o.x, d.x], [sim.y0, sim.y0 + sim.ny * sim.dy, o.y, d.y], [sim.zBot, sim.zTop, o.z, d.z]];
  for (const [lo, hi, oo, dd] of slabs) {
    if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return hideProbe(); }
    else { let a = (lo - oo) / dd, c = (hi - oo) / dd; if (a > c) { const q = a; a = c; c = q; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return hideProbe(); }
  }
  const step = Math.min(sim.dx, sim.dy) * 0.5;
  for (let t = t0; t <= t1; t += step) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const i = Math.floor((x - sim.x0) / sim.dx), j = Math.floor((y - sim.y0) / sim.dy);
    if (i < 0 || j < 0 || i >= sim.nx || j >= sim.ny) continue;
    if (z <= sim.h[j * sim.nx + i] + 1e-4) return showProbe(i, j, cx - r.left, cy - r.top);
  }
  hideProbe();
}
function hideProbe() { $('probe').hidden = true; }
function showProbe(i, j, px, py) {
  const sim = S.sim, P = S.prog, idx = j * sim.nx + i, box = $('probe');
  const live = sim.op[idx], fin = S.finalOp[idx], z = sim.h[idx], left = z - S.finalH[idx];
  const X = sim.x0 + (i + 0.5) * sim.dx, Y = sim.y0 + (j + 0.5) * sim.dy;
  let head, body = '', btn = '', opk = -1;
  const oname = k => `T${P.ops[k].tool}, ${esc(P.ops[k].label)}`;
  if (live) { opk = live - 1; head = 'Machined by ' + oname(opk); body = left > 0.02 ? `${left.toFixed(2)} mm of material still to come off here.` : 'At its final depth for this program.'; btn = 'Replay this operation'; }
  else if (fin) { opk = fin - 1; head = 'Not cut yet'; body = 'Will be machined by ' + oname(opk) + '.'; btn = 'Jump to that operation'; }
  else { head = 'Original stock surface'; body = 'This program never touches this spot.'; }
  box.innerHTML = `<h3>${head}</h3><p>${body}<br>X ${X.toFixed(2)}  Y ${Y.toFixed(2)}  Z ${z.toFixed(2)}</p><div class="row">${btn ? '<button class="btn primary" id="probeGo" type="button">' + btn + '</button>' : ''}<button class="btn" id="probeX" type="button">Close</button></div>`;
  box.hidden = false;
  const w = vp.clientWidth, h = vp.clientHeight;
  box.style.left = clamp(px + 14, 8, Math.max(8, w - 286)) + 'px'; box.style.top = clamp(py + 14, 8, Math.max(8, h - box.offsetHeight - 8)) + 'px';
  $('probeX').onclick = hideProbe;
  if (btn) $('probeGo').onclick = () => { hideProbe(); goToOp(opk); S.playing = true; updatePlay(); };
}

// Probe for a tri-dexel job: raycast TRI_ROOT's real triangle mesh directly (simpler than the
// hand-rolled AABB march above, since the mesh is a real triangulated solid in world space), then
// use the hit face's world normal to find which signed grid (Z+/Z-/Y+/Y-/X+/X-) the hit face
// belongs to - the culled-voxel-face meshing means every face is an axis-aligned quad, so the
// matching grid's signed direction has a dot product with the normal close to +1, every other
// candidate close to -1 or 0. The world hit point is then re-expressed in that grid's own local
// (i,j) column - the same axis permutation triSampleSolid/fuseTriDexel use in engine.js, inlined
// here rather than exported since it's a few lines and this is the only other place that needs it -
// so its .op[] (provenance) can be read directly. Oblique planes (rendered via TILT_ROOT, not
// TRI_ROOT) are not hit by this raycast at all and stay unprobable, same as today.
function pickAtTri(cx, cy) {
  if (!S.td || !S.ready) return;
  const mesh = TRI_ROOT.children[0];
  if (!mesh) return hideProbe();
  const r = cv.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length || !hits[0].face) return hideProbe();
  const hit = hits[0];
  const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
  let bestKey = null, bestDot = -Infinity;
  for (const key of S.td.grids.keys()) {
    const axisIdx = 'XYZ'.indexOf(key[0]), sign = key[1] === '+' ? 1 : -1;
    const dot = sign * (axisIdx === 0 ? n.x : axisIdx === 1 ? n.y : n.z);
    if (dot > bestDot) { bestDot = dot; bestKey = key; }
  }
  if (!bestKey) return hideProbe();
  const grid = S.td.grids.get(bestKey), axisIdx = 'XYZ'.indexOf(bestKey[0]);
  const wx = hit.point.x, wy = hit.point.y, wz = hit.point.z;
  const ax = axisIdx === 2 ? wx : axisIdx === 0 ? wy : wz;
  const ay = axisIdx === 2 ? wy : axisIdx === 0 ? wz : wx;
  const i = Math.floor((ax - grid.x0) / grid.dx), j = Math.floor((ay - grid.y0) / grid.dy);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return hideProbe();
  showProbeTri(grid, i, j, cx - r.left, cy - r.top);
}
function showProbeTri(grid, i, j, px, py) {
  const P = S.prog, idx = j * grid.nx + i, box = $('probe');
  const live = grid.op[idx];
  const oname = k => `T${P.ops[k].tool}, ${esc(P.ops[k].label)}`;
  let head, body = '', btn = '', opk = -1;
  if (live) { opk = live - 1; head = 'Machined by ' + oname(opk); body = 'At its final depth for this program.'; btn = 'Replay this operation'; }
  else { head = 'Original stock surface'; body = 'This program never touches this spot.'; }
  box.innerHTML = `<h3>${head}</h3><p>${body}</p><div class="row">${btn ? '<button class="btn primary" id="probeGo" type="button">' + btn + '</button>' : ''}<button class="btn" id="probeX" type="button">Close</button></div>`;
  box.hidden = false;
  const w = vp.clientWidth, h = vp.clientHeight;
  box.style.left = clamp(px + 14, 8, Math.max(8, w - 286)) + 'px'; box.style.top = clamp(py + 14, 8, Math.max(8, h - box.offsetHeight - 8)) + 'px';
  $('probeX').onclick = hideProbe;
  if (btn) $('probeGo').onclick = () => { hideProbe(); goToOp(opk); S.playing = true; updatePlay(); };
}

/* ================= program loading and simulation ================= */
function toast(msg, ms = 5000) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
function showBusy(txt, frac) { $('busy').hidden = false; setText($('busyTxt'), txt); $('busyBar').style.width = Math.round(clamp(frac, 0, 1) * 100) + '%'; }
function hideBusy() { $('busy').hidden = true; }
const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });

function autoStock() {
  const P = S.prog, b = P.bounds, r2 = v => Math.round(v * 100) / 100;
  const ztop = b.zmin < -0.001 ? 0 : r2(b.zmax), cs = S.csv && S.csv.stock;
  if (cs) {   // size from the setup sheet, centred on the cutting area; top at the highest cutting Z
    const cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2;
    S.stock = { xmin: r2(cx - cs.x / 2), xmax: r2(cx + cs.x / 2), ymin: r2(cy - cs.y / 2), ymax: r2(cy + cs.y / 2), ztop, zbot: r2(ztop - cs.z) };
    return;
  }
  const rmax = Math.max(...P.tools.map(t => t.D / 2)), pad = rmax + 4, depth = Math.max(ztop - b.zmin, 1);
  S.stock = {
    xmin: Math.floor(b.xmin - pad), xmax: Math.ceil(b.xmax + pad), ymin: Math.floor(b.ymin - pad), ymax: Math.ceil(b.ymax + pad),
    ztop, zbot: Math.round((Math.min(b.zmin, ztop - 1) - Math.max(3, depth * 0.5)) * 10) / 10,
  };
}
function fillStockInputs() { for (const k of ['xmin', 'xmax', 'ymin', 'ymax', 'zbot', 'ztop']) $('s' + k).value = S.stock[k]; }
function readStockInputs() {
  const s = {}; for (const k of ['xmin', 'xmax', 'ymin', 'ymax', 'zbot', 'ztop']) s[k] = parseFloat($('s' + k).value);
  if (Object.values(s).some(v => !isFinite(v)) || s.xmax - s.xmin < 1 || s.ymax - s.ymin < 1 || s.ztop - s.zbot < 0.5) return null;
  return s;
}

const readBuf = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(f); });

async function loadText(text, name, opts = {}) {
  try {
    const un = $('unitSel').value;
    const P = NC.parseProgram(text, { units: un === 'auto' ? undefined : un });
    if (!P.n) { toast('No tool motion found in that file. Is it a G-code program?'); return; }
    const csv = opts.csv || null, lib = opts.lib || null, setup = opts.setup || null, info = [];
    if (csv) { const n = NC.applyCsvTools(P.tools, csv); info.push(`Setup sheet: ${n} tool${n === 1 ? '' : 's'} sized from it.`); }
    if (opts.tools) for (const o of opts.tools) { const t = P.tools.find(x => x.no === o.no); if (t) { Object.assign(t, o); t.defaulted = false; NC.completeTool(t); } }
    if (lib) { const n = NC.applyLibrary(lib, P.tools); info.push(`Tool library: matched ${n} of ${P.tools.length} tools, holders included.`); }
    const opsList = opts.ops || (csv && csv.ops) || null, extraWarn = [];
    if (opsList) {
      const same = opsList.length === P.ops.length && opsList.every((o, i) => o.tool === P.ops[i].tool);
      if (same) P.ops.forEach((o, i) => { if (opsList[i].label) o.label = opsList[i].label; if (opsList[i].dim) o.dim = opsList[i].dim; });
      else if (opts.ops) extraWarn.push(`The job file lists ${opsList.length} operations but the program has ${P.ops.length}, so operation names come from the program's own comments. The file may be out of date.`);
    }
    // Cross-setup stock chaining: this setup's stock comes from whatever the LAST fully-simulated
    // setup (in this session) left behind, if that setup's own result is still available and this
    // one says its stock is "from preceding setup". Fusion doesn't expose that shape for us to
    // fetch directly (see docs/NOTES.md) - S.lastChainable is our own record of it.
    let chainSeed = null;
    if (setup && setup.stockMode === 7 && setup.wcs && setup.wcs.originMM && S.lastChainable && S.lastChainable.name !== (setup.setup || name)) {
      chainSeed = { mesh: S.lastChainable.mesh, fromWcs: S.lastChainable.wcs, toWcs: wcsFrame(setup.wcs), fromName: S.lastChainable.name };
    }
    S.chainSeed = chainSeed; S.chainCoverage = null;

    S.ready = false; S.playing = false; updatePlay(); S.curOp = -1; S.cur = { i: 0, f: 0 }; S.tau = 0;
    S.text = text; S.csv = csv; S.lib = lib; S.setup = setup; S.opsList = opts.ops || null; S.exported = opts.exported || null; S.docName = opts.document || null;
    S.prog = P; S.name = name; S.tools = P.tools; S.toolsDirty = false;
    setText($('fname'), name + (opts.exported ? '   exported ' + opts.exported.slice(0, 16).replace('T', ' ') : ''));
    if (opts.stock) S.stock = Object.assign({}, opts.stock); else if (setup && setup.stock) S.stock = stockFromSetup(setup.stock); else autoStock();
    fillStockInputs(); buildToolCards(); buildOps(); buildTicks(); buildPaths();
    if (setup) info.push(`Setup file "${setup.setup || 'setup'}": ${setup.stock ? 'stock box from Fusion' : 'no stock box, using a guess'}, ${(setup.fixtures || []).length} workholding part${(setup.fixtures || []).length === 1 ? '' : 's'}.`);
    if (opts.exported) info.push('Job file exported ' + opts.exported.replace('T', ' ') + (opts.document ? ' from "' + opts.document + '"' : '') + '.');
    if (setup && setup.stockMode === 7) {
      if (chainSeed) info.push(`Stock seeded from the previous setup's finished result ("${chainSeed.fromName}").`);
      else extraWarn.push(`This setup uses "from previous setup" stock, but no other setup's simulated result is available this session - using a flat block guess instead. Load the previous setup first, then this one, to chain them.`);
    }
    const usedTools = new Set(P.TL);
    const undercutTools = P.tools.filter(t => t.undercut && usedTools.has(t.no));
    if (undercutTools.length) extraWarn.push(`Undercut tool${undercutTools.length === 1 ? '' : 's'} (${undercutTools.map(t => 'T' + t.no).join(', ')}): the shape can't be simulated by this engine, so stock removal is skipped for it - the toolpath still plays, it just doesn't cut.`);
    const lines = info.concat(P.notes), warnList = P.warnings.concat(extraWarn, checkSetup(P, S.stock, setup, !!chainSeed));
    $('warns').innerHTML = lines.map(esc).join('<br>') + (warnList.length ? (lines.length ? '<br>' : '') + '<b>Heads up</b><br>' + warnList.map(esc).join('<br>') : '');
    await rebuild(true);
    if (chainSeed && S.chainCoverage != null && S.chainCoverage < 0.05) {
      $('warns').innerHTML += (warnList.length || lines.length ? '<br>' : '<b>Heads up</b><br>') +
        `The chained stock from "${chainSeed.fromName}" barely overlaps this setup's stock box (${Math.round(S.chainCoverage * 100)}% covered) - the two setups' WCS placements may not line up, or this pairing may be wrong.`;
    }
  } catch (err) { console.error(err); hideBusy(); toast('Could not read that program: ' + err.message); }
}
// Accepts any mix of: G-code program, setup-sheet CSV, Fusion .tools / tool-library JSON, job bundle JSON.
async function handleFiles(files) {
  exitCodeEdit();   // loading anything new always drops out of an in-progress G-code edit
  const b = { text: null, name: '', csv: null, lib: null, bundle: null, setup: null, job: null };
  for (const f of files) {
    try {
      const n = f.name;
      if (/\.tools$/i.test(n)) b.lib = JSON.parse(await NC.unzipText(await readBuf(f)));
      else if (/\.csv$/i.test(n)) { b.csv = NC.parseSetupCsv(await readFile(f)); if (!b.csv) toast(n + ' does not look like a setup sheet, so it was skipped.'); }
      else {
        const text = await readFile(f);
        if (/\.json$/i.test(n) || /^\s*[\[{]/.test(text.slice(0, 20))) { const j = JSON.parse(text); if (j && j.format === 'floorsim-job') b.job = j; else if (j && typeof j.gcode === 'string') b.bundle = j; else if (j && j.format === 'floorsim-setup') b.setup = j; else b.lib = j; }
        else { b.text = text; b.name = n; }
      }
    } catch (err) { console.error(err); toast('Could not open ' + f.name + ': ' + err.message); }
  }
  if (b.job) return loadText(b.job.gcode, b.job.program || 'Job', { setup: b.job, lib: b.job.toolLibrary, ops: b.job.ops, exported: b.job.exported, document: b.job.document });
  if (b.bundle) return loadText(b.bundle.gcode, b.bundle.name || 'Job bundle', { stock: b.bundle.stock, tools: b.bundle.tools, csv: b.csv, lib: b.lib, setup: b.setup });
  if (b.text) return loadText(b.text, b.name, { csv: b.csv, lib: b.lib, setup: b.setup });
  if ((b.csv || b.lib || b.setup) && S.text) return loadText(S.text, S.name, { csv: b.csv || S.csv, lib: b.lib || S.lib, setup: b.setup || S.setup, ops: S.opsList, exported: S.exported, document: S.docName });
  if (b.csv || b.lib || b.setup) toast('Open the program (.NC) first, or select it together with the CSV, .tools and setup files.');
}

/* ---------- "Open job folder": groups every file in a shared folder by program number ----------
   The shared folder has every job's files mixed together (not one folder per job - see NOTES.md),
   so this groups files by their name with a known extension stripped (O1224.NC, O1224.csv,
   O1224.floorsim.json all become program "O1224"), then either loads the one match instantly or
   shows a small picker sorted newest-first when the folder holds more than one program. */
function classifyFolderFile(name) {
  if (/\.floorsim\.json$/i.test(name)) return { kind: 'job/setup', program: name.replace(/\.floorsim\.json$/i, '') };
  if (/\.nc$/i.test(name)) return { kind: 'NC', program: name.replace(/\.nc$/i, '') };
  if (/\.csv$/i.test(name)) return { kind: 'CSV', program: name.replace(/\.csv$/i, '') };
  if (/\.tools$/i.test(name)) return { kind: 'tools', program: name.replace(/\.tools$/i, '') };
  if (/\.json$/i.test(name)) return { kind: 'JSON', program: name.replace(/\.json$/i, '') };
  return null;
}
function groupFolderFiles(fileList) {
  const groups = new Map();
  for (const f of fileList) {
    const c = classifyFolderFile(f.name);
    if (!c || !c.program) continue;
    let g = groups.get(c.program);
    if (!g) { g = { program: c.program, files: [], kinds: new Set(), newest: 0 }; groups.set(c.program, g); }
    g.files.push(f); g.kinds.add(c.kind); g.newest = Math.max(g.newest, f.lastModified || 0);
  }
  return [...groups.values()].filter(g => g.kinds.has('NC')).sort((a, b) => b.newest - a.newest);
}
function openFolder(fileList) {
  const list = groupFolderFiles(fileList);
  if (!list.length) { toast('No .NC files found in that folder.'); return; }
  if (list.length === 1) { handleFiles(list[0].files); return; }
  showPicker(list);
}
function hidePicker() { $('pickerBack').hidden = true; }
function showPicker(list) {
  const back = $('pickerBack'), input = $('pickerSearch'), ul = $('pickerList');
  input.value = '';
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const filtered = q ? list.filter(g => g.program.toLowerCase().includes(q)) : list;
    ul.innerHTML = filtered.length
      ? filtered.map(g => `<li><button type="button" data-program="${esc(g.program)}"><span>${esc(g.program)}</span><span class="files">${[...g.kinds].sort().join(', ')}</span></button></li>`).join('')
      : '<li class="empty">No matching program.</li>';
    ul.querySelectorAll('button[data-program]').forEach(btn => {
      btn.onclick = () => { const g = list.find(x => x.program === btn.dataset.program); hidePicker(); if (g) handleFiles(g.files); };
    });
  };
  render();
  input.oninput = render;
  back.hidden = false;
  input.focus();
}

// sims: Map<planeId, HeightSim>, one per plane actually used (buildPlaneSims) - on a tri-dexel
// job this is restricted to the oblique fallback plane(s) only (see rebuild()). Snapshots now
// hold every plane's state together (state: Map<planeId, {h,op}>) so scrubbing restores all
// planes in lockstep off the one shared program timeline.
// td: NC.buildTriDexel's result, or null. Its grids are cut here too (once, for the whole
// program) but deliberately NOT snapshotted/restored - the fused mesh built from them after this
// completes is static through playback/scrubbing (see rebuild()); only S.sims needs live re-cutting.
async function prepass(token, sims, td) {
  const P = S.prog, n = P.n;
  for (const sim of sims.values()) sim.reset();
  // Cross-setup stock chaining: seed plane 0's starting surface from a previous setup's finished
  // result, right after reset() and before any of THIS setup's own moves are cut. Never applies on
  // a tri-dexel job (plane 0 is always aligned, so it's never in this oblique-only sims map) -
  // tri-dexel chaining is a separate, unsolved problem (see plan), not attempted here.
  if (S.chainSeed && sims.has(0)) {
    const tpos = NC.transformPoints(S.chainSeed.mesh.pos, S.chainSeed.fromWcs, S.chainSeed.toWcs);
    S.chainCoverage = NC.seedHeightSim(sims.get(0), tpos, S.chainSeed.mesh.idx);
  }
  let bytes = 0; for (const sim of sims.values()) bytes += sim.nx * sim.ny * 6;
  const maxSnaps = clamp(Math.floor(90e6 / Math.max(1, bytes)), 6, 60), every = Math.max(64, Math.ceil(n / maxSnaps));
  const snaps = [], t0 = performance.now(); let last = t0;
  for (let i = 0; i < n; i++) {
    if (i % every === 0) { const state = new Map(); for (const [id, sim] of sims) state.set(id, sim.snapshot()); snaps.push({ i, state }); }
    NC.cutMoveMulti(sims, P, S.simTools, i, 0, 1);
    if (td) NC.cutTriDexelMove(td, P, S.simTools, i, 0, 1);
    if ((i & 15) === 15) {
      const now = performance.now();
      if (now - last > 30) { showBusy(td ? 'Simulating the whole program (tri-dexel)' : 'Simulating the whole program', i / n); await new Promise(r => setTimeout(r, 0)); if (token !== S.token) return null; last = performance.now(); }
    }
  }
  const finals = new Map(); for (const [id, sim] of sims) finals.set(id, { h: sim.h.slice(), op: sim.op.slice() });
  return { snaps, finals, ms: performance.now() - t0 };
}
async function rebuild(fresh) {
  const token = ++S.token; S.ready = false; S.playing = false; updatePlay(); hideProbe();
  const box = readStockInputs();
  if (!box) { toast('Check the stock box: each max must be larger than its min.'); hideBusy(); return; }
  S.stock = box;
  showBusy('Preparing simulation', 0);
  await new Promise(r => setTimeout(r, 30));
  S.simTools = new Map(S.tools.map(t => [t.no, NC.simTool(t)]));
  const stockBox = { xmin: box.xmin, xmax: box.xmax, ymin: box.ymin, ymax: box.ymax, zbot: box.zbot, ztop: box.ztop };
  // Tri-dexel only kicks in once there's more than the trivial base plane worth sharing a world
  // frame for - a single-plane job (the common case) or a multi-plane job with nothing but the
  // base aligned takes exactly today's per-plane path, unchanged, at zero cost/regression risk.
  const cls = NC.classifyPlanes(S.prog.planes);
  S.triDexel = cls.alignedIds.size > 1;
  if (S.triDexel) {
    S.td = NC.buildTriDexel(S.prog, S.res, 5);
    // Oblique planes (e.g. a real, non-90-degree G68.2 tilt) can't join the shared tri-dexel
    // frame - see docs/plan - so they still get their own HeightSim via the ordinary, unmodified
    // buildPlaneSims/cutMoveMulti path, restricted to just that subset via the new onlyIds param.
    S.sims = NC.buildPlaneSims(S.prog, stockBox, S.res, 5, cls.obliqueIds);
  } else {
    S.td = null;
    S.sims = NC.buildPlaneSims(S.prog, stockBox, S.res);
  }
  S.sim = S.sims.get(0);   // undefined on the tri-dexel path - plane 0 is always aligned, never in this map
  let r;
  try { r = await prepass(token, S.sims, S.td); } catch (err) { console.error(err); hideBusy(); toast('Simulation failed: ' + err.message); return; }
  if (!r || token !== S.token) return;
  S.snaps = r.snaps;
  const fin0 = r.finals.get(0);
  S.finalH = fin0 ? fin0.h : null; S.finalOp = fin0 ? fin0.op : null;   // null on the tri-dexel path - no working probe there yet (Phase 3)
  // Grid-resolution chip: on a tri-dexel job there's no single S.sim to report, so use whichever
  // signed grid happens to be first - purely informational (all grids target the same ~S.res
  // density), not something anything else depends on.
  const statSim = S.sim || (S.td && S.td.grids.size ? S.td.grids.values().next().value : null);
  S.stats = { ms: r.ms, moves: S.prog.n, nx: statSim ? statSim.nx : 0, ny: statSim ? statSim.ny : 0, dx: statSim ? statSim.dx : 0 };

  // one mesh-holder per plane: STOCK itself for the base plane (same object every rebuild, as
  // always), a fresh one per tilted plane positioned/rotated by that plane's own transform. On a
  // tri-dexel job S.sims only has the oblique fallback plane(s), so this loop naturally builds
  // only those - plane 0 (and every other aligned plane) is covered by TRI_ROOT's fused mesh
  // instead, built below.
  clearGroup(TILT_ROOT); clearGroup(TRI_ROOT);
  S.planes = new Map();
  for (const pl of S.prog.planes) {
    if (!S.sims.has(pl.id)) continue;
    let stock;
    if (pl.id === 0) stock = STOCK;
    else {
      stock = { group: new THREE.Group() };
      stock.group.position.set(pl.origin[0], pl.origin[1], pl.origin[2]);
      stock.group.quaternion.copy(planeQuaternion(pl.matrix));
      TILT_ROOT.add(stock.group);
    }
    const sim = S.sims.get(pl.id), fin = r.finals.get(pl.id);
    buildStock(sim, stock, fin.h);
    S.planes.set(pl.id, { sim, stock, finalH: fin.h, finalOp: fin.op });
  }
  STOCK.group.visible = !S.triDexel;   // TRI_ROOT covers plane 0's contribution on the tri-dexel path
  if (S.triDexel) {
    // Built once, from the finished prepass state - not re-fused live per frame (fuseTriDexel's
    // cost, ~110ms at the resolution this was validated at, is far past the 9ms/frame playback
    // budget). Tool, toolpath lines and HUD keep animating normally; only this mesh is static
    // through playback/scrubbing. Deliberate v1 UX tradeoff versus today's live per-plane removal.
    const { pos, idx } = NC.fuseTriDexel(S.td, TRI_FUSE_TARGET);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    // Neutral steel-ish grey, not blue/green: this mesh shows only the finished simulated result,
    // never live in-progress removal, so the usual "blue = still to remove / green = at final
    // size" convention (which needs a live vs. target comparison) would be misleading here.
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(STEEL[0], STEEL[1], STEEL[2]), side: THREE.DoubleSide });
    TRI_ROOT.add(new THREE.Mesh(geo, mat));
  }

  buildToolGroups(); buildFixtures();
  for (const [id, sim] of S.sims) sim.restore(S.snaps[0].state.get(id));
  S.cur = { i: 0, f: 0 }; S.tau = 0; S.curOp = -1; S.hudLine = -1; S.hudTool = -1;
  for (const pl of S.planes.values()) refreshStock(pl.sim, pl.stock, true);
  updateTool(); applyPaths(); buildLegend();
  if (fresh || !S.camSet) { setView('fit'); S.camSet = true; }
  const target = S.prog.total / 30;
  const opts = [...$('speedSel').options].map(o => +o.value);
  if (fresh) { S.speed = opts.reduce((a, b) => (Math.abs(Math.log(b / target)) < Math.abs(Math.log(a / target)) ? b : a)); $('speedSel').value = String(S.speed); }
  // Remember this setup's finished result for a LATER "from preceding setup" load to chain from.
  // Always overwritten (even to null) so a stale chain never survives loading something unrelated
  // in between - only the most recently loaded program with real WCS data is ever chainable.
  const pl0 = S.planes.get(0);
  S.lastChainable = (S.setup && S.setup.wcs && S.setup.wcs.originMM && pl0)
    ? { name: S.setup.setup || S.name, wcs: wcsFrame(S.setup.wcs), mesh: NC.meshFromHeightArray(pl0.sim.nx, pl0.sim.ny, pl0.sim.dx, pl0.sim.dy, pl0.sim.x0, pl0.sim.y0, pl0.finalH) }
    : null;
  hideBusy(); S.ready = true; updateHud(true); updateChips(true);
}

/* ---------- playback ---------- */
function advance(target, budget) {
  const P = S.prog, cum = P.cumT, n = P.n, t0 = performance.now();
  let { i, f } = S.cur, cnt = 0; S.limited = false;
  while (i < n) {
    const s0 = i > 0 ? cum[i - 1] : 0, e0 = cum[i], dur = e0 - s0;
    if (target >= e0 || dur <= 1e-12) {
      NC.cutMoveMulti(S.sims, P, S.simTools, i, f, 1);
      const done = i; i++; f = 0; S.tau = e0;
      // Step mode: pause right after the move that finishes an operation (so the operator sees
      // it complete before the next one starts), or the move where cutter comp first turns on
      // (so they can read the tool and D value off the HUD right as it activates). Only during
      // actual playback, not while a scrub/seek is catching up via this same function.
      if (S.stepMode && S.playing) {
        const compJustOn = P.CC[done] && (done === 0 || !P.CC[done - 1]);
        const opEnding = i < n && P.OP[i] !== P.OP[done];
        if (compJustOn || opEnding) { S.playing = false; updatePlay(); break; }
      }
      if ((++cnt & 7) === 0 && performance.now() - t0 > budget) { S.limited = true; break; }
    } else {
      const nf = (target - s0) / dur;
      if (nf > f) { NC.cutMoveMulti(S.sims, P, S.simTools, i, f, nf); f = nf; }
      S.tau = target; break;
    }
  }
  S.cur = { i, f };
  if (i >= P.n) S.tau = P.total;
}
function locate(tau) {
  const cum = S.prog.cumT, n = S.prog.n; let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < tau) lo = m + 1; else hi = m; }
  if (lo >= n) return { i: n, f: 0 };
  const s0 = lo > 0 ? cum[lo - 1] : 0, dur = cum[lo] - s0;
  return { i: lo, f: dur > 0 ? clamp((tau - s0) / dur, 0, 1) : 1 };
}
function goTo(tau) {
  const P = S.prog; tau = clamp(tau, 0, P.total);
  const tgt = locate(tau), cur = S.cur;
  let snap = null; for (const s of S.snaps) if (s.i <= tgt.i) snap = s; else break;
  const back = tgt.i < cur.i || (tgt.i === cur.i && tgt.f < cur.f);
  if (snap && (back || snap.i > cur.i)) {
    for (const [id, sim] of S.sims) sim.restore(snap.state.get(id));
    S.cur = { i: snap.i, f: 0 }; S.tau = snap.i > 0 ? P.cumT[snap.i - 1] : 0;
  }
  advance(tau, 220);
  if (S.tau < tau - 1e-6 && S.cur.i < P.n) S.pendingSeek = tau;
}
const opStart = k => { const P = S.prog, m = P.ops[k].move; return m > 0 ? P.cumT[m - 1] : 0; };
function goToOp(k) { if (!S.ready) return; S.pendingSeek = opStart(clamp(k, 0, S.prog.ops.length - 1)); S.playing = false; updatePlay(); }
function togglePlay() {
  if (!S.ready) return;
  if (!S.playing && S.tau >= S.prog.total - 1e-6) S.pendingSeek = 0;
  S.playing = !S.playing; updatePlay();
}
function updatePlay() {
  $('playIcon').innerHTML = S.playing ? '<path d="M6 4.5h4.2v15H6zM13.8 4.5H18v15h-4.2z"/>' : '<path d="M7 4.5v15L19.5 12z"/>';
  $('bPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
}

/* ================= operator panel ================= */
function toolLabel(t) {
  const ty = { flat: 'Flat end mill', ball: 'Ball end mill', bull: 'Bull nose end mill', drill: 'Drill', chamfer: 'Chamfer mill' }[t.type] || t.type;
  return t.name && !/^T\d+$/.test(t.name) && t.name.toLowerCase() !== ty.toLowerCase() ? t.name : ty;
}
function toolSVG(t) {
  const cap = t.stick + 30, H = cap, s = Math.min(100 / H, 50 / Math.max(t.holderD, t.D)), cx = 29, base = 103;
  const P = (pts, fill) => {
    const r = pts.map(p => [cx + p[0] * s, base - p[1] * s]), l = pts.slice().reverse().map(p => [cx - p[0] * s, base - p[1] * s]);
    return `<polygon points="${r.concat(l).map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="${fill}" stroke="rgba(0,0,0,.35)" stroke-width=".8"/>`;
  };
  const hp = [[0, t.stick]]; let y = t.stick;
  for (const sg of NC.holderSegments(t)) {
    if (y >= cap) break;
    const y2 = Math.min(y + sg.h, cap), f = sg.h > 0 ? (y2 - y) / sg.h : 1;
    hp.push([sg.d0 / 2, y]); hp.push([sg.d0 / 2 + (sg.d1 / 2 - sg.d0 / 2) * f, y2]); y = y2;
  }
  hp.push([0, y]);
  return P(hp, '#505a65') + P([[0, t.flute], [t.D / 2, t.flute], [t.D / 2, t.stick], [0, t.stick]], '#aab4bf') + P(cutterProfile(t).concat([[0, t.flute]]), toolHex(t.no));
}
function coolText(c) { const a = []; if (c & 1) a.push('Flood'); if (c & 2) a.push('Mist'); if (c & 4) a.push('Thru-spindle'); return a.length ? a.join(' + ') : 'Off'; }
let lastHud = 0;
function updateHud(force) {
  const P = S.prog; if (!P || !P.n) return;
  const now = performance.now(); if (!force && now - lastHud < 90) return; lastHud = now;
  const [x, y, z, i] = toolPos(S.cur.i, S.cur.f), no = P.TL[i], t = S.tools.find(q => q.no === no);
  if (no !== S.hudTool && t) {
    S.hudTool = no;
    setText($('tNo'), no ? 'T' + no : 'T-');
    setText($('tName'), toolLabel(t));
    setText($('tDims'), `Ø${+t.D.toFixed(3)} mm` + (t.type === 'bull' ? `, R${+t.rc.toFixed(2)}` : '') + `, flute ${+t.flute.toFixed(1)}`);
    $('tSvg').innerHTML = toolSVG(t);
  }
  setText($('rSpin'), Math.round(P.S[i]));
  const rapid = !P.K[i];
  setText($('rFeedL'), rapid ? 'Moving' : 'Feed mm/min'); setText($('rFeed'), rapid ? 'Rapid' : Math.round(P.F[i]));
  setText($('rCool'), coolText(P.CO[i]));
  if (P.OP[i] !== S.curOp) { S.curOp = P.OP[i]; onOpChange(); }
  const op = P.ops[S.curOp];
  setText($('opNow'), op ? op.label : ''); setText($('opSub'), `Operation ${S.curOp + 1} of ${P.ops.length}`);
  setText($('pX'), x.toFixed(3)); setText($('pY'), y.toFixed(3)); setText($('pZ'), z.toFixed(3));
  setText($('timeTxt'), mmss(S.tau) + ' / ' + mmss(P.total));
  if (!S.scrubbing) $('scrub').value = P.total > 0 ? Math.round(S.tau / P.total * 10000) : 0;
  if (P.LN[i] !== S.hudLine) { S.hudLine = P.LN[i]; renderCode(S.hudLine); }
}
function renderCode(ln) {
  const L = S.prog.lines, a = Math.max(1, ln - 6), b = Math.min(L.length, a + 12); let h = '';
  for (let k = a; k <= b; k++) h += `<div class="ln${k === ln ? ' cur' : ''}"><i>${k}</i><span>${esc(L[k - 1])}</span></div>`;
  $('code').innerHTML = h;
}

/* ---------- G-code editing: never saved, just re-run through the normal load path ---------- */
function enterCodeEdit() {
  if (!S.prog) return;
  S.playing = false; updatePlay();
  $('codeEdit').value = S.text || '';
  $('code').hidden = true; $('codeEditWrap').hidden = false; $('codeEditBtn').hidden = true;
  $('codeEdit').focus();
}
function exitCodeEdit() {
  $('code').hidden = false; $('codeEditWrap').hidden = true; $('codeEditBtn').hidden = false;
}
async function runCodeEdit() {
  const newText = $('codeEdit').value;
  const baseName = S.name.replace(/ \(edited\)$/, '');
  await loadText(newText, baseName + ' (edited)', { csv: S.csv, lib: S.lib, setup: S.setup, ops: S.opsList, exported: S.exported, document: S.docName });
  if (S.text === newText) exitCodeEdit();   // stay in edit mode on failure so the typo is still there to fix
}
function onOpChange() {
  applyPaths();
  for (const b of $('ops').querySelectorAll('button')) b.setAttribute('aria-current', String(+b.dataset.k === S.curOp));
  const cur = $('ops').querySelector('[aria-current="true"]');
  if (cur) { const box = $('ops'), cr = cur.getBoundingClientRect(), br = box.getBoundingClientRect(); if (cr.top < br.top || cr.bottom > br.bottom) box.scrollTop += cr.top - br.top - 40; }
}
function buildOps() {
  const P = S.prog;
  $('ops').innerHTML = P.ops.map((o, k) => {
    const badges = (o.comp ? `<span class="opbadge cc">${o.comp === 1 ? 'G41' : 'G42'}${o.compD ? ' D' + o.compD : ''}</span>` : '') +
      (o.dim ? `<span class="opbadge dim">${esc(o.dim)}</span>` : '');
    return `<li class="${o.dim ? 'op-dim' : ''}"><button type="button" data-k="${k}" aria-current="false"><span class="sw" style="background:${toolHex(o.tool)}"></span><span class="t">T${o.tool}</span><span class="opline"><span class="oplabel">${esc(o.label)}</span>${badges ? `<span class="opbadges">${badges}</span>` : ''}</span></button></li>`;
  }).join('');
  $('ops').querySelectorAll('button').forEach(b => { b.onclick = () => goToOp(+b.dataset.k); });
}
function buildTicks() {
  const P = S.prog; let prev = -1;
  $('ticks').innerHTML = P.ops.map((o, k) => {
    const left = P.total > 0 ? opStart(k) / P.total * 100 : 0, chg = o.tool !== prev; prev = o.tool;
    return `<div class="tick" style="left:${left}%;background:${chg ? toolHex(o.tool) : 'var(--muted)'};opacity:${chg ? 1 : .5}" title="${esc(o.label)}"></div>`;
  }).join('');
}
function buildLegend() {
  const P = S.prog;
  $('legend').innerHTML = S.mode === 'progress'
    ? '<div><span class="sw" style="background:var(--blue)"></span>Material still to remove</div><div><span class="sw" style="background:var(--green)"></span>At final size for this program</div>'
    : '<div><span class="sw" style="background:#9eaebf"></span>Not touched</div>' + S.tools.map(t => `<div><span class="sw" style="background:${toolHex(t.no)}"></span>T${t.no} ${esc(toolLabel(t))}, Ø${+t.D.toFixed(2)}</div>`).join('');
}
function buildToolCards() {
  const typeOpts = [['flat', 'Flat end mill'], ['ball', 'Ball end mill'], ['bull', 'Bull nose'], ['drill', 'Drill'], ['chamfer', 'Chamfer mill']];
  const fields = [['D', 'Diameter'], ['rc', 'Corner radius'], ['flute', 'Flute length'], ['stick', 'Length below holder'], ['holderD', 'Holder diameter'], ['holderH', 'Holder length']];
  $('toolCards').innerHTML = S.tools.map(t => `<div class="tool-card" data-no="${t.no}"><h4><span class="sw" style="background:${toolHex(t.no)}"></span>T${t.no} ${esc(toolLabel(t))}${t.fromLib ? ' (from tool library)' : t.fromCsv ? ' (from setup sheet)' : t.guessed ? ' (read from tool name)' : t.defaulted ? ' (no size in program, guessed)' : ''}</h4><div class="grid2">
    <label class="f">Type<select data-k="type">${typeOpts.map(o => `<option value="${o[0]}"${o[0] === t.type ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>
    ${fields.map(f => `<label class="f">${f[1]}<input data-k="${f[0]}" type="number" step="0.1" min="0" value="${+(+t[f[0]]).toFixed(3)}"></label>`).join('')}
  </div></div>`).join('');
  $('toolCards').querySelectorAll('.tool-card').forEach(card => {
    const t = S.tools.find(x => x.no === +card.dataset.no);
    card.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.k; t[k] = k === 'type' ? inp.value : parseFloat(inp.value) || 0;
      if (k === 'holderD' || k === 'holderH') t.holderSegs = null;
      S.toolsDirty = true; $('applyTools').classList.add('primary');
    }));
  });
}
function updateChips(force) {
  const st = S.stats; if (!st.nx) return;
  const c = []; c.push(`grid ${st.nx}x${st.ny}, ${st.dx.toFixed(2)} mm`);
  c.push(`whole program simulated in ${(st.ms / 1000).toFixed(st.ms > 9999 ? 0 : 1)} s (${st.moves.toLocaleString()} moves)`);
  if (S.csv && S.csv.cycleSec && S.prog) c.push(`cycle estimate ${mmss(S.prog.total)}, setup sheet ${mmss(S.csv.cycleSec)}`);
  if (S.fps) c.push(`${S.fps} fps`);
  if (S.limited && S.playing) c.push('sim-limited: this device cannot keep up at this speed');
  const html = c.map((s, k) => `<span class="chip${s.startsWith('sim-limited') ? ' warn' : ''}">${esc(s)}</span>`).join('');
  if (force || html !== updateChips._h) { updateChips._h = html; $('chips').innerHTML = html; }
}

/* ================= wiring ================= */
$('fileProg').onchange = e => { const fl = [...e.target.files]; e.target.value = ''; handleFiles(fl); };
$('fileFolder').onchange = e => { const fl = [...e.target.files]; e.target.value = ''; openFolder(fl); };
$('pickerCancel').onclick = hidePicker;
$('pickerBack').addEventListener('click', e => { if (e.target === $('pickerBack')) hidePicker(); });
document.addEventListener('keydown', e => { if (e.code === 'Escape' && !$('pickerBack').hidden) hidePicker(); });
$('codeEditBtn').onclick = enterCodeEdit;
$('codeCancel').onclick = exitCodeEdit;
$('codeRun').onclick = runCodeEdit;
$('fileLib').onchange = e => { const fl = [...e.target.files]; e.target.value = ''; handleFiles(fl); };
$('unitSel').onchange = () => { exitCodeEdit(); if (S.text) loadText(S.text, S.name, { csv: S.csv, lib: S.lib, setup: S.setup, ops: S.opsList, exported: S.exported, document: S.docName }); };
$('demoSel').onchange = e => {
  exitCodeEdit();
  const v = e.target.value; e.target.value = '';
  if (v === 'demo') loadText(NC.demoProgram(), 'Demo program', { stock: { xmin: -50, xmax: 50, ymin: -35, ymax: 35, zbot: -20, ztop: 0 } });
  if (v === 'stress') loadText(NC.stressProgram(), 'Stress test', { stock: { xmin: -50, xmax: 50, ymin: -50, ymax: 50, zbot: -12, ztop: 0 } });
};
$('themeBtn').onclick = () => {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  r.dataset.theme = dark ? 'light' : 'dark';
};
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  S.mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  if (S.sim && S.prog) { buildLegend(); for (const pl of S.planes.values()) refreshStock(pl.sim, pl.stock, true); }
});
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$('bPlay').onclick = togglePlay;
$('bRestart').onclick = () => { if (S.ready) { S.pendingSeek = 0; S.playing = false; updatePlay(); } };
$('bNext').onclick = () => { if (S.ready) goToOp(Math.min(S.curOp + 1, S.prog.ops.length - 1)); };
$('bPrev').onclick = () => { if (S.ready) goToOp(S.tau - opStart(S.curOp) > 1.5 ? S.curOp : Math.max(0, S.curOp - 1)); };
$('speedSel').onchange = e => { S.speed = +e.target.value; };
$('stepMode').onchange = e => { S.stepMode = e.target.checked; };
$('resSel').onchange = e => { S.res = +e.target.value; if (S.prog) rebuild(false); };
$('applyStock').onclick = () => { if (S.prog) rebuild(false); };
$('applyTools').onclick = () => { if (!S.prog) return; S.tools.forEach(NC.completeTool); $('applyTools').classList.remove('primary'); buildToolCards(); rebuild(false); };
$('pathSel').onchange = e => { S.path = e.target.value; applyPaths(); };
$('rapidSel').onchange = e => { S.rapids = e.target.value === 'on'; applyPaths(); };
$('holderSel').onchange = e => { S.holder = e.target.value === 'on'; toolGroups.forEach(g => { g.userData.holder.visible = S.holder; }); invalidate(); };
$('fixSel').onchange = e => { S.fixtures = e.target.value === 'on'; fixScene.visible = S.fixtures; invalidate(); };
$('ghostSel').onchange = e => { S.ghost = e.target.value === 'on'; if (STOCK.ghost) STOCK.ghost.visible = S.ghost; invalidate(); };
const scrub = $('scrub');
scrub.addEventListener('pointerdown', () => { S.scrubbing = true; });
scrub.addEventListener('input', () => { if (!S.ready) return; S.playing = false; updatePlay(); S.pendingSeek = scrub.value / 10000 * S.prog.total; });
const endScrub = () => { S.scrubbing = false; };
scrub.addEventListener('pointerup', endScrub); scrub.addEventListener('change', endScrub); scrub.addEventListener('blur', endScrub);
document.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target !== scrub) return;
  if (e.code === 'Space' && e.target.tagName === 'BUTTON') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowRight' && e.target !== scrub) $('bNext').click();
  else if (e.code === 'ArrowLeft' && e.target !== scrub) $('bPrev').click();
  else if (e.code === 'Home') $('bRestart').click();
  else if (e.code === 'Escape') hideProbe();
});
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; vp.classList.add('drop'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; vp.classList.remove('drop'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; vp.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]); });

/* ================= frame loop ================= */
let lastT = performance.now(), fpsN = 0, fpsT = lastT, errShown = false;
function frame(now) {
  requestAnimationFrame(frame);
  try {
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
    if (S.ready && S.prog) {
      if (S.pendingSeek !== null) { const tg = S.pendingSeek; S.pendingSeek = null; goTo(tg); }
      else if (S.playing) {
        advance(Math.min(S.prog.total, S.tau + dt * S.speed), 9);
        if (S.tau >= S.prog.total - 1e-9 && S.cur.i >= S.prog.n) { S.playing = false; updatePlay(); }
      }
      for (const pl of S.planes.values()) refreshStock(pl.sim, pl.stock, false);
      updateTool(); updateHud(false);
    }
    if (S.needsRender) { S.needsRender = false; renderer.render(scene, camera); fpsN++; }
    if (now - fpsT > 1000) { S.fps = S.playing ? Math.round(fpsN * 1000 / (now - fpsT)) : 0; fpsN = 0; fpsT = now; updateChips(false); }
    if (S.playing) invalidate();
  } catch (err) { console.error(err); if (!errShown) { errShown = true; toast('Something went wrong in the viewer: ' + err.message); } }
}
resize(); setView('fit');
requestAnimationFrame(frame);
window.__floorsim = { S, orb, goTo, advance, loadText, handleFiles, openFolder, groupFolderFiles, enterCodeEdit, exitCodeEdit, runCodeEdit, fixScene, rebuild, STOCK, TILT_ROOT, TRI_ROOT, toolGroups, renderer, pickAt, camera, scene };   // handy for debugging in the console
loadText(NC.demoProgram(), 'Demo program', { stock: { xmin: -50, xmax: 50, ymin: -35, ymax: 35, zbot: -20, ztop: 0 } });
})();
