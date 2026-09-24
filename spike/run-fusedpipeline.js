// Ground-truth test of the FULL combined pipeline (tri-dexel for exactly-aligned planes + the
// pre-existing per-plane oblique fallback for everything else, fused into one mesh) against the
// real PART.stl, for both jobs. This replaces round 3's "snap everything within tolDeg=60" with
// "only ever use tri-dexel for planes that are ACTUALLY aligned (engine.js's own tiny default
// tolerance); cut everything else through its own real tilted axis instead."
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const { buildFused, fuseCombined } = require('./fusedpipeline.js');

function runJob(name, ncPath, setupPath, stockPath, partPath) {
  const t0 = Date.now();
  const real = NC.parseProgram(fs.readFileSync(ncPath, 'utf8'));
  const setupText = fs.readFileSync(setupPath, 'utf8');
  const stockBuf = fs.readFileSync(stockPath);
  const partBuf = fs.readFileSync(partPath);
  const parsed = NC.parseCimcoSetup(setupText);
  NC.applyCimcoTools(parsed, real.tools);
  const meshes = { stock: NC.parseStlBinary(stockBuf), part: NC.parseStlBinary(partBuf) };
  const result = NC.cimcoToFloorsimSetup(parsed, meshes, name);
  const s = result.setup;
  const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
  const partMesh = result.partMesh;

  const target = 360;
  // tolDeg=5: swallows Fusion's floating-point setup noise (O1160's planes 2-7 are all <2.2deg,
  // clearly not real tilts) without accepting a real tilt (O1160 plane 1 is 14.66deg, plane 8 is
  // ~15deg from its nearest axis - both correctly rejected and sent to the oblique fallback).
  const built = buildFused(real, stockBox, target, 5);
  console.log(`${name}: tri-dexel grids=${[...built.td.grids.keys()]}  oblique planes=${[...built.obliqueSims.keys()]}`);
  console.log(`  cut counts: aligned=${built.alignedCut}  oblique=${built.obliqueCut}  noSim=${built.noSim}`);
  const { pos, idx } = fuseCombined(built, target);
  console.log(`  mesh: ${pos.length / 3} verts, ${idx.length / 3} tris, built in ${Date.now() - t0}ms`);

  const nxg = 360, nyg = Math.round(360 * (stockBox.ymax - stockBox.ymin) / (stockBox.xmax - stockBox.xmin));
  const gx0 = stockBox.xmin, gy0 = stockBox.ymin, gdx = (stockBox.xmax - stockBox.xmin) / nxg, gdy = (stockBox.ymax - stockBox.ymin) / nyg;
  const gridShape = { nx: nxg, ny: nyg, dx: gdx, dy: gdy, x0: gx0, y0: gy0 };
  const simMesh = { pos, idx };
  const simBins = binTriangles(simMesh, gridShape);
  const partBins = binTriangles(partMesh, gridShape);
  let count = 0, sumAbs = 0, maxAbs = 0, maxAt = null;
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
      count++; const ae = Math.abs(e); sumAbs += ae; if (ae > maxAbs) { maxAbs = ae; maxAt = [px.toFixed(1), py.toFixed(1)]; }
      if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
    }
  }
  console.log(`=== ${name} (full pipeline: tri-dexel + real oblique fallback) vs real PART.stl ===`);
  console.log('compared columns:', count, '/', nxg * nyg);
  console.log('mean abs error (mm):', (sumAbs / count).toFixed(3));
  console.log('max abs error (mm):', maxAbs.toFixed(3), 'at', maxAt);
  console.log('error histogram: <0.2mm', HIST[0], '| <1mm', HIST[1], '| <3mm', HIST[2], '| <10mm', HIST[3], '| >=10mm', HIST[4]);
  console.log(`  as %% of compared columns: ${HIST.map(v => (100 * v / count).toFixed(1) + '%').join(', ')}`);
  console.log();
  fs.writeFileSync(path.join(__dirname, `out-fusedpipeline-${name}.json`), JSON.stringify({ pos: Array.from(pos), idx: Array.from(idx), box: stockBox }));
}

const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
runJob('O1160', DIR + 'O1160.NC', DIR + 'O1160.setup', DIR + 'O1160_STOCK.stl', DIR + 'O1160_PART.stl');
runJob('O1224', path.join(ROOT, 'fixtures', 'O1224.NC'), path.join(ROOT, 'fixtures', 'cimco', 'O1224.setup'), path.join(ROOT, 'fixtures', 'cimco', 'O1224_STOCK.stl'), path.join(ROOT, 'fixtures', 'cimco', 'O1224_PART.stl'));
