// plane 1 has ZERO real moves within 15mm of world (10,-23.67), yet obliquePlaneSolid excluded
// material there at low world-z. Trace which specific move (if any) actually set op!=0 at the
// exact local cell that world point maps to, to find out if this is a real (if distant, tool-
// radius-reaching) cut, or a genuine transform/indexing bug.
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
const p1 = real.planes.find(p => p.id === 1);
const target = 360;
const sims = NC.buildPlaneSims(real, stockBox, target, 0.5, new Set([1]));
const sim1 = sims.get(1);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));

function toLocal(wx, wy, wz) {
  const dx = wx - p1.origin[0], dy = wy - p1.origin[1], dz = wz - p1.origin[2];
  const m = p1.matrix;
  return [m[0][0]*dx+m[1][0]*dy+m[2][0]*dz, m[0][1]*dx+m[1][1]*dy+m[2][1]*dz, m[0][2]*dx+m[1][2]*dy+m[2][2]*dz];
}
const testX = 10, testY = stockBox.ymin + 3, testZ = 65; // near the bottom, where solidAt() reported "excluded by plane1"
const [lx, ly, lz] = toLocal(testX, testY, testZ);
const li = Math.floor((lx - sim1.x0) / sim1.dx), lj = Math.floor((ly - sim1.y0) / sim1.dy);
console.log(`world (${testX},${testY.toFixed(2)},${testZ}) -> local (${lx.toFixed(2)},${ly.toFixed(2)},${lz.toFixed(2)}) -> cell (${li},${lj})`);
console.log('sim1 box (local):', sim1.box, 'nx,ny', sim1.nx, sim1.ny, 'dx,dy', sim1.dx.toFixed(3), sim1.dy.toFixed(3));

// Cut moves one at a time, watching for when this exact cell's op changes.
let lastOp = 0, lastH = sim1.zTop;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i] || real.PL[i] !== 1) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
  const idx = lj * sim1.nx + li;
  if (sim1.op[idx] !== lastOp || Math.abs(sim1.h[idx] - lastH) > 1e-6) {
    console.log(`move ${i}: op ${real.OP[i]} tool T${real.TL[i]} R=${T.R} -> cell op ${lastOp}->${sim1.op[idx]}, h ${lastH.toFixed(3)}->${sim1.h[idx].toFixed(3)}`);
    console.log(`   move local coords: from (${i>0?real.X[i-1]:real.init.x},${i>0?real.Y[i-1]:real.init.y},${i>0?real.Z[i-1]:real.init.z}) to (${real.X[i]},${real.Y[i]},${real.Z[i]})`);
    const worldA = i>0 ? [NC.worldizeMoves(real).Xw[i-1]] : null; // (skip, expensive to recompute each time)
    lastOp = sim1.op[idx]; lastH = sim1.h[idx];
  }
}
console.log('\nfinal cell op:', sim1.op[lj*sim1.nx+li], 'h:', sim1.h[lj*sim1.nx+li].toFixed(3), '(zBot', sim1.zBot.toFixed(3), 'zTop', sim1.zTop.toFixed(3), ')');
