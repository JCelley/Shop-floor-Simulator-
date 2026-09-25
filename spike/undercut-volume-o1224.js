// Void-aware ground truth for the undercut work: sample points in 3D around where O1224's T81
// lollipop cuts (tilted plane 7) and ask "solid?" of both the real PART.stl (ray parity) and the
// finished sim (stock field > 0). Run twice - lollipop cutting ON (new) and OFF (the old skip) - so
// the difference the undercut support makes is measured, not eyeballed. The old top-down
// compareToPart can't see an undercut at all.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const C = path.join(ROOT, 'fixtures', 'cimco') + path.sep;
const real = NC.parseProgram(fs.readFileSync(path.join(ROOT, 'fixtures', 'O1224.NC'), 'utf8'));
const parsed = NC.parseCimcoSetup(fs.readFileSync(C + 'O1224.setup', 'utf8'));
NC.applyCimcoTools(parsed, real.tools);
const res = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(fs.readFileSync(C + 'O1224_STOCK.stl')), part: NC.parseStlBinary(fs.readFileSync(C + 'O1224_PART.stl')) }, 'O1224');
const s = res.setup.stock, stockBox = { xmin: s.xmin, xmax: s.xmax, ymin: s.ymin, ymax: s.ymax, zbot: s.zmin, ztop: s.zmax };
const part = res.partMesh, planeById = new Map(real.planes.map(p => [p.id, p]));
const t81 = real.tools.find(t => t.no === 81);
console.log(`T81: ${t81.ucType}, D ${t81.D.toFixed(3)} mm, neck ${t81.neckD.toFixed(3)} mm${t81.neckGuess ? ' (GUESSED)' : ''}, neck length ${(t81.neckL || 0).toFixed(2)}`);

function simulate(withUndercut) {
  const cls = NC.classifyPlanes(real.planes, 5);
  const td = NC.buildTriDexel(real, 300, 5, stockBox, 5);
  const sims = NC.buildPlaneSims(real, stockBox, 300, 0.5, cls.obliqueIds);
  const tools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
  if (!withUndercut) tools.set(81, Object.assign({}, tools.get(81), { ucProf: null }));
  const t0 = Date.now();
  for (let i = 0; i < real.n; i++) { NC.cutMoveMulti(sims, real, tools, i, 0, 1); NC.cutTriDexelMove(td, real, tools, i, 0, 1); }
  return { field: NC.stockField(td, sims, planeById), ms: Date.now() - t0, sims };
}
const on = simulate(true), off = simulate(false);
console.log(`cut time: with lollipop ${on.ms} ms, without ${off.ms} ms`);

// region: world bbox of every plane-7 cell the lollipop touched, padded 2mm
const s7 = on.sims.get(7), m = planeById.get(7).matrix, o = planeById.get(7).origin;
const bb = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
for (let j = 0; j < s7.ny; j++) for (let i = 0; i < s7.nx; i++) {
  const k = j * s7.nx + i; if (!s7.op[k]) continue;
  const lx = s7.x0 + (i + 0.5) * s7.dx, ly = s7.y0 + (j + 0.5) * s7.dy;
  for (const lz of [s7.h[k], ...(s7.voids.get(k) || [])]) {
    const w = [0, 1, 2].map(r => o[r] + m[r][0] * lx + m[r][1] * ly + m[r][2] * lz);
    bb.x0 = Math.min(bb.x0, w[0]); bb.x1 = Math.max(bb.x1, w[0]); bb.y0 = Math.min(bb.y0, w[1]); bb.y1 = Math.max(bb.y1, w[1]); bb.z0 = Math.min(bb.z0, w[2]); bb.z1 = Math.max(bb.z1, w[2]);
  }
}
for (const [a, b] of [['x0', 'x1'], ['y0', 'y1'], ['z0', 'z1']]) { bb[a] -= 2; bb[b] += 2; }
console.log('lollipop region (world mm):', Object.fromEntries(Object.entries(bb).map(([k, v]) => [k, +v.toFixed(1)])));

// PART.stl inside test: +Z ray parity, triangles binned by XY
const B = 0.5, bins = new Map(), P = part.pos, I = part.idx;
for (let t = 0; t < I.length; t += 3) {
  const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
  const i0 = Math.floor(Math.min(P[a], P[b], P[c]) / B), i1 = Math.floor(Math.max(P[a], P[b], P[c]) / B);
  const j0 = Math.floor(Math.min(P[a + 1], P[b + 1], P[c + 1]) / B), j1 = Math.floor(Math.max(P[a + 1], P[b + 1], P[c + 1]) / B);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const key = i + ',' + j; if (!bins.has(key)) bins.set(key, []); bins.get(key).push(t); }
}
function inPart(x, y, z) {
  const list = bins.get(Math.floor(x / B) + ',' + Math.floor(y / B)); if (!list) return false;
  let n = 0;
  for (const t of list) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const v0x = P[b] - P[a], v0y = P[b + 1] - P[a + 1], v1x = P[c] - P[a], v1y = P[c + 1] - P[a + 1], v2x = x - P[a], v2y = y - P[a + 1];
    const den = v0x * v1y - v1x * v0y; if (Math.abs(den) < 1e-12) continue;
    const v = (v2x * v1y - v1x * v2y) / den, w = (v0x * v2y - v2x * v0y) / den;
    if (v < 0 || w < 0 || v + w > 1) continue;
    if (P[a + 2] + v * (P[b + 2] - P[a + 2]) + w * (P[c + 2] - P[a + 2]) > z) n++;
  }
  return (n & 1) === 1;
}
const step = 0.3;
function score(field, label) {
  let n = 0, agree = 0, extra = 0, gouge = 0;
  for (let z = bb.z0; z <= bb.z1; z += step) for (let y = bb.y0; y <= bb.y1; y += step) for (let x = bb.x0; x <= bb.x1; x += step) {
    const ip = inPart(x + 1e-4, y + 1.3e-4, z), is = field.value(x, y, z) > 0;
    n++; if (ip === is) agree++; else if (is) extra++; else gouge++;
  }
  console.log(`${label}: ${n} points, agree ${(100 * agree / n).toFixed(2)}%, sim has material the part doesn't ${(100 * extra / n).toFixed(2)}%, sim missing material the part has ${(100 * gouge / n).toFixed(2)}%`);
}
score(off.field, 'lollipop OFF (old)');
score(on.field, 'lollipop ON  (new)');
// Only the points the lollipop actually changes: did turning it on move them toward the real part?
{
  let changed = 0, nowRight = 0, nowWrong = 0, under = 0;
  for (let z = bb.z0; z <= bb.z1; z += step / 2) for (let y = bb.y0; y <= bb.y1; y += step / 2) for (let x = bb.x0; x <= bb.x1; x += step / 2) {
    const a = off.field.value(x, y, z) > 0, b = on.field.value(x, y, z) > 0;
    if (a === b) continue;
    changed++;
    const ip = inPart(x + 1e-4, y + 1.3e-4, z);
    if (b === ip) nowRight++; else nowWrong++;
    // is this point really UNDER remaining material (a true undercut), i.e. is there still solid sim material straight above it?
    let solidAbove = false; for (let zz = z + 0.2; zz < bb.z1 + 5; zz += 0.2) if (on.field.value(x, y, zz) > 0) { solidAbove = true; break; }
    if (solidAbove) under++;
  }
  console.log(`points the lollipop changes (0.15mm grid): ${changed}; now matching the real part: ${nowRight} (${(100 * nowRight / changed).toFixed(1)}%), now wrong: ${nowWrong}; of the changed points, ${under} are true undercuts (material still above them)`);
}
