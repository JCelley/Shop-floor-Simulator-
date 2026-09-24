// The real-pipeline mesh shows the left/right walls as disconnected floating slivers, separate
// from the floor - a gap must have opened up in Z somewhere between them. Scan a vertical column
// near one of those walls and see exactly where solid/empty/solid happens, and which grid/plane is
// responsible for the empty gap.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const partBuf = fs.readFileSync(DIR + 'O1160_PART.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
console.log('stock box:', stockBox);

const TRI_DEXEL_TOL_DEG = 5;
const cls = NC.classifyPlanes(real.planes, TRI_DEXEL_TOL_DEG);
const target = 360;
const td = NC.buildTriDexel(real, target, 5, stockBox, TRI_DEXEL_TOL_DEG);
const sims = NC.buildPlaneSims(real, stockBox, target, 0.5, cls.obliqueIds);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const planeById = new Map(real.planes.map(p => [p.id, p]));

// Reimplement the same solid-test fuseTriDexel uses internally (triSampleSolid + obliquePlaneSolid
// via NC.obliquePlaneSolid, which IS exported) so we can probe arbitrary points directly.
function triSolid(grid, axisIdx, sign, wx, wy, wz) {
  let ax, ay, az;
  if (axisIdx === 2) { ax = wx; ay = wy; az = sign * wz; }
  else if (axisIdx === 0) { ax = wy; ay = wz; az = sign * wx; }
  else { ax = wz; ay = wx; az = sign * wy; }
  const i = Math.floor((ax - grid.x0) / grid.dx), j = Math.floor((ay - grid.y0) / grid.dy);
  if (i < 0 || j < 0 || i > grid.nx - 1 || j > grid.ny - 1) return true;
  const h = grid.h[j * grid.nx + i];
  const EPS = 1e-4;
  return az <= h + EPS && az >= grid.zBot - EPS;
}
function solidAt(wx, wy, wz) {
  for (const [key, grid] of td.grids) {
    const axisIdx = 'XYZ'.indexOf(key[0]), sign = key[1] === '+' ? 1 : -1;
    if (!triSolid(grid, axisIdx, sign, wx, wy, wz)) return { solid: false, by: 'Z+' };
  }
  for (const [id, sim] of sims) {
    const p = planeById.get(id);
    if (!NC.obliquePlaneSolid(sim, p.matrix, p.origin, wx, wy, wz)) return { solid: false, by: 'plane' + id };
  }
  return { solid: true, by: null };
}

// Scan a vertical column near the LEFT edge of the stock (low-Y side) at a mid X, stepping Z from
// bottom to top in fine increments, looking for solid/empty/solid (a gap).
const testX = 10;
const testY = stockBox.ymin + 3; // near the left edge, a few mm in
console.log(`\nscanning column x=${testX}, y=${testY.toFixed(2)} (near left edge) from z=${stockBox.zbot} to ${stockBox.ztop}:`);
let prevSolid = null;
for (let z = stockBox.zbot; z <= stockBox.ztop + 1e-6; z += 0.3) {
  const r = solidAt(testX, testY, z);
  if (prevSolid === null || r.solid !== prevSolid.solid) {
    console.log(`  z=${z.toFixed(2)}: ${r.solid ? 'SOLID' : 'empty (excluded by ' + r.by + ')'}`);
  }
  prevSolid = r;
}

// Also scan across Y at a fixed height near stock top (where the wall should be) to find the
// wall's real Y extent and where along it the gap appears.
console.log(`\nscanning across Y at x=${testX}, z=${(stockBox.ztop - 1).toFixed(2)} (near stock top, should be inside the wall):`);
prevSolid = null;
for (let y = stockBox.ymin; y <= stockBox.ymin + 15; y += 0.5) {
  const r = solidAt(testX, y, stockBox.ztop - 1);
  if (prevSolid === null || r.solid !== prevSolid.solid) {
    console.log(`  y=${y.toFixed(2)}: ${r.solid ? 'SOLID' : 'empty (excluded by ' + r.by + ')'}`);
  }
  prevSolid = r;
}
