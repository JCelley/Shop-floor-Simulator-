// Cross-check + bigger performance data point: apply the SAME general fusion (every plane
// through buildPlaneSims, then fused into one shared grid) to O1224 - a harder real job
// (44,526 tilted-plane moves vs O1160's 5,716) that already has a known-good tri-dexel/
// per-plane render to sanity-check against. Uses the real fixture files already in this repo
// (not customer-drive data), so this one's fine to keep as a committed spike script.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { fusePlanesToWorldGrid } = require('./fuse.js');
const DIR = path.join(ROOT, 'fixtures');

const t0 = Date.now();
const ncText = fs.readFileSync(path.join(DIR, 'O1224.NC'), 'utf8');
const real = NC.parseProgram(ncText);
const setupText = fs.readFileSync(path.join(DIR, 'cimco', 'O1224.setup'), 'utf8');
const stockBuf = fs.readFileSync(path.join(DIR, 'cimco', 'O1224_STOCK.stl'));
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1224');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
console.log('planes:', real.planes.length, 'moves:', real.n);

const target = 360;
const sims = NC.buildPlaneSims(real, stockBox, target);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const tCut0 = Date.now();
for (let i = 0; i < real.n; i++) NC.cutMoveMulti(sims, real, simTools, i, 0, 1);
console.log('cut', real.n, 'moves in', Date.now() - tCut0, 'ms');

const planes = [];
for (const pl of real.planes) { const sim = sims.get(pl.id); if (sim) planes.push({ matrix: pl.matrix, origin: pl.origin, sim, id: pl.id }); }

const tFuse0 = Date.now();
const fused = fusePlanesToWorldGrid(planes, stockBox, target, 20);
console.log('fused', fused.nx, 'x', fused.ny, 'grid in', Date.now() - tFuse0, 'ms');

let untouched = 0;
for (const v of fused.h) if (v === fused.zTop) untouched++;
console.log(`untouched: ${(100 * untouched / fused.h.length).toFixed(1)}%`);
const hist = new Map();
for (const k of fused.contributors) hist.set(k, (hist.get(k) || 0) + 1);
for (const [k, c] of [...hist].sort((a, b) => a[0] - b[0])) console.log(' ', k === -1 ? 'untouched' : `plane[${k}] (id ${planes[k].id})`, c);

const { pos, idx } = NC.meshFromHeightArray(fused.nx, fused.ny, fused.dx, fused.dy, fused.x0, fused.y0, fused.h);
fs.writeFileSync(path.join(__dirname, 'out-o1224-fused.json'), JSON.stringify({
  nx: fused.nx, ny: fused.ny, dx: fused.dx, dy: fused.dy, x0: fused.x0, y0: fused.y0,
  zTop: fused.zTop, zBot: fused.zBot, box: stockBox, pos: Array.from(pos), idx: Array.from(idx),
}));
console.log('mesh:', pos.length / 3, 'verts', idx.length / 3, 'tris');
console.log('total time', Date.now() - t0, 'ms');
