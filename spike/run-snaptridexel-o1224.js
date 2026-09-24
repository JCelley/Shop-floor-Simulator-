'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');

const real = NC.parseProgram(fs.readFileSync(path.join(ROOT, 'fixtures', 'O1224.NC'), 'utf8'));
const setupText = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224.setup'), 'utf8');
const stockBuf = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224_STOCK.stl'));
const partBuf = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224_PART.stl'));
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1224');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
const partMesh = result.partMesh;

const target = 360, TOL_DEG = 60;
const t0 = Date.now();
const td = NC.buildTriDexel(real, target, 5, stockBox, TOL_DEG);
console.log('aligned (snapped):', [...td.alignedIds].sort((a, b) => a - b), 'oblique (should be empty):', [...td.obliqueIds]);
console.log('grids used:', [...td.grids.keys()]);

const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
let cutMoves = 0;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
  cutMoves++;
}
const cutMs = Date.now() - t0;
console.log('cut', cutMoves, 'moves in', cutMs, 'ms =', (cutMs / cutMoves).toFixed(4), 'ms/move');

const { pos, idx } = NC.fuseTriDexel(td, target);
console.log('mesh (comparison-resolution):', pos.length / 3, 'verts', idx.length / 3, 'tris');
// A separate, coarser mesh just for the screenshot - the comparison above already ran at full
// target resolution; 2.5M+ verts is impractically large to hand to a browser for a screenshot.
const low = NC.fuseTriDexel(td, 120);
fs.writeFileSync(path.join(__dirname, 'out-snaptridexel-o1224.json'), JSON.stringify({ pos: Array.from(low.pos), idx: Array.from(low.idx), box: stockBox }));
console.log('screenshot mesh:', low.pos.length / 3, 'verts', low.idx.length / 3, 'tris');

const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMesh, gridShape);

// O1224 is also a first ("Op 50") setup - same vise-held-stock caveat as O1160 (see that script
// and compareToPart.js). Report raw and held-stock-excluded side by side.
function run(ignoreHeldStock) {
  let count = 0, sumAbs = 0, maxAbs = 0, maxAt = null, excludedHeldStock = 0;
  const HIST = [0, 0, 0, 0, 0];
  for (let j = 0; j < nyg; j++) {
    const py = gy0 + (j + 0.5) * gdy;
    for (let i = 0; i < nxg; i++) {
      const px = gx0 + (i + 0.5) * gdx;
      const real1 = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
      if (real1 === null) continue;
      const sim1 = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
      if (sim1 === null) continue;
      const e = sim1 - real1;
      if (ignoreHeldStock && e > 0) { excludedHeldStock++; continue; }
      count++; const ae = Math.abs(e); sumAbs += ae; if (ae > maxAbs) { maxAbs = ae; maxAt = [px, py, sim1, real1]; }
      if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
    }
  }
  console.log(`=== O1224 (snap-to-axis tri-dexel) vs real PART.stl ${ignoreHeldStock ? '[held-stock excluded, sim<real only]' : '[raw, all columns]'} ===`);
  console.log('compared columns:', count, '/', nxg * nyg, ignoreHeldStock ? `(excluded as expected held stock: ${excludedHeldStock})` : '');
  console.log('mean abs error (mm):', (sumAbs / count).toFixed(3));
  console.log('max abs error (mm):', maxAbs.toFixed(3), 'at', maxAt);
  console.log('error histogram: <0.2mm', HIST[0], '| <1mm', HIST[1], '| <3mm', HIST[2], '| <10mm', HIST[3], '| >=10mm', HIST[4]);
  console.log(`  as %% of compared columns: ${HIST.map(v => (100 * v / count).toFixed(1) + '%').join(', ')}`);
}
run(false);
console.log();
run(true);
