'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { cutMoveWorld } = require('./worlddexel.js');
const { compareToPart } = require('./compareToPart.js');
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const ncText = fs.readFileSync(DIR + 'O1160.NC', 'utf8');
const real = NC.parseProgram(ncText);
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const partBuf = fs.readFileSync(DIR + 'O1160_PART.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const partMesh = result.partMesh; // already unit-converted + placed in the same mm/world frame as the stock

const target = 360;
const W = stockBox.xmax - stockBox.xmin, H = stockBox.ymax - stockBox.ymin;
const c = Math.max(W, H) / target;
const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c));
const grid = {
  nx, ny, dx: W / nx, dy: H / ny, x0: stockBox.xmin, y0: stockBox.ymin,
  zBot: stockBox.zbot, zTop: stockBox.ztop,
  h: new Float32Array(nx * ny).fill(stockBox.ztop), op: new Int32Array(nx * ny),
};

const w = NC.worldizeMoves(real);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));

const t0 = Date.now();
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  cutMoveWorld(grid, ax, ay, az, w.Xw[i], w.Yw[i], w.Zw[i], a, T, real.OP[i] + 1, 40);
}
console.log('sim time', Date.now() - t0, 'ms');

const stats = compareToPart(grid, partMesh);
console.log('=== O1160 vs real PART.stl ===');
console.log('compared columns:', stats.count, '/', grid.nx * grid.ny, `(${(100 * stats.count / (grid.nx * grid.ny)).toFixed(1)}% - the rest is outside the real part footprint or a raycast gap)`);
console.log('mean abs error (mm):', stats.meanAbs.toFixed(3));
console.log('max abs error (mm):', stats.maxAbs.toFixed(3), 'at', stats.maxAbsAt);
console.log('error histogram: <0.2mm', stats.hist[0], '| <1mm', stats.hist[1], '| <3mm', stats.hist[2], '| <10mm', stats.hist[3], '| >=10mm', stats.hist[4]);
console.log(`  as %% of compared columns: ${stats.hist.map(v => (100 * v / stats.count).toFixed(1) + '%').join(', ')}`);

// Write a per-cell-center point cloud with signed error, so it can be coloured by deviation
// (red = sim has EXTRA material / under-cut, blue = sim REMOVED too much / a gouge) - enough to
// see WHERE it's wrong, not just that it is.
const pts = [];
for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
  const idx = j * grid.nx + i, e = stats.err[idx];
  if (Number.isNaN(e)) continue;
  const px = grid.x0 + (i + 0.5) * grid.dx, py = grid.y0 + (j + 0.5) * grid.dy;
  pts.push([px, py, grid.h[idx], e]);
}
fs.writeFileSync(path.join(__dirname, 'out-compare-o1160.json'), JSON.stringify({ pts, box: stockBox }));
console.log('wrote spike/out-compare-o1160.json (', pts.length, 'points )');
