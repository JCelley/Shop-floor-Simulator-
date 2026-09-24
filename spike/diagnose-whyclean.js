// Why did OLD (tolDeg=60, vertical-tool math) look clean, and NEW (correct local-frame math)
// show a gap, at the SAME world column? Key idea to test: HeightSim.cut always produces ONE
// monotonic "solid from zBot up to h" boundary per column - it is STRUCTURALLY INCAPABLE of a
// gap. OLD force-fits plane 1 into a WORLD-Z column, so whatever it computes there is
// automatically gap-free by construction, correct or not. NEW keeps plane 1 in its own real
// tilted local frame - correct, but a single WORLD-vertical line, scanned through a ROTATED
// frame, does not stay within one local grid cell/column: it sweeps across many different local
// (lx,ly) cells as world z changes, each with its own independently-cut h/op. If plane 1's real
// toolpath (T61, an ADAPTIVE roughing pass) left some of those cells cut deep and neighboring
// ones barely touched (normal for adaptive roughing, which clears in stepped/uneven passes, not
// a smooth surface), sampling straight down in WORLD space can legitimately cross from an "empty"
// cell into a "still solid" cell into another "empty" cell - a real gap, not a bug in the cut math
// itself, just a consequence of querying a tilted result along an axis that isn't its own.
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
console.log('plane 1 axis (world):', NC.planeAxisWorld(p1.matrix).map(v => v.toFixed(4)), '(14.66deg off Z)');

const testX = 10, testY = stockBox.ymin + 3;
function toLocal(wx, wy, wz) {
  const dx = wx - p1.origin[0], dy = wy - p1.origin[1], dz = wz - p1.origin[2];
  const m = p1.matrix;
  return [m[0][0]*dx+m[1][0]*dy+m[2][0]*dz, m[0][1]*dx+m[1][1]*dy+m[2][1]*dz, m[0][2]*dx+m[1][2]*dy+m[2][2]*dz];
}
console.log('\nlocal (lx,ly) as world z sweeps from zbot to ztop at fixed world (x,y):');
for (let z = stockBox.zbot; z <= stockBox.ztop; z += 5) {
  const [lx, ly] = toLocal(testX, testY, z);
  console.log(`  world z=${z.toFixed(1)} -> local (lx=${lx.toFixed(2)}, ly=${ly.toFixed(2)})`);
}

// Now check T61/plane1's real toolpath: how many distinct Z-levels does it step through overall
// (a signature of adaptive roughing's stepped passes), and what does its move density near this
// XY look like.
const w = NC.worldizeMoves(real);
const zLevels = new Set();
let nearMoves = 0;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i] || real.PL[i] !== 1) continue;
  zLevels.add(Math.round(real.Z[i] * 10) / 10); // plane-local Z as programmed
  const d = Math.hypot(w.Xw[i] - testX, w.Yw[i] - testY);
  if (d < 15) nearMoves++;
}
console.log(`\nplane 1 (T61) total distinct programmed Z levels: ${zLevels.size} (adaptive roughing signature)`);
console.log('sample Z levels:', [...zLevels].sort((a,b)=>a-b).slice(0, 10));
console.log(`moves within 15mm of test point (${testX},${testY.toFixed(2)}):`, nearMoves);
