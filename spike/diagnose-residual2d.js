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
const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const partBins = binTriangles(partMesh, gridShape);

function neighborhood(cx, cy, label) {
  console.log(`\nreal PART.stl near (${cx},${cy}) [${label}]:`);
  for (let dy = -7; dy <= 7; dy += 1.75) {
    let row = '';
    for (let dx = -7; dx <= 7; dx += 1.75) {
      const px = cx + dx, py = cy + dy;
      const i = Math.floor((px - gx0) / gdx), j = Math.floor((py - gy0) / gdy);
      const h = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
      row += (h === null ? '  n/a ' : h.toFixed(1).padStart(6));
    }
    console.log(row);
  }
}
neighborhood(39.16, 0.55, 'gouge sample, e=-22.17');
neighborhood(44.63, 18.47, 'gouge sample, e=-22.17');
neighborhood(42.88, 24.37, 'extra-material sample, e=+12.12');
