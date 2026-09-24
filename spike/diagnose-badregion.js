'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { compareToPart } = require('./compareToPart.js');
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
console.log('stock box:', stockBox, 'thickness', (stockBox.ztop - stockBox.zbot).toFixed(2));

const target = 360;
const td = NC.buildTriDexel(real, target, 5, stockBox, 60);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const { pos, idx } = NC.fuseTriDexel(td, target);

const { binTriangles, partHeightAt } = require('./compareToPart.js');
const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMeshOf(), gridShape);
function partMeshOf() { return result.partMesh; }

let xminBad = Infinity, xmaxBad = -Infinity, yminBad = Infinity, ymaxBad = -Infinity;
let nBad = 0, sumSimZ = 0, sumRealZ = 0, signPos = 0, signNeg = 0;
const badPts = [];
for (let j = 0; j < nyg; j++) {
  const py = gy0 + (j + 0.5) * gdy;
  for (let i = 0; i < nxg; i++) {
    const px = gx0 + (i + 0.5) * gdx;
    const realZ = partHeightAt(result.partMesh, partBins, gridShape, i, j, px, py);
    if (realZ === null) continue;
    const simZ = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
    if (simZ === null) continue;
    const e = simZ - realZ;
    if (Math.abs(e) >= 10) {
      nBad++;
      if (px < xminBad) xminBad = px; if (px > xmaxBad) xmaxBad = px;
      if (py < yminBad) yminBad = py; if (py > ymaxBad) ymaxBad = py;
      sumSimZ += simZ; sumRealZ += realZ;
      if (e > 0) signPos++; else signNeg++;
      badPts.push([px, py, simZ, realZ]);
    }
  }
}
console.log('bad columns:', nBad);
console.log('bad region XY bbox: x[', xminBad.toFixed(2), ',', xmaxBad.toFixed(2), '] y[', yminBad.toFixed(2), ',', ymaxBad.toFixed(2), ']');
console.log('stock XY bbox:      x[', stockBox.xmin.toFixed(2), ',', stockBox.xmax.toFixed(2), '] y[', stockBox.ymin.toFixed(2), ',', stockBox.ymax.toFixed(2), ']');
console.log('avg sim Z at bad columns:', (sumSimZ / nBad).toFixed(2), '  avg real Z at bad columns:', (sumRealZ / nBad).toFixed(2));
console.log('stock Z range:', stockBox.zbot.toFixed(2), 'to', stockBox.ztop.toFixed(2));
console.log('sign: sim>real (sim has EXTRA material, i.e. under-cut):', signPos, '   sim<real (sim REMOVED too much, i.e. a gouge):', signNeg);
console.log('sample bad points (x,y,simZ,realZ):');
for (const p of badPts.slice(0, 5)) console.log(' ', p.map(v => v.toFixed(2)));
for (const p of badPts.slice(-5)) console.log(' ', p.map(v => v.toFixed(2)));
