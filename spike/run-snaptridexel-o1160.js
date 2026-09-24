// Round 3: reuse tri-dexel's OWN proven per-axis-grid mechanism for EVERY plane (snap to the
// nearest signed world axis via a loosened classifyPlanes tolerance), instead of the standalone
// arbitrary-axis single-grid math from round 2 (worlddexel.js) - which had a real, categorical
// bug: a single fixed-axis grid is wrong (not just imprecise) for a tool whose real axis is far
// from that grid's axis. No new swept-volume geometry here at all - this is 100% the EXISTING,
// already-tested cutMove/HeightSim.cut, just applied to every plane instead of only the exactly-
// aligned ones. Compared against the real PART.stl, not eyeballed.
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
const partMesh = result.partMesh;

const target = 360;
const TOL_DEG = 60; // snap EVERY plane to its nearest world axis, not just exactly-aligned ones
const t0 = Date.now();
const td = NC.buildTriDexel(real, target, 5, stockBox, TOL_DEG);
console.log('aligned (snapped):', [...td.alignedIds].sort((a, b) => a - b), 'oblique (should be empty):', [...td.obliqueIds]);
console.log('grids used:', [...td.grids.keys()]);

const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
let cutMoves = 0, skippedUndercut = 0;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T) continue;
  if (T.undercut) { skippedUndercut++; continue; }
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
  cutMoves++;
}
const cutMs = Date.now() - t0;
console.log('cut', cutMoves, 'moves (', skippedUndercut, 'undercut skipped) in', cutMs, 'ms =', (cutMs / cutMoves).toFixed(4), 'ms/move');

// Build a fused mesh for the screenshot, AND a comparable single "world Z" height grid for
// compareToPart (compareToPart works on a plain height grid - approximate by sampling the fused
// mesh's own vertex heights isn't quite right; instead, resample the FUSED TRIANGLE MESH itself
// via the same raycast approach compareToPart already uses for the real part, by treating the
// fused mesh AS the "grid" input - reuse the raycast machinery directly on it).
const { pos, idx } = NC.fuseTriDexel(td, target);
fs.writeFileSync(path.join(__dirname, 'out-snaptridexel-o1160.json'), JSON.stringify({ pos: Array.from(pos), idx: Array.from(idx), box: stockBox }));
console.log('mesh:', pos.length / 3, 'verts', idx.length / 3, 'tris');

// Compare: raycast down through BOTH the fused sim mesh and the real part mesh, at the same XY
// grid, and diff. Reuses compareToPart's own triangle-raycast helpers directly (both are meshes).
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
const simMesh = { pos, idx };
const simBins = binTriangles(simMesh, gridShape);
const partBins = binTriangles(partMesh, gridShape);

// O1160 is a first ("Op 50") setup: the vise legitimately holds a section of stock this program
// never touches, which shows up as sim > real (sim correctly has MORE material than the finished
// design - a later op removes it, not this one). That's not a defect. Report BOTH numbers -
// raw (everything counted) and held-stock-excluded (only sim < real, real over-cuts, counted) -
// side by side rather than silently picking one, since whether the exclusion is right depends on
// the job (an Op 60/finishing job should NOT get this treatment - see compareToPart.js).
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
      if (sim1 === null) continue; // sim mesh doesn't cover here (e.g. outside the fused box) - treat as "no data" like before, not a silent 0
      const e = sim1 - real1;
      if (ignoreHeldStock && e > 0) { excludedHeldStock++; continue; }
      count++; const ae = Math.abs(e); sumAbs += ae; if (ae > maxAbs) { maxAbs = ae; maxAt = [px, py, sim1, real1]; }
      if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
    }
  }
  console.log(`=== O1160 (snap-to-axis tri-dexel) vs real PART.stl ${ignoreHeldStock ? '[held-stock excluded, sim<real only]' : '[raw, all columns]'} ===`);
  console.log('compared columns:', count, '/', nxg * nyg, ignoreHeldStock ? `(excluded as expected held stock: ${excludedHeldStock})` : '');
  console.log('mean abs error (mm):', (sumAbs / count).toFixed(3));
  console.log('max abs error (mm):', maxAbs.toFixed(3), 'at', maxAt);
  console.log('error histogram: <0.2mm', HIST[0], '| <1mm', HIST[1], '| <3mm', HIST[2], '| <10mm', HIST[3], '| >=10mm', HIST[4]);
  console.log(`  as %% of compared columns: ${HIST.map(v => (100 * v / count).toFixed(1) + '%').join(', ')}`);
}
run(false);
console.log();
run(true);
