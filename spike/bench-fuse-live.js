// Feasibility check: is the combined (tri-dexel + clipped oblique) AND-fusion fast enough to run
// at the app's LIVE playback resolution/throttle (TRI_FUSE_LIVE=80, re-fused at most every
// TRI_FUSE_MIN_MS=150ms), or does adding oblique sims to the voxelization blow that budget? If it
// does, the single-fused-mesh approach isn't usable for live incremental removal and shouldn't be
// adopted - that's the real go/no-go question here, not just correctness.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { buildFused, fuseCombined } = require('./fusedpipeline.js');

const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';
const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };

const buildTarget = 360; // the actual cutting/grid resolution used regardless of mesh target
const built = buildFused(real, stockBox, buildTarget, 5); // cut ALL moves once, like prepass does
console.log('grids:', [...built.td.grids.keys()], 'oblique planes:', [...built.obliqueSims.keys()]);

// Compare: plain tri-dexel-only fuse (today's real app.js call) vs combined AND-fuse, at the LIVE
// mesh target (80), simulating what refreshTriStock(true) would cost each throttled re-fuse.
function timeIt(label, fn, n) {
  const t0 = Date.now();
  for (let k = 0; k < n; k++) fn();
  const ms = (Date.now() - t0) / n;
  console.log(`${label}: ${ms.toFixed(1)}ms/call (avg of ${n})`);
  return ms;
}
timeIt('fuseTriDexel alone (today\'s live re-fuse), target=80', () => NC.fuseTriDexel(built.td, 80), 5);
timeIt('fuseCombined (tri-dexel + clipped oblique), target=80', () => fuseCombined(built, 80), 5);
timeIt('fuseTriDexel alone, target=140 (settled/TRI_FUSE_TARGET)', () => NC.fuseTriDexel(built.td, 140), 3);
timeIt('fuseCombined, target=140 (settled)', () => fuseCombined(built, 140), 3);
