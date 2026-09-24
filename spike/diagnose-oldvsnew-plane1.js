// Why did the round-3 (tolDeg=60) render look clean here while the corrected pipeline shows a
// gap? Compare what plane 1's cut computes at the SAME wall column under both methods:
//   OLD (round 3): plane 1's moves force-snapped into the shared Z+ grid, cut with the ordinary
//     vertical-tool cutMove math - WRONG for a 14.66deg real tilt, but "wrong" in some direction.
//   NEW (correct): plane 1 cut through its own real local frame (buildPlaneSims/cutMoveMulti,
//     unmodified, exact for its true tilted axis).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const target = 360;

// OLD: force-snap plane 1 into the shared world grid (tolDeg=60), cut ONLY plane 1's moves so its
// contribution is isolated.
const tdOld = NC.buildTriDexel(real, target, 5, stockBox, 60);
console.log('OLD (tolDeg=60): plane 1 snapped to', tdOld.signOf.get(1));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i] || real.PL[i] !== 1) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(tdOld, real, simTools, i, 0, 1);
}
const oldGrid = tdOld.grids.get(tdOld.signOf.get(1));
const testX = 10, testY = stockBox.ymin + 3;
const oi = Math.floor((testX - oldGrid.x0) / oldGrid.dx), oj = Math.floor((testY - oldGrid.y0) / oldGrid.dy);
console.log(`OLD: plane 1's snapped-Z+ height at (${testX},${testY.toFixed(2)}):`, oldGrid.h[oj * oldGrid.nx + oi].toFixed(3), '(world Z, since it snapped to Z+)');

// NEW: plane 1's own real local-frame sim (unmodified buildPlaneSims/cutMoveMulti).
const sims = NC.buildPlaneSims(real, stockBox, target, 0.5, new Set([1]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i] || real.PL[i] !== 1) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
}
const sim1 = sims.get(1);
const p1 = real.planes.find(p => p.id === 1);
// transform (testX,testY,z) world -> plane1 local, for a few z, to find where NEW's real boundary is
function toLocal(wx, wy, wz) {
  const dx = wx - p1.origin[0], dy = wy - p1.origin[1], dz = wz - p1.origin[2];
  const m = p1.matrix;
  return [
    m[0][0] * dx + m[1][0] * dy + m[2][0] * dz,
    m[0][1] * dx + m[1][1] * dy + m[2][1] * dz,
    m[0][2] * dx + m[1][2] * dy + m[2][2] * dz,
  ];
}
const [lx, ly] = toLocal(testX, testY, stockBox.zbot);
const li = Math.floor((lx - sim1.x0) / sim1.dx), lj = Math.floor((ly - sim1.y0) / sim1.dy);
console.log(`NEW: plane 1's real local-frame height at local cell (${li},${lj}):`, sim1.h[lj * sim1.nx + li].toFixed(3), '(plane-1-local Z, not directly comparable to world Z)');
console.log('   (local h is measured along plane 1\'s OWN tilted axis, not world Z - use diagnose-wallgap.js\'s world-space scan for the real comparison, this just shows the raw numbers differ)');

// Direct, fair comparison: scan world Z at this XY and find where EACH method's boundary actually
// sits in WORLD coordinates (both already do this correctly via their own solid tests).
function triSolidOld(wx, wy, wz) {
  const g = oldGrid, key = tdOld.signOf.get(1), axisIdx = 'XYZ'.indexOf(key[0]), sign = key[1] === '+' ? 1 : -1;
  let ax, ay, az;
  if (axisIdx === 2) { ax = wx; ay = wy; az = sign * wz; } else if (axisIdx === 0) { ax = wy; ay = wz; az = sign * wx; } else { ax = wz; ay = wx; az = sign * wy; }
  const i = Math.floor((ax - g.x0) / g.dx), j = Math.floor((ay - g.y0) / g.dy);
  if (i < 0 || j < 0 || i > g.nx - 1 || j > g.ny - 1) return true;
  return az <= g.h[j * g.nx + i] + 1e-4 && az >= g.zBot - 1e-4;
}
let oldBoundary = null, newBoundary = null;
for (let z = stockBox.zbot; z <= stockBox.ztop; z += 0.1) {
  const oldSolid = triSolidOld(testX, testY, z);
  if (oldBoundary === null && !oldSolid) oldBoundary = z; // first empty z scanning up = old cut boundary... actually track transition
}
// scan from top down instead, to find the highest solid z (the surface boundary each method leaves)
let oldTop = null, newTop = null;
for (let z = stockBox.ztop; z >= stockBox.zbot; z -= 0.1) {
  if (oldTop === null && triSolidOld(testX, testY, z)) oldTop = z;
  if (newTop === null && NC.obliquePlaneSolid(sim1, p1.matrix, p1.origin, testX, testY, z)) newTop = z;
  if (oldTop !== null && newTop !== null) break;
}
console.log(`\nAt world (${testX}, ${testY.toFixed(2)}): OLD (snapped-to-Z, wrong vertical math) leaves solid up to z=${oldTop}`);
console.log(`At world (${testX}, ${testY.toFixed(2)}): NEW (correct local-frame math) leaves solid up to z=${newTop}`);
console.log(`Real design wants this column near stock top (${stockBox.ztop.toFixed(2)}) since it's wall.`);
