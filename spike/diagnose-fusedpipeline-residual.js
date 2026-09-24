'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const { buildFused, fuseCombined } = require('./fusedpipeline.js');

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
const target = 360;
const built = buildFused(real, stockBox, target, 5);
const { pos, idx } = fuseCombined(built, target);

const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMesh, gridShape);
let signPos = 0, signNeg = 0;
let xminBad = Infinity, xmaxBad = -Infinity, yminBad = Infinity, ymaxBad = -Infinity;
const badPts = [];
for (let j = 0; j < nyg; j++) {
  const py = gy0 + (j + 0.5) * gdy;
  for (let i = 0; i < nxg; i++) {
    const px = gx0 + (i + 0.5) * gdx;
    const real1 = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
    if (real1 === null) continue;
    const sim1 = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
    if (sim1 === null) continue;
    const e = sim1 - real1;
    if (Math.abs(e) >= 10) {
      if (e > 0) signPos++; else signNeg++;
      if (px < xminBad) xminBad = px; if (px > xmaxBad) xmaxBad = px;
      if (py < yminBad) yminBad = py; if (py > ymaxBad) ymaxBad = py;
      badPts.push([px, py, sim1, real1]);
    }
  }
}
console.log('sign: sim>real (extra material):', signPos, '  sim<real (gouge):', signNeg);
console.log('bad region bbox: x[', xminBad.toFixed(2), ',', xmaxBad.toFixed(2), '] y[', yminBad.toFixed(2), ',', ymaxBad.toFixed(2), ']');
console.log('sample bad points:');
for (const p of badPts.slice(0, 8)) console.log(' ', p.map(v => v.toFixed(2)));
