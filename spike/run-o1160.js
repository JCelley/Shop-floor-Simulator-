// Real-job test: does fusing every plane's already-correct per-plane HeightSim into one
// shared world grid actually produce a single continuous wedge for O1160, instead of the
// disconnected boxes the current renderer shows? Reads directly from the shared drive (real
// customer job data - never copied into the repo). Writes a heightmap PNG-ish text summary
// and a real three.js render via the existing dist/nc-floor-sim.html's own three.js copy.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { fusePlanesToWorldGrid } = require('./fuse.js');
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const t0 = Date.now();
const ncText = fs.readFileSync(DIR + 'O1160.NC', 'utf8');
const real = NC.parseProgram(ncText);
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const meshes = { stock: NC.parseStlBinary(stockBuf) };
const result = NC.cimcoToFloorsimSetup(parsed, meshes, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
console.log('real stock box (mm):', stockBox);
console.log('planes:', real.planes.length, 'moves:', real.n);

// Build EVERY plane (not just the oblique ones) via the existing, already-correct
// buildPlaneSims/cutMoveMulti - no change to the cutting math, just using it for all planes
// uniformly instead of splitting aligned vs oblique.
const target = 360;
const sims = NC.buildPlaneSims(real, stockBox, target); // pad defaults to 5mm for non-zero planes
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const tCut0 = Date.now();
for (let i = 0; i < real.n; i++) NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
console.log('cut', real.n, 'moves in', Date.now() - tCut0, 'ms');

const planes = [];
for (const pl of real.planes) {
  const sim = sims.get(pl.id);
  if (!sim) continue;
  planes.push({ matrix: pl.matrix, origin: pl.origin, sim, id: pl.id });
}
console.log('planes with sims:', planes.length);

const tFuse0 = Date.now();
const fused = fusePlanesToWorldGrid(planes, stockBox, target, 20);
console.log('fused', fused.nx, 'x', fused.ny, 'grid in', Date.now() - tFuse0, 'ms');

// Sanity: how much of the grid is still at the untouched stock top (never reached by any
// plane) vs actually cut? A wedge covering most of the top should leave little untouched.
let untouched = 0, cut = 0, minH = Infinity, maxH = -Infinity;
for (const v of fused.h) { if (v === fused.zTop) untouched++; else cut++; if (v < minH) minH = v; if (v > maxH) maxH = v; }
console.log(`untouched cells: ${untouched} (${(100 * untouched / fused.h.length).toFixed(1)}%), cut: ${cut}, height range ${minH.toFixed(2)}..${maxH.toFixed(2)} (stock ${fused.zBot}..${fused.zTop})`);

// contributor histogram: which plane index "won" how many cells (diagnostic - confirms
// multiple planes are actually contributing, not just plane 0 dominating everywhere)
const hist = new Map();
for (const k of fused.contributors) hist.set(k, (hist.get(k) || 0) + 1);
console.log('winning-plane histogram (planeIndex: cellCount, -1 = untouched):');
for (const [k, c] of [...hist].sort((a, b) => a[0] - b[0])) console.log(' ', k === -1 ? 'untouched' : `plane[${k}] (id ${planes[k].id})`, c);

const { pos, idx } = NC.meshFromHeightArray(fused.nx, fused.ny, fused.dx, fused.dy, fused.x0, fused.y0, fused.h);
console.log('fused mesh:', pos.length / 3, 'vertices,', idx.length / 3, 'triangles');

fs.writeFileSync(path.join(__dirname, 'out-o1160-fused.json'), JSON.stringify({
  nx: fused.nx, ny: fused.ny, dx: fused.dx, dy: fused.dy, x0: fused.x0, y0: fused.y0,
  zTop: fused.zTop, zBot: fused.zBot, box: stockBox,
  pos: Array.from(pos), idx: Array.from(idx), h: Array.from(fused.h),
  contributors: Array.from(fused.contributors), planeIds: planes.map(p => p.id),
}));
console.log('wrote spike/out-o1160-fused.json');
console.log('total time', Date.now() - t0, 'ms');
