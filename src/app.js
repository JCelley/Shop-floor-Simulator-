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
// Tri-dexel's fused mesh is re-extracted from the live grids as the program plays, so its
// resolution is deliberately decoupled from S.res (the CUTTING grids' resolution, which is what
// actually controls accuracy). Two targets, both measured on the real 71,984-move O1224 job with
// its real stock box: TARGET is for a SETTLED picture (paused/scrubbed/finished) where there's no
// frame budget to protect - 54ms, 194k triangles. LIVE is for re-fusing DURING playback - 11ms,
// 64k triangles, which is the sweet spot on the measured curve (50 -> 9.3ms/24k, 60 -> 10.5ms/36k,
// 80 -> 11.3ms/64k, 100 -> 20.8ms/98k, 140 -> 53.9ms/194k: 80 buys nearly triple the detail of 50
// for ~2ms, because the cost is dominated by occupancy sampling, not triangle emission).
const TRI_FUSE_TARGET = 140, TRI_FUSE_LIVE = 80;
// Floor on the gap between live re-fuses. At 11ms a fuse that's ~7% of the budget on this desktop;
// a ~4x slower Chromebook lands near 30%, which the existing "sim-limited" chip already surfaces
// if the device genuinely can't keep up.
const TRI_FUSE_MIN_MS = 150;
// How far a plane's real tool axis may sit from a world axis and still join the shared tri-dexel
// grids. Not 0 (classifyPlanes' own default is a near-zero 0.01deg, just enough to absorb
// floating-point rounding on an exact 90deg multiple): real Fusion setups routinely produce
// several "planes" that are the same physical vertical operation but differ by a degree or two of
// floating-point noise, and sending those to the disconnected oblique fallback needlessly is both
// slower (a whole extra HeightSim per "plane") and was the wrong lever entirely for the one job
// that actually needed it. Not large either (round 3's spike tried 60deg - "snap anything closer
// to this axis than any other"): that wrongly force-fit a real 14.66deg tilt into vertical-tool
// math and produced a genuine ~20mm depth error - confirmed by tracing it to an exact plane/tool,
// not a guess. 5deg cleanly separates the two cases on every real job measured (spike/NOTES3.md).
const TRI_DEXEL_TOL_DEG = 5;

const S = {
  prog: null, name: '', tools: [], simTools: new Map(), sim: null, sims: new Map(), planes: new Map(), snaps: [], finalH: null, finalOp: null,
  tau: 0, cur: { i: 0, f: 0 }, playing: false, speed: 30, pendingSeek: null, mode: 'progress', res: 360,
  token: 0, ready: false, curOp: -1, limited: false, stats: {}, needsRender: true, stock: null,
  path: 'op', rapids: false, holder: true, ghost: true, hudTool: -1, hudLine: -1, toolsDirty: false, setup: null, fixtures: true, stepMode: false,
  lastChainable: null, chainSeed: null, chainCoverage: null, partMesh: null,
  td: null, triDexel: false, triDirty: false, triFuseAt: 0, triFuseLive: null,
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
// Perspective by default; the Ortho button swaps in a parallel projection sized so the same
// orb.dist shows the same amount of the part - zoom, pan and fit all keep working unchanged.
const FOV = 35;
const perspCam = new THREE.PerspectiveCamera(FOV, 1, 0.5, 20000);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
perspCam.up.set(0, 0, 1); orthoCam.up.set(0, 0, 1);
camera = perspCam;
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
  if (camera === orthoCam) fitOrtho();
  camera.updateMatrixWorld();
  invalidate();
}
// Half-height of what the perspective camera sees at the orbit target - the ortho frustum uses it too.
const viewHalfH = () => orb.dist * Math.tan(FOV * Math.PI / 360);
function fitOrtho() {
  const w = vp.clientWidth || 300, h = vp.clientHeight || 300, hh = viewHalfH();
  orthoCam.left = -hh * w / h; orthoCam.right = hh * w / h; orthoCam.top = hh; orthoCam.bottom = -hh;
  orthoCam.updateProjectionMatrix();
}
function resize() {
  const w = vp.clientWidth || 300, h = vp.clientHeight || 300;
  renderer.setSize(w, h, false);
  perspCam.aspect = w / h; perspCam.updateProjectionMatrix(); fitOrtho(); invalidate();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(vp); else window.addEventListener('resize', resize);
function setOrtho(on) {
  camera = on ? orthoCam : perspCam;
  $('projBtn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('floorsim.ortho', on ? '1' : '0'); } catch (e) { /* storage blocked - just not remembered */ }
  applyCamera();
}

function panBy(dx, dy) {
  const s = (2 * viewHalfH()) / (vp.clientHeight || 600);
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
  // Undercut tools: draw the same ball/disk/cone-then-neck shape that does the cutting.
  // ucProf is [height, radius]; the lathe wants [radius, height].
  if (T.ucProf) { const p = T.ucProf.filter(q => q[0] <= t.stick).map(q => [q[1], q[0]]); return (p[0][0] > 0 ? [[0, 0]] : []).concat(p); }
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
  if (!t.undercut) g.add(latheZ([[t.D / 2, t.flute], [t.D / 2, t.stick]], 32, new THREE.MeshLambertMaterial({ color: 0xaab4bf, side })));
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
  const c = dispCur(), [x, y, z, ii] = toolPos(c.i, c.f), no = P.TL[ii];
  if (S.activeTool !== no) { const a = toolGroups.get(S.activeTool); if (a) a.visible = false; S.activeTool = no; }
  const g = toolGroups.get(no); if (!g) return;
  g.visible = true;
  // Worldize: toolPos() returns raw LOCAL coordinates in the move's own plane frame. For plane 0
  // (every single-plane job, always) this is a no-op - identity matrix, zero origin - so this is
  // unconditional, not gated on S.triDexel: correctly covers tilted-plane tri-dexel moves AND the
  // oblique-plane fallback (TILT_ROOT) for free, with zero behavior change for the common case.
  const pl = P.planes[P.PL[ii]], m = pl.matrix;
  const wx = pl.origin[0] + m[0][0] * x + m[0][1] * y + m[0][2] * z;
  const wy = pl.origin[1] + m[1][0] * x + m[1][1] * y + m[1][2] * z;
  const wz = pl.origin[2] + m[2][0] * x + m[2][1] * y + m[2][2] * z;
  if (g.position.x !== wx || g.position.y !== wy || g.position.z !== wz || S.toolShown !== no) {
    g.position.set(wx, wy, wz); g.quaternion.copy(planeQuaternion(m)); S.toolShown = no; invalidate();
  }
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
  // base-plane moves only: a tilted plane's moves are in its own local frame, not the stock box's
  for (let i = 0; i < P.n; i++) if (P.K[i] && !(P.PL && P.PL[i])) {
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
// ask the stock field which grid (or oblique plane) defines the surface at the hit point and read
// that cell's op[] - works for any surface angle now that the mesh is smooth, not just the
// axis-aligned cube faces the old face-normal lookup relied on.
function pickAtTri(cx, cy) {
  if (!S.td || !S.ready) return;
  const mesh = TRI_ROOT.children[0];
  if (!mesh) return hideProbe();
  const r = cv.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (!hits.length || !hits[0].face) return hideProbe();
  const hit = hits[0], x = hit.point.x, y = hit.point.y, z = hit.point.z;
  // The grid that defines the surface at this point is the one the field reads there, so its own
  // cell's op[] says which operation last cut it; the finished-program field says what comes next.
  const live = S.triMesh ? S.triMesh.field.op(x, y, z) : 0;
  const fin = S.finalField ? S.finalField.op(x, y, z) : 0;
  const left = S.finalField ? -S.finalField.value(x, y, z) : 0;
  showProbeTri(live, fin, left, [x, y, z], cx - r.left, cy - r.top);
}
function showProbeTri(live, fin, left, p, px, py) {
  const P = S.prog, box = $('probe');
  const oname = k => `T${P.ops[k].tool}, ${esc(P.ops[k].label)}`;
  let head, body = '', btn = '', opk = -1;
  if (live) { opk = live - 1; head = 'Machined by ' + oname(opk); body = left > 0.02 ? `${left.toFixed(2)} mm of material still to come off here.` : 'At its final depth for this program.'; btn = 'Replay this operation'; }
  else if (fin) { opk = fin - 1; head = 'Not cut yet'; body = 'Will be machined by ' + oname(opk) + '.'; btn = 'Jump to that operation'; }
  else { head = 'Original stock surface'; body = 'This program never touches this spot.'; }
  box.innerHTML = `<h3>${head}</h3><p>${body}<br>X ${p[0].toFixed(2)}  Y ${p[1].toFixed(2)}  Z ${p[2].toFixed(2)}</p><div class="row">${btn ? '<button class="btn primary" id="probeGo" type="button">' + btn + '</button>' : ''}<button class="btn" id="probeX" type="button">Close</button></div>`;
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
function showBusy(txt, frac) {
  if (S.quietBusy) { $('liveBusy').hidden = false; return; }
  $('busy').hidden = false; setText($('busyTxt'), txt); $('busyBar').style.width = Math.round(clamp(frac, 0, 1) * 100) + '%';
}
function hideBusy() { $('busy').hidden = true; $('liveBusy').hidden = true; }
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
    if (!P.n) { toast(opts.live ? 'The edited code has no tool moves, so the sim still shows the last version that did.' : 'No tool motion found in that file. Is it a G-code program?'); return; }
    const csv = opts.csv || null, lib = opts.lib || null, setup = opts.setup || null, info = [];
    if (csv) { const n = NC.applyCsvTools(P.tools, csv); info.push(`Setup sheet: ${n} tool${n === 1 ? '' : 's'} sized from it.`); }
    if (opts.tools) for (const o of opts.tools) { const t = P.tools.find(x => x.no === o.no); if (t) { Object.assign(t, o); t.defaulted = false; NC.completeTool(t); } }
    if (lib) { const n = NC.applyLibrary(lib, P.tools); info.push(`Tool library: matched ${n} of ${P.tools.length} tools, holders included.`); }
    if (opts.cimcoTools) { const n = NC.applyCimcoTools(opts.cimcoTools, P.tools); info.push(`Setup file: matched ${n} of ${P.tools.length} tools, holders included.`); }
    const opsList = opts.ops || (csv && csv.ops) || null, extraWarn = [];
    if (opsList) {
      const same = opsList.length === P.ops.length && opsList.every((o, i) => o.tool === P.ops[i].tool);
      // seq: the setup sheet's own sequence number for the op (30, 30.1, 30.2...), shown in the list;
      // the Restart seq # box keeps the tool change's N (seqN).
      if (same) P.ops.forEach((o, i) => { if (opsList[i].label) o.label = opsList[i].label; if (opsList[i].dim) o.dim = opsList[i].dim; if (opsList[i].seq) o.seq = String(opsList[i].seq).trim(); });
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
    // The .setup file's tool/holder data is kept so a reload of the same program (edited G-code,
    // units change) re-applies it - dropping it put every holder back to the default shape.
    S.cimcoTools = opts.cimcoTools || null; S.cimcoWarn = opts.cimcoWarn || [];
    // The real finished-part mesh from the .setup file, when one was loaded - parsed and
    // kept here for a future true deviation-colouring feature, not rendered by anything yet.
    S.partMesh = opts.partMesh || null;
    // The .setup's STOCK.stl when it is a real shape (a 2nd op's leftover stock), not just a box.
    S.stockMesh = opts.stockMesh || null;
    if (!opts.live) S.origText = String(text).replace(/\r/g, '');   // what "Undo all edits" goes back to
    setCodeText(text, opts.live);
    S.prog = P; S.name = name; S.tools = P.tools; S.toolsDirty = false;
    setText($('fname'), name + (opts.exported ? '   exported ' + opts.exported.slice(0, 16).replace('T', ' ') : ''));
    // A live edit keeps the stock box it already had - re-guessing it from the edited moves would
    // make the block jump around while typing.
    if (opts.live && S.stock) { /* keep */ } else if (opts.stock) S.stock = Object.assign({}, opts.stock); else if (setup && setup.stock) S.stock = stockFromSetup(setup.stock); else autoStock();
    fillStockInputs(); buildToolCards(); buildOps(); buildTicks(); buildPaths();
    if (setup) info.push(`Setup file "${setup.setup || 'setup'}": ${setup.stock ? 'stock box from Fusion' : 'no stock box, using a guess'}, ${(setup.fixtures || []).length} workholding part${(setup.fixtures || []).length === 1 ? '' : 's'}.`);
    if (S.stockMesh && !chainSeed) info.push('Starting stock: the shape in the setup file (what the previous op left), seen from above.');
    if (opts.exported) info.push('Job file exported ' + opts.exported.replace('T', ' ') + (opts.document ? ' from "' + opts.document + '"' : '') + '.');
    if (setup && setup.stockMode === 7) {
      if (chainSeed) info.push(`Stock seeded from the previous setup's finished result ("${chainSeed.fromName}").`);
      else extraWarn.push(`This setup uses "from previous setup" stock, but no other setup's simulated result is available this session - using a flat block guess instead. Load the previous setup first, then this one, to chain them.`);
    }
    const usedTools = new Set(P.TL);
    // Undercut tools cut for real now; say so only where their shape had to be guessed.
    const guessed = P.tools.filter(t => t.undercut && usedTools.has(t.no) && (t.neckGuess || t.headGuess));
    for (const t of guessed) {
      const what = [t.neckGuess ? `neck assumed ${Math.round(t.neckD / t.D * 100)}% of the ${+t.D.toFixed(2)} mm cutter` : '', t.headGuess ? `cutting height assumed ${+t.headH.toFixed(2)} mm` : ''].filter(Boolean).join(', ');
      extraWarn.push(`T${t.no} (${t.ucType === 'lollipop' ? 'lollipop' : t.ucType === 'dovetail' ? 'dovetail' : 'T-slot'}): the posted files don't give its full shape, so ${what}. How far it undercuts is approximate - post with CSV_Cascade_Post v2.7.2 or later for the real shape.`);
    }
    if (opts.cimcoWarn && opts.cimcoWarn.length) extraWarn.push(...opts.cimcoWarn);
    const lines = info.concat(P.notes), warnList = P.warnings.concat(extraWarn, checkSetup(P, S.stock, setup, !!chainSeed));
    $('warns').innerHTML = lines.map(esc).join('<br>') + (warnList.length ? (lines.length ? '<br>' : '') + '<b>Heads up</b><br>' + warnList.map(esc).join('<br>') : '');
    $('notesDot').hidden = !warnList.length;   // the Notes menu lights up when there is a real warning
    S.quietBusy = !!opts.live;   // a live edit shows a small "updating" tag, not the full-screen cover
    try { await rebuild(!opts.live); } finally { S.quietBusy = false; }
    if (S.stockMesh && !chainSeed && S.triDexel) { $('warns').innerHTML += (warnList.length ? '<br>' : '<br><b>Heads up</b><br>') + esc('This program uses tilted planes or an undercut tool, so the starting stock is drawn as a plain block, not the shape in the setup file.'); $('notesDot').hidden = false; }
    if (chainSeed && S.chainCoverage != null && S.chainCoverage < 0.05) {
      $('warns').innerHTML += (warnList.length || lines.length ? '<br>' : '<b>Heads up</b><br>') +
        `The chained stock from "${chainSeed.fromName}" barely overlaps this setup's stock box (${Math.round(S.chainCoverage * 100)}% covered) - the two setups' WCS placements may not line up, or this pairing may be wrong.`;
      $('notesDot').hidden = false;
    }
  } catch (err) { console.error(err); hideBusy(); toast('Could not read that program: ' + err.message); }
}
// Accepts any mix of: G-code program, setup-sheet CSV, Fusion .tools / tool-library JSON, job
// bundle JSON, or a CIMCO scanning cascading post's .setup + STOCK/PART/FIXTURE STL files.
async function handleFiles(files) {
  exitCodeEdit();   // loading anything new always drops out of an in-progress G-code edit
  const b = { text: null, name: '', csv: null, lib: null, bundle: null, setup: null, job: null, cimcoSetupText: null, cimcoStockBuf: null, cimcoPartBuf: null, cimcoFixtureBuf: null };
  for (const f of files) {
    try {
      const n = f.name;
      if (/\.tools$/i.test(n)) b.lib = JSON.parse(await NC.unzipText(await readBuf(f)));
      else if (/\.csv$/i.test(n)) { b.csv = NC.parseSetupCsv(await readFile(f)); if (!b.csv) toast(n + ' does not look like a setup sheet, so it was skipped.'); }
      else if (/\.setup$/i.test(n)) b.cimcoSetupText = await readFile(f);
      else if (/_STOCK\.stl$/i.test(n)) b.cimcoStockBuf = await readBuf(f);
      else if (/_PART\.stl$/i.test(n)) b.cimcoPartBuf = await readBuf(f);
      else if (/_FIXTURE\.stl$/i.test(n)) b.cimcoFixtureBuf = await readBuf(f);
      else if (/\.stl$/i.test(n)) { /* an STL with no recognized STOCK/PART/FIXTURE suffix - not part of this format, skip quietly */ }
      else {
        const text = await readFile(f);
        if (/\.json$/i.test(n) || /^\s*[\[{]/.test(text.slice(0, 20))) { const j = JSON.parse(text); if (j && j.format === 'floorsim-job') b.job = j; else if (j && typeof j.gcode === 'string') b.bundle = j; else if (j && j.format === 'floorsim-setup') b.setup = j; else b.lib = j; }
        else { b.text = text; b.name = n; }
      }
    } catch (err) { console.error(err); toast('Could not open ' + f.name + ': ' + err.message); }
  }
  let cimcoTools = null, partMesh = null, stockMesh = null, cimcoWarn = [];
  if (b.cimcoSetupText) {
    try {
      const parsed = NC.parseCimcoSetup(b.cimcoSetupText);
      const meshes = {};
      if (b.cimcoStockBuf) meshes.stock = NC.parseStlBinary(b.cimcoStockBuf);
      if (b.cimcoPartBuf) meshes.part = NC.parseStlBinary(b.cimcoPartBuf);
      if (b.cimcoFixtureBuf) meshes.fixture = NC.parseStlBinary(b.cimcoFixtureBuf);
      const programName = b.name ? b.name.replace(/\.nc$/i, '') : (b.job ? b.job.program : 'Job');
      const result = NC.cimcoToFloorsimSetup(parsed, meshes, programName);
      if (!b.setup) b.setup = result.setup;   // a JSON floorsim-setup file, if also present, wins - simple, documented default
      cimcoTools = parsed.tools.length ? parsed : null;
      partMesh = result.partMesh; stockMesh = result.stockMesh;
      cimcoWarn = result.warnings;
    } catch (err) { console.error(err); toast('Could not read the .setup/STL files: ' + err.message); }
  }
  const cimcoOpts = { cimcoTools, partMesh, stockMesh, cimcoWarn };
  // Adding just a CSV/tool library to the program already on screen keeps its setup-file data.
  const keptOpts = cimcoTools ? cimcoOpts : { cimcoTools: S.cimcoTools, partMesh: S.partMesh, stockMesh: S.stockMesh, cimcoWarn: S.cimcoWarn };
  if (b.job) return loadText(b.job.gcode, b.job.program || 'Job', Object.assign({ setup: b.job, lib: b.job.toolLibrary, ops: b.job.ops, exported: b.job.exported, document: b.job.document }, cimcoOpts));
  if (b.bundle) return loadText(b.bundle.gcode, b.bundle.name || 'Job bundle', Object.assign({ stock: b.bundle.stock, tools: b.bundle.tools, csv: b.csv, lib: b.lib, setup: b.setup }, cimcoOpts));
  if (b.text) return loadText(b.text, b.name, Object.assign({ csv: b.csv, lib: b.lib, setup: b.setup }, cimcoOpts));
  if ((b.csv || b.lib || b.setup || cimcoTools) && S.text) return loadText(S.text, S.name, Object.assign({ csv: b.csv || S.csv, lib: b.lib || S.lib, setup: b.setup || S.setup, ops: S.opsList, exported: S.exported, document: S.docName }, keptOpts));
  if (b.csv || b.lib || b.setup || cimcoTools) toast('Open the program (.NC) first, or select it together with the CSV, .tools and setup files.');
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
  if (/\.setup$/i.test(name)) return { kind: 'setup', program: name.replace(/\.setup$/i, '') };
  if (/_STOCK\.stl$/i.test(name)) return { kind: 'stock', program: name.replace(/_STOCK\.stl$/i, '') };
  if (/_PART\.stl$/i.test(name)) return { kind: 'part', program: name.replace(/_PART\.stl$/i, '') };
  if (/_FIXTURE\.stl$/i.test(name)) return { kind: 'fixture', program: name.replace(/_FIXTURE\.stl$/i, '') };
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

/* ---------- Load by program number from a remembered folder ----------
   A web page can't open a folder by its path, so the folder is picked once (File System Access
   API) and its handle is kept in IndexedDB - it stays the folder until "Folder:" is used to pick
   another. Chrome may ask once per session to allow reading it again (that needs a click, so a
   link can't silently do it). ?program=O1138 in the page link fills the box and loads it - the
   hook for the planned ProShop button. Browsers without the API keep the old "Open job folder". */
const FS_OK = typeof window.showDirectoryPicker === 'function';
function idb(mode, fn) {
  return new Promise((res, rej) => {
    if (!window.indexedDB) { res(undefined); return; }
    const rq = indexedDB.open('apw-floorsim', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => {
      const db = rq.result, tx = db.transaction('kv', mode), r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); res(r && r.result); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    };
  });
}
const idbGet = k => idb('readonly', st => st.get(k));
const idbSet = (k, v) => idb('readwrite', st => st.put(v, k));
function showFolderName() { setText($('folderName'), S.folder ? S.folder.name : 'not set'); }
async function setFolder() {
  const h = await window.showDirectoryPicker({ id: 'apw-floorsim-jobs', mode: 'read' });
  S.folder = h; showFolderName();
  try { await idbSet('folder', h); } catch (e) { console.error(e); toast('Folder picked, but this browser could not remember it for next time.'); }
  return h;
}
async function folderReadable(h, ask) {
  if (!h.queryPermission) return true;
  const o = { mode: 'read' };
  if ((await h.queryPermission(o)) === 'granted') return true;
  return ask ? (await h.requestPermission(o)) === 'granted' : false;
}
const normProgram = s => { s = String(s || '').trim().toUpperCase(); return /^\d+$/.test(s) ? 'O' + s : s; };
async function loadProgram(raw, ask) {
  const prog = normProgram(raw);
  if (!prog) { toast('Type a program number, for example O1138.'); $('progNo').focus(); return false; }
  $('progNo').value = prog;
  if (!S.folder) {
    if (!ask) return false;
    try { await setFolder(); } catch (err) { if (err && err.name !== 'AbortError') toast('Could not open that folder: ' + err.message); return false; }
  }
  if (!(await folderReadable(S.folder, ask))) { toast(`Click Load to allow reading the "${S.folder.name}" folder.`); return false; }
  const files = [];
  try {
    for await (const h of S.folder.values()) {
      if (h.kind !== 'file') continue;
      const c = classifyFolderFile(h.name);
      if (c && c.program.toUpperCase() === prog) files.push(await h.getFile());
    }
  } catch (err) { console.error(err); toast('Could not read the folder: ' + err.message); return false; }
  if (!files.some(f => /\.nc$/i.test(f.name))) { toast(`No ${prog}.NC in the "${S.folder.name}" folder.`); return false; }
  await handleFiles(files);
  return true;
}
async function startupFolder() {
  if (!FS_OK) return;
  $('progForm').hidden = false; $('folderFallback').hidden = true;
  try { const h = await idbGet('folder'); if (h) { S.folder = h; showFolderName(); } } catch (e) { console.error(e); }
  const q = new URLSearchParams(location.search).get('program');
  if (q) { $('progNo').value = normProgram(q); loadProgram(q, false); }
}

// Restore one snapshot's full state: every plane's HeightSim, plus every tri-dexel signed grid.
// Both are plain HeightSims, so both use the same snapshot()/restore() pair - the tri-dexel grids
// have to come back in lockstep with the per-plane ones or a scrub would show the stock at one
// point in the program and the oblique plane at another.
function restoreSnap(snap) {
  if (!snap) return;
  for (const [id, sim] of S.sims) sim.restore(snap.state.get(id));
  // On a tri-dexel job, TRI_ROOT's fused mesh now ANDs in every oblique plane's own HeightSim
  // (see refreshTriStock) - a scrub/restore that only touched S.sims (no td.grids change, e.g. a
  // job whose tri-dexel grids happen to be untouched by this snapshot) must still mark it dirty,
  // or the fused mesh would silently keep showing a stale oblique-plane shape after the restore.
  if (S.triDexel) S.triDirty = true;
  if (S.td && snap.td) { for (const [key, grid] of S.td.grids) grid.restore(snap.td.get(key)); }
}

// Colours for the smooth tilted-job surface, same convention as the flat-job one: blue where
// material is still to come off, green once it's at final size, fading over 0.06mm; or each spot
// in the colour of the tool that last cut it. "Still to come off" is the current field minus the
// finished one AT THE SAME POINT, so a vertex sitting a hair off the surface can't read as stock.
function triColours(m) {
  const p = m.pos, n = p.length, col = new Float32Array(n), prog = S.mode === 'progress', P = S.prog;
  for (let q = 0; q < n; q += 3) {
    let c;
    if (prog) {
      const t = S.finalField ? clamp((m.field.value(p[q], p[q + 1], p[q + 2]) - S.finalField.value(p[q], p[q + 1], p[q + 2])) / 0.06, 0, 1) : 1;
      col[q] = GREEN[0] + (BLUE[0] - GREEN[0]) * t; col[q + 1] = GREEN[1] + (BLUE[1] - GREEN[1]) * t; col[q + 2] = GREEN[2] + (BLUE[2] - GREEN[2]) * t;
      continue;
    }
    const o = m.field.op(p[q], p[q + 1], p[q + 2]);
    c = o ? TOOL_RGB.get(P.ops[o - 1].tool) || NEUTRAL : NEUTRAL;
    col[q] = c[0]; col[q + 1] = c[1]; col[q + 2] = c[2];
  }
  return col;
}

// Re-extract TRI_ROOT's visible surface from the CURRENT (partially cut) grid state.
// live=true during playback: the cheaper target, throttled, so removal is visible without eating
// the frame budget. live=false once settled (paused, scrubbed, finished, or freshly rebuilt):
// the full-quality target, since there's no frame budget left to protect at that point.
function refreshTriStock(live) {
  if (!S.triDexel || !S.td) return;
  const now = performance.now();
  if (live && now - S.triFuseAt < TRI_FUSE_MIN_MS) return;   // throttle: cap live re-fuse rate
  if (!S.triDirty && S.triFuseLive === live) return;          // nothing changed and same quality
  // S.sims here holds exactly the oblique fallback plane(s) (see rebuild()) - ANDed into the same
  // smooth surface instead of being drawn as their own separate TILT_ROOT slabs.
  const m = NC.meshTriDexelSmooth(S.td, live ? TRI_FUSE_LIVE : TRI_FUSE_TARGET, S.sims, S.planeById);
  const col = triColours(m);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
  const old = TRI_ROOT.children.find(c => c.isMesh);
  if (old) { old.geometry.dispose(); old.geometry = geo; }
  else {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; TRI_ROOT.add(mesh);
  }
  S.triMesh = m;
  S.triFuseAt = now; S.triDirty = false; S.triFuseLive = live;
  invalidate();
}

// sims: Map<planeId, HeightSim>, one per plane actually used (buildPlaneSims) - on a tri-dexel
// job this is restricted to the oblique fallback plane(s) only (see rebuild()). Snapshots now
// hold every plane's state together (state: Map<planeId, {h,op}>) so scrubbing restores all
// planes in lockstep off the one shared program timeline.
// td: NC.buildTriDexel's result, or null. Its grids are cut AND snapshotted here exactly like the
// per-plane sims, so playback/scrubbing can show the stock part-way through being cut instead of
// only its finished shape (which is what a one-time post-prepass fuse used to give).
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
  } else if (S.stockMesh && sims.has(0) && !td) {
    // Start from the setup file's own stock shape (seen from above - see seedHeightSim).
    NC.seedHeightSim(sims.get(0), S.stockMesh.pos, S.stockMesh.idx, true);
  }
  // Tri-dexel's grids count toward the same fixed snapshot memory budget - on the real O1224 job
  // they are the bulk of it (5 signed grids, ~3MB per snapshot all told), so leaving them out
  // would silently overshoot it by several times over.
  let bytes = 0; for (const sim of sims.values()) bytes += sim.nx * sim.ny * 6;
  if (td) for (const grid of td.grids.values()) bytes += grid.nx * grid.ny * 6;
  const maxSnaps = clamp(Math.floor(90e6 / Math.max(1, bytes)), 6, 60), every = Math.max(64, Math.ceil(n / maxSnaps));
  const snaps = [], t0 = performance.now(); let last = t0;
  for (let i = 0; i < n; i++) {
    if (i % every === 0) {
      const state = new Map(); for (const [id, sim] of sims) state.set(id, sim.snapshot());
      let tdState = null;
      if (td) { tdState = new Map(); for (const [key, grid] of td.grids) tdState.set(key, grid.snapshot()); }
      snaps.push({ i, state, td: tdState });
    }
    NC.cutMoveMulti(sims, P, S.simTools, i, 0, 1);
    if (td) NC.cutTriDexelMove(td, P, S.simTools, i, 0, 1);
    if ((i & 15) === 15) {
      const now = performance.now();
      if (now - last > 30) { showBusy(td ? 'Simulating the whole program (tri-dexel)' : 'Simulating the whole program', i / n); await new Promise(r => setTimeout(r, 0)); if (token !== S.token) return null; last = performance.now(); }
    }
  }
  const finals = new Map(); for (const [id, sim] of sims) finals.set(id, sim.snapshot());
  const tdFinals = new Map(); if (td) for (const [key, grid] of td.grids) tdFinals.set(key, grid.snapshot());
  return { snaps, finals, tdFinals, ms: performance.now() - t0 };
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
  const cls = NC.classifyPlanes(S.prog.planes, TRI_DEXEL_TOL_DEG);
  // An undercut tool leaves pockets under the surface, which the flat-job height-field mesh can't
  // draw - such a job takes the smooth-surface path even when it only uses the base plane.
  const usedTools = new Set(S.prog.TL);
  S.triDexel = cls.alignedIds.size > 1 || S.tools.some(t => t.undercut && usedTools.has(t.no));
  // Same condition loadText() uses to pick stockFromSetup over autoStock() - reused here, not a
  // new flag. A tilted plane's own box (boxFromMoves) still needs padding around its moves when
  // there's no real stock box to bound it (we're guessing). But when a real box IS known, the
  // default 5mm pad visibly overshoots it: padding is applied in the plane's own tilted local
  // frame, and a steep tilt (e.g. O1224's real ~80deg oblique plane) projects that 5mm into a
  // much larger displacement along a world axis (measured: pad 5 -> 5.8mm past the real box's
  // wall in world X; pad 0 lands within 0.01mm of the real wall). John spotted the resulting
  // phantom block sticking out the side of a real job on 2026-09-22 - the real stock box used to
  // be an oversized guess that hid this; now that it's tight and accurate, the overshoot shows.
  // 0.5mm, not 0: a plane whose real moves happen to have zero extent in one local axis (e.g. a
  // single fixed-XY tapping cycle) would otherwise get a zero-width box and a NaN-sized grid
  // (HeightSim's nx/ny come from dividing by that width) - see boxFromMoves/HeightSim.
  const hasRealStock = !!(S.setup && S.setup.stock);
  const tiltPad = hasRealStock ? 0.5 : 5;
  if (S.triDexel) {
    // Prefer the real stock box when one was actually loaded - a real box is authoritative and
    // far tighter than deriving one from where moves happen to go.
    S.td = NC.buildTriDexel(S.prog, S.res, 5, hasRealStock ? stockBox : undefined, TRI_DEXEL_TOL_DEG);
    // Oblique planes (e.g. a real, non-90-degree G68.2 tilt) can't join the shared tri-dexel
    // frame - see docs/plan - so they still get their own HeightSim via the ordinary, unmodified
    // buildPlaneSims/cutMoveMulti path, restricted to just that subset via the new onlyIds param.
    // cls uses the SAME TRI_DEXEL_TOL_DEG as buildTriDexel just above, so this stays exactly the
    // complement of td's own aligned set - a mismatch here would double-cut a plane into both
    // representations and draw it twice (once fused, once as its own separate slab below).
    S.sims = NC.buildPlaneSims(S.prog, stockBox, S.res, tiltPad, cls.obliqueIds);
  } else {
    S.td = null;
    S.sims = NC.buildPlaneSims(S.prog, stockBox, S.res, tiltPad);
  }
  S.sim = S.sims.get(0);   // undefined on the tri-dexel path - plane 0 is always aligned, never in this map
  let r;
  try { r = await prepass(token, S.sims, S.td); } catch (err) { console.error(err); hideBusy(); toast('Simulation failed: ' + err.message); return; }
  if (!r || token !== S.token) return;
  S.snaps = r.snaps;
  const fin0 = r.finals.get(0);
  S.finalH = fin0 ? fin0.h : null; S.finalOp = fin0 ? fin0.op : null;   // null on the tri-dexel path - no working probe there yet (Phase 3)
  // The finished program as a field (same grids, end-of-program heights) - the smooth tilted-job
  // surface is coloured by how far each point still is from it, like the flat-job surface is.
  S.planeById = new Map(S.prog.planes.map(p => [p.id, p]));
  if (S.td) {
    const fin = new Map(r.tdFinals); for (const [id, v] of r.finals) fin.set('p' + id, v);
    S.finalField = NC.stockField(S.td, S.sims, S.planeById, fin);
  } else S.finalField = null;
  // Grid-resolution chip: on a tri-dexel job there's no single S.sim to report, so use whichever
  // signed grid happens to be first - purely informational (all grids target the same ~S.res
  // density), not something anything else depends on.
  const statSim = S.sim || (S.td && S.td.grids.size ? S.td.grids.values().next().value : null);
  S.stats = { ms: r.ms, moves: S.prog.n, nx: statSim ? statSim.nx : 0, ny: statSim ? statSim.ny : 0, dx: statSim ? statSim.dx : 0 };

  // one mesh-holder per plane: STOCK itself for the base plane (same object every rebuild, as
  // always), a fresh one per tilted plane positioned/rotated by that plane's own transform. On a
  // tri-dexel job S.sims only has the oblique fallback plane(s), so this loop naturally builds
  // only those. Each one's OWN HeightSim (sim/S.planes) still gets built and kept up to date -
  // worldPlaneBounds(), the chain-seed export, and the probe all still read it directly - but on a
  // tri-dexel job its visible group is hidden below: TRI_ROOT's single fused mesh (buildTriDexel +
  // fuseTriDexel, now ANDing every oblique plane's HeightSim in via obliquePlaneSolid) already
  // covers the same material, in the same world frame, watertight against the aligned planes -
  // showing both would double-draw it. See spike/NOTES3.md and spike/fusedpipeline.js for the
  // investigation that made this safe (the oblique clipping fix).
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
      stock.group.visible = !S.triDexel;   // TRI_ROOT's fused mesh already covers this plane's material
      TILT_ROOT.add(stock.group);
    }
    const sim = S.sims.get(pl.id), fin = r.finals.get(pl.id);
    buildStock(sim, stock, fin.h);
    S.planes.set(pl.id, { sim, stock, finalH: fin.h, finalOp: fin.op });
  }
  STOCK.group.visible = !S.triDexel;   // TRI_ROOT covers plane 0's contribution on the tri-dexel path

  buildToolGroups(); buildFixtures();
  restoreSnap(S.snaps[0]);
  S.cur = { i: 0, f: 0 }; S.tau = 0; S.curOp = -1; S.hudLine = -1; S.hudTool = -1;
  for (const pl of S.planes.values()) refreshStock(pl.sim, pl.stock, true);
  // Fuse the RESTORED (snapshot 0 = uncut) state, not prepass's finished one - the stock has to
  // start whole and visibly get cut away, same as the per-plane path has always behaved.
  S.triDirty = true; refreshTriStock(false);
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
      if (S.td) { NC.cutTriDexelMove(S.td, P, S.simTools, i, f, 1); S.triDirty = true; }
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
      if (nf > f) {
        NC.cutMoveMulti(S.sims, P, S.simTools, i, f, nf);
        if (S.td) { NC.cutTriDexelMove(S.td, P, S.simTools, i, f, nf); S.triDirty = true; }
        f = nf;
      }
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
    restoreSnap(snap);
    S.cur = { i: snap.i, f: 0 }; S.tau = snap.i > 0 ? P.cumT[snap.i - 1] : 0;
  }
  advance(tau, 220);
  if (S.tau < tau - 1e-6 && S.cur.i < P.n) S.pendingSeek = tau;
}
const opStart = k => { const P = S.prog, m = P.ops[k].move; return m > 0 ? P.cumT[m - 1] : 0; };
// Any navigation other than stepping by line hands the G-code panel back to following the sim.
function clearLineSel() { S.selLine = null; S.selMove = -1; S.codeFree = false; }
function goToOp(k) { if (!S.ready) return; clearLineSel(); S.pendingSeek = opStart(clamp(k, 0, S.prog.ops.length - 1)); S.playing = false; updatePlay(); }
function togglePlay() {
  if (!S.ready) return;
  if (!S.playing && S.tau >= S.prog.total - 1e-6) S.pendingSeek = 0;
  S.playing = !S.playing; updatePlay();
  if (S.playing) clearLineSel();
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
  if (t.undercut) return P(hp, '#505a65') + P(cutterProfile(t).concat([[0, t.stick]]), toolHex(t.no));
  return P(hp, '#505a65') + P([[0, t.flute], [t.D / 2, t.flute], [t.D / 2, t.stick], [0, t.stick]], '#aab4bf') + P(cutterProfile(t).concat([[0, t.flute]]), toolHex(t.no));
}
function coolText(c) { const a = []; if (c & 1) a.push('Flood'); if (c & 2) a.push('Mist'); if (c & 4) a.push('Thru-spindle'); return a.length ? a.join(' + ') : 'Off'; }
let lastHud = 0;
function updateHud(force) {
  const P = S.prog; if (!P || !P.n) return;
  const now = performance.now(); if (!force && now - lastHud < 90) return; lastHud = now;
  const c = dispCur(), [x, y, z, i] = toolPos(c.i, c.f), no = P.TL[i], t = S.tools.find(q => q.no === no);
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
  // The N on this op's tool-change (G100) line - where an operator restarts the machine for it.
  if (op && op.seqN != null) { $('restartBox').hidden = false; setText($('restartN'), op.seqN); } else $('restartBox').hidden = true;
  setText($('pX'), x.toFixed(3)); setText($('pY'), y.toFixed(3)); setText($('pZ'), z.toFixed(3));
  setText($('timeTxt'), mmss(S.tau) + ' / ' + mmss(P.total));
  if (!S.scrubbing) $('scrub').value = P.total > 0 ? Math.round(S.tau / P.total * 10000) : 0;
  const ln = S.selLine != null ? S.selLine : P.LN[i];
  if (ln !== S.hudLine) renderCode(ln, !S.codeFree);
}
// Where to draw the tool/HUD from. After stepping to a line, the sim sits at the START of the next
// move (the same point as the end of the last move on that line) - show it as the end of that
// last move, so a tool change or new op on the next line doesn't appear one step early.
function dispCur() {
  const c = S.cur;
  if (S.selLine != null && S.selMove >= 0 && c.i === S.selMove + 1 && c.f === 0) return { i: S.selMove, f: 1 };
  return c;
}

/* ---------- G-code panel ----------
   One textarea holds the whole program and is always editable - click and type, no Edit button.
   While the text is unchanged it doubles as the line-by-line stepper: click a line to jump the sim
   there, mouse wheel / arrow keys / the two buttons step one line, dragging the scrollbar moves to
   the line in the middle. Once edited, it behaves as a plain text box until "Run edited code"
   (nothing is saved - reverts on reload) or "Undo edits". The line numbers and the current-line
   band are drawn beside/under it, so the line height is fixed (must match style.css). */
const CODE_LH = 20, CODE_PADT = 6;
const codeTa = $('code');
let codeStarts = new Int32Array([0]), codeNorm = '', codeAutoTop = -1, codeLastTop = 0, codeWheelAcc = 0;
// live: the text came from the box itself, so leave the box alone (caret, scroll, and anything
// typed since) - just line the numbers up with the version now simulated.
function setCodeText(text, live) {
  codeNorm = String(text).replace(/\r/g, '');   // same line split as the parser, so line numbers agree
  if (!live) codeTa.value = codeNorm;
  const st = [0]; for (let k = codeNorm.indexOf('\n'); k >= 0; k = codeNorm.indexOf('\n', k + 1)) st.push(k + 1);
  codeStarts = Int32Array.from(st);
  // codeFree while live: the re-run starts at move 0, and following it would scroll the box away
  // from the line being edited.
  S.selLine = null; S.selMove = -1; S.hudLine = -1; S.codeFree = !!live;
  setCodeDirty(codeTa.value !== codeNorm);
}
function codeLineOf(pos) {
  let lo = 0, hi = codeStarts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (codeStarts[m] <= pos) lo = m; else hi = m - 1; }
  return lo + 1;
}
function setCodeDirty(d) {
  S.codeDirty = d; $('codeWrap').classList.toggle('dirty', d);
  updateEditRow(); paintCode();
}
function paintCode() {
  const top = codeTa.scrollTop, h = codeTa.clientHeight || 250, cur = S.hudLine;
  const first = Math.max(1, Math.floor((top - CODE_PADT) / CODE_LH) + 1), last = Math.min(codeStarts.length, first + Math.ceil(h / CODE_LH) + 1);
  let g = `<div style="height:0;margin-top:${CODE_PADT + (first - 1) * CODE_LH - top}px"></div>`;
  for (let k = first; k <= last; k++) g += `<div${k === cur && !S.codeDirty ? ' class="cur"' : ''}>${k}</div>`;
  $('codeGutter').innerHTML = g;
  const hl = $('codeHl'), y = CODE_PADT + (cur - 1) * CODE_LH - top;
  hl.hidden = S.codeDirty || cur < 1 || y < -CODE_LH || y > h;
  hl.style.top = y + 'px';
}
function renderCode(ln, centre) {
  S.hudLine = ln;
  if (centre && !S.codeDirty) {
    codeTa.scrollTop = Math.max(0, CODE_PADT + (ln - 1) * CODE_LH - ((codeTa.clientHeight || 250) - CODE_LH) / 2);
    codeAutoTop = codeTa.scrollTop;
  }
  paintCode();
}
// Index of the last move whose source line is at or before L (-1 if none) - P.LN never decreases.
function lineMove(L) {
  const LN = S.prog.LN; let lo = 0, hi = S.prog.n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (LN[m] <= L) lo = m + 1; else hi = m; }
  return lo - 1;
}
// Put the sim at the end of line L: everything on and before it has run, nothing after it.
function goToLine(L, centre) {
  if (!S.ready || !S.prog) return;
  L = clamp(Math.round(L), 1, codeStarts.length);
  S.playing = false; updatePlay();
  const k = lineMove(L);
  S.selLine = L; S.selMove = k; S.codeFree = !centre;
  S.pendingSeek = k >= 0 ? S.prog.cumT[k] : 0;
  renderCode(L, centre);
}
function stepLine(d) {
  if (!S.ready || S.codeDirty) return;
  const from = S.selLine != null ? S.selLine : Math.max(1, S.hudLine);
  goToLine(from + d, true);
  if (document.activeElement === codeTa) { const p = codeStarts[S.selLine - 1]; codeTa.setSelectionRange(p, p); }
}
codeTa.addEventListener('scroll', () => {
  const top = codeTa.scrollTop, auto = Math.abs(top - codeAutoTop) < 1, moved = top !== codeLastTop;
  codeAutoTop = -1; codeLastTop = top;
  paintCode();
  if (auto || !moved || S.codeDirty || !S.ready) return;
  // Dragged or swiped by hand: the line in the middle of the box becomes the current line.
  goToLine(Math.floor((top + (codeTa.clientHeight || 250) / 2 - CODE_PADT) / CODE_LH) + 1, false);
});
codeTa.addEventListener('wheel', e => {
  if (S.codeDirty || !S.ready) return;   // while editing, the wheel just scrolls the text
  e.preventDefault();
  const d = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  codeWheelAcc = Math.abs(d) >= 40 ? d : codeWheelAcc + d;   // one mouse notch = exactly one line; trackpads accumulate
  if (Math.abs(codeWheelAcc) >= 40) { const s = Math.sign(codeWheelAcc); codeWheelAcc = 0; stepLine(s); }
}, { passive: false });
codeTa.addEventListener('keydown', e => {
  if (S.codeDirty || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepLine(e.key === 'ArrowDown' ? 1 : -1); }
});
codeTa.addEventListener('click', () => {
  if (S.codeDirty || !S.ready || codeTa.selectionStart !== codeTa.selectionEnd) return;   // a drag-selection is for editing/copying
  goToLine(codeLineOf(codeTa.selectionStart), false);
});
// Live editing: a short pause after the last keystroke re-simulates the edited text in place -
// same camera, same line, same tools/holders - with no Run button (John: the reload lost his place).
const LIVE_MS = 600;
let liveTimer = 0;
codeTa.addEventListener('input', () => {
  const d = codeTa.value !== codeNorm;
  if (d && !S.codeDirty) { S.playing = false; updatePlay(); }
  setCodeDirty(d);
  clearTimeout(liveTimer);
  if (d) liveTimer = setTimeout(runCodeEdit, LIVE_MS);
});
const reloadOpts = () => ({ csv: S.csv, lib: S.lib, setup: S.setup, ops: S.opsList, exported: S.exported, document: S.docName, cimcoTools: S.cimcoTools, partMesh: S.partMesh, stockMesh: S.stockMesh, cimcoWarn: S.cimcoWarn });
// Drop typing that has not been simulated yet (loading anything else does this).
function exitCodeEdit() {
  clearTimeout(liveTimer);
  if (!S.codeDirty) return;
  codeTa.value = codeNorm; setCodeDirty(false); renderCode(S.hudLine, true);
}
// Simulate what is in the box now, keeping the view and putting the sim on the line being edited.
async function runCodeEdit() {
  clearTimeout(liveTimer);
  if (!S.codeDirty) return;
  const newText = codeTa.value, line = codeLineOf(codeTa.selectionStart);
  const baseName = S.name.replace(/ \(edited\)$/, '');
  await loadText(newText, baseName + (newText === S.origText ? '' : ' (edited)'), Object.assign(reloadOpts(), { live: true }));
  if (S.ready && !S.codeDirty) goToLine(line, false);
}
// Back to the program exactly as it was opened.
function undoEdits() {
  if (codeTa.value === S.origText) return;
  codeTa.value = S.origText; setCodeDirty(codeTa.value !== codeNorm);
  if (S.codeDirty) runCodeEdit(); else updateEditRow();
}
function updateEditRow() { $('codeEditRow').hidden = S.origText == null || codeTa.value === S.origText; }
function onOpChange() {
  applyPaths();
  for (const b of $('ops').querySelectorAll('button')) b.setAttribute('aria-current', String(+b.dataset.k === S.curOp));
  const cur = $('ops').querySelector('[aria-current="true"]');
  if (cur) { const box = $('ops'), cr = cur.getBoundingClientRect(), br = box.getBoundingClientRect(); if (cr.top < br.top || cr.bottom > br.bottom) box.scrollTop += cr.top - br.top - 40; }
}
function buildOps() {
  const P = S.prog;
  $('ops').innerHTML = P.ops.map((o, k) => {
    const badges = (o.seq ? `<span class="opbadge seq" title="Sequence number from the setup sheet">N${esc(o.seq)}</span>`
      : o.seqN != null ? `<span class="opbadge seq" title="Sequence number of this tool change - restart here">N${o.seqN}</span>` : '') +
      (o.comp ? `<span class="opbadge cc">${o.comp === 1 ? 'G41' : 'G42'}${o.compD ? ' D' + o.compD : ''}</span>` : '') +
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
$('codeCancel').onclick = undoEdits;
// Settings menus: one open at a time; a click anywhere outside, or Escape, closes it.
const menus = [...document.querySelectorAll('details.menu')];
for (const m of menus) m.addEventListener('toggle', () => { if (m.open) for (const o of menus) if (o !== m) o.open = false; });
document.addEventListener('pointerdown', e => { for (const m of menus) if (m.open && !m.contains(e.target)) m.open = false; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const m of menus) m.open = false; });
$('codeToggle').onclick = () => {
  const show = $('codePane').hidden; $('codePane').hidden = !show;
  $('codeToggle').setAttribute('aria-pressed', String(show));
  try { localStorage.setItem('floorsim.codeHidden', show ? '0' : '1'); } catch (e) { /* storage blocked */ }
  if (show) paintCode();
};
try { if (localStorage.getItem('floorsim.codeHidden') === '1') { $('codePane').hidden = true; $('codeToggle').setAttribute('aria-pressed', 'false'); } } catch (e) { /* storage blocked */ }
$('lineUp').onclick = () => stepLine(-1);
$('lineDn').onclick = () => stepLine(1);
$('fileLib').onchange = e => { const fl = [...e.target.files]; e.target.value = ''; handleFiles(fl); };
$('unitSel').onchange = () => { exitCodeEdit(); if (S.text) loadText(S.text, S.name, reloadOpts()); };
$('progForm').addEventListener('submit', e => { e.preventDefault(); loadProgram($('progNo').value, true); });
$('folderBtn').onclick = () => { setFolder().catch(err => { if (err && err.name !== 'AbortError') toast('Could not open that folder: ' + err.message); }); };
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
  if (S.prog) {
    buildLegend(); for (const pl of S.planes.values()) refreshStock(pl.sim, pl.stock, true);
    if (S.triDexel) { S.triDirty = true; S.triFuseLive = null; refreshTriStock(false); }
  }
});
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
$('projBtn').onclick = () => setOrtho(camera !== orthoCam);
$('bPlay').onclick = togglePlay;
$('bRestart').onclick = () => { if (S.ready) { clearLineSel(); S.pendingSeek = 0; S.playing = false; updatePlay(); } };
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
scrub.addEventListener('input', () => { if (!S.ready) return; clearLineSel(); S.playing = false; updatePlay(); S.pendingSeek = scrub.value / 10000 * S.prog.total; });
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
      // Tri-dexel's surface has to be re-extracted wholesale rather than patched per dirty cell
      // like refreshStock does, so it re-fuses on a throttle while playing and once more at full
      // quality as soon as things settle (paused, seek finished, or end of program).
      if (S.triDexel) refreshTriStock(S.playing);
      updateTool(); updateHud(false);
    }
    if (S.needsRender) { S.needsRender = false; renderer.render(scene, camera); fpsN++; }
    if (now - fpsT > 1000) { S.fps = S.playing ? Math.round(fpsN * 1000 / (now - fpsT)) : 0; fpsN = 0; fpsT = now; updateChips(false); }
    if (S.playing) invalidate();
  } catch (err) { console.error(err); if (!errShown) { errShown = true; toast('Something went wrong in the viewer: ' + err.message); } }
}
resize();
let wantOrtho = false; try { wantOrtho = localStorage.getItem('floorsim.ortho') === '1'; } catch (e) { /* no storage */ }
if (wantOrtho) setOrtho(true);
setView('fit');
requestAnimationFrame(frame);
window.__floorsim = {
  S, orb, goTo, advance, loadText, handleFiles, openFolder, groupFolderFiles, exitCodeEdit, runCodeEdit, goToLine, stepLine,
  loadProgram, setFolder, setOrtho, fixScene, rebuild, STOCK, TILT_ROOT, TRI_ROOT, toolGroups, renderer, pickAt, scene,
  get camera() { return camera; },
};   // handy for debugging in the console
loadText(NC.demoProgram(), 'Demo program', { stock: { xmin: -50, xmax: 50, ymin: -35, ymax: 35, zbot: -20, ztop: 0 } });
startupFolder();
})();
