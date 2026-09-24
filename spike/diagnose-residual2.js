// Trace the NARROWER residual left after the plane-1 clipping fix: x=[12.7,44.6], y=[-22.8,24.4].
// For each sample point, probe every active entity (Z+ grid, oblique plane 1, oblique plane 8)
// directly - which one(s) have an opinion, and what value - to find which is actually wrong,
// instead of guessing.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const { buildFused, fuseCombined, triSolid, obliqueSolid } = require('./fusedpipeline.js');

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

// Gather a spread of bad points across the x range and both signs.
const bad = [];
for (let j = 0; j < nyg; j++) {
  const py = gy0 + (j + 0.5) * gdy;
  for (let i = 0; i < nxg; i++) {
    const px = gx0 + (i + 0.5) * gdx;
    const real1 = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
    if (real1 === null) continue;
    const sim1 = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
    if (sim1 === null) continue;
    const e = sim1 - real1;
    if (Math.abs(e) >= 10) bad.push({ px, py, sim1, real1, e });
  }
}
console.log('total bad:', bad.length);
const pos_ = bad.filter(b => b.e > 0), neg_ = bad.filter(b => b.e < 0);
// pick a handful spread across x from each sign group
function spread(arr, n) {
  arr.sort((a, b) => a.px - b.px);
  const out = [];
  for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * (arr.length - 1) / (n - 1))]);
  return out;
}
const samples = [...spread(pos_, 3), ...spread(neg_, 3)];

const td = built.td, obliqueSims = built.obliqueSims, planeById = built.planeById;
const zGrid = td.grids.get('Z+');
function probeAll(wx, wy, wz) {
  const out = {};
  out['Z+'] = triSolid(zGrid, 2, 1, wx, wy, wz);
  const zi = Math.floor((wx - zGrid.x0) / zGrid.dx), zj = Math.floor((wy - zGrid.y0) / zGrid.dy);
  out['Z+ h'] = zGrid.h[zj * zGrid.nx + zi];
  for (const [id, sim] of obliqueSims) {
    const p = planeById.get(id);
    out[`plane${id}`] = obliqueSolid(sim, p.matrix, p.origin, wx, wy, wz);
  }
  return out;
}

for (const b of samples) {
  console.log(`\n(${b.px.toFixed(2)}, ${b.py.toFixed(2)})  sim=${b.sim1.toFixed(2)}  real=${b.real1.toFixed(2)}  e=${b.e.toFixed(2)}`);
  // test AT the sim height (does everyone agree it's the boundary there?) and at the real height
  console.log('  at sim height:', probeAll(b.px, b.py, b.sim1));
  console.log('  at real height:', probeAll(b.px, b.py, b.real1));
}
