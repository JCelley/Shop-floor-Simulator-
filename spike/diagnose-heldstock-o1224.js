// Check WHERE the "sim > real" (positive-error) columns for O1224 actually sit in Z, before
// trusting a blanket "any extra material = expected vise-held stock" exclusion. John's exact
// instruction was to ignore stock "directly below the part still, in the Z- direction" - a
// bottom band near the stock floor, not "any column that isn't at final height yet". If most of
// the 56,396 excluded columns from run-snaptridexel-o1224.js sit near stock TOP (not bottom),
// that blanket rule is wrong for this job and needs to be Z-gated instead of sign-gated.
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
console.log('stock Z range:', stockBox.zbot.toFixed(2), 'to', stockBox.ztop.toFixed(2), '(thickness', (stockBox.ztop - stockBox.zbot).toFixed(2), ')');

const target = 360, TOL_DEG = 60;
const td = NC.buildTriDexel(real, target, 5, stockBox, TOL_DEG);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
const { pos, idx } = NC.fuseTriDexel(td, target);

const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMesh, gridShape);

// Bucket positive-error (sim > real) columns by how close the SIM height is to stock bottom vs top.
const thick = stockBox.ztop - stockBox.zbot;
const BUCKETS = 10; // 0 = bottom 10% of stock, 9 = top 10%
const bucketCount = new Array(BUCKETS).fill(0);
const bucketSumErr = new Array(BUCKETS).fill(0);
let posCount = 0, negCount = 0;

for (let j = 0; j < nyg; j++) {
  const py = gy0 + (j + 0.5) * gdy;
  for (let i = 0; i < nxg; i++) {
    const px = gx0 + (i + 0.5) * gdx;
    const realZ = partHeightAt(partMesh, partBins, gridShape, i, j, px, py);
    if (realZ === null) continue;
    const simZ = partHeightAt(simMesh, simBins, gridShape, i, j, px, py);
    if (simZ === null) continue;
    const e = simZ - realZ;
    if (e <= 0) { negCount++; continue; }
    posCount++;
    // where does the REAL (finished part) surface sit in the stock's Z range? that's the
    // relevant question - "directly below the part" means the real surface itself is near
    // the stock bottom there.
    let frac = (realZ - stockBox.zbot) / thick;
    frac = Math.max(0, Math.min(0.9999, frac));
    const b = Math.floor(frac * BUCKETS);
    bucketCount[b]++;
    bucketSumErr[b] += e;
  }
}
console.log('total sim>real (positive/held-stock-like) columns:', posCount, '  sim<=real:', negCount);
console.log('\nof the positive-error columns, bucketed by REAL (finished-part) surface height within the stock (0=bottom 10%, 9=top 10%):');
for (let b = 0; b < BUCKETS; b++) {
  const lo = (stockBox.zbot + (b / BUCKETS) * thick).toFixed(1);
  const hi = (stockBox.zbot + ((b + 1) / BUCKETS) * thick).toFixed(1);
  const avg = bucketCount[b] ? (bucketSumErr[b] / bucketCount[b]).toFixed(2) : '-';
  console.log(`  [${lo}, ${hi}) mm:  ${bucketCount[b]} columns, avg extra material ${avg}mm`);
}
