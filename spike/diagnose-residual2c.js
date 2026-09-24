// move 12988 (plane 3, T35, op 15) is the one that plunges column (33.91,-19.35) from 87.87 down
// to 65.81. Two questions: (1) is plane 3's own coordinate frame (origin/matrix) sane relative to
// plane 0's, ruling out a placement bug: (2) does the REAL part have a small raised feature (like
// one of the 3 bosses visible in the floor screenshots) right at this XY that a broad pocket-clear
// pass should have avoided but didn't - i.e. is this a real small-island/boss the program should
// have protected, not a sim bug at all.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
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
const partMesh = result.partMesh;

const plane0 = real.planes.find(p => p.id === 0);
const plane3 = real.planes.find(p => p.id === 3);
console.log('plane 0 origin:', plane0.origin, 'matrix col2 (axis):', [plane0.matrix[0][2], plane0.matrix[1][2], plane0.matrix[2][2]]);
console.log('plane 3 origin:', plane3.origin, 'matrix col2 (axis):', [plane3.matrix[0][2], plane3.matrix[1][2], plane3.matrix[2][2]]);
console.log('origin delta:', [plane3.origin[0]-plane0.origin[0], plane3.origin[1]-plane0.origin[1], plane3.origin[2]-plane0.origin[2]]);

// Sample the REAL part height on a small grid around (33.91,-19.35) to see the actual shape there.
const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const partBins = binTriangles(partMesh, gridShape);
console.log('\nreal PART.stl height in a 15x15mm neighborhood around (33.91,-19.35):');
for (let dy = -7; dy <= 7; dy += 1.75) {
  let row = '';
  for (let dx = -7; dx <= 7; dx += 1.75) {
    const px = 33.91 + dx, py = -19.35 + dy;
    const i = Math.floor((px - gx0) / gdx), j = Math.floor((py - gy0) / gdy);
    const h = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
    row += (h === null ? '  n/a ' : h.toFixed(1).padStart(6));
  }
  console.log(row);
}

// Also find which OTHER plane-0/2-7 moves, if any, later re-cut this column back up (they can't -
// cutting only lowers h) - instead check: does T35 op15 cut a WIDE area (broad pocket clear) or
// just this column (narrow/local)? Sample T35 op15's move extents.
const w = NC.worldizeMoves(real);
let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,n=0;
for (let i=0;i<real.n;i++){
  if (!real.K[i] || real.PL[i]!==3 || real.OP[i]!==15) continue; // move 12988 printed "op 15" = real.OP[i] directly
  n++;
  if (w.Xw[i]<xmin) xmin=w.Xw[i]; if (w.Xw[i]>xmax) xmax=w.Xw[i];
  if (w.Yw[i]<ymin) ymin=w.Yw[i]; if (w.Yw[i]>ymax) ymax=w.Yw[i];
}
console.log('\nop15 (plane 3, T35) move count:', n, 'XY bbox: x[', xmin.toFixed(2), ',', xmax.toFixed(2), '] y[', ymin.toFixed(2), ',', ymax.toFixed(2), ']');
