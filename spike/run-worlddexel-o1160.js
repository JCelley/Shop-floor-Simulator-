// Real-job test: cut EVERY move (any plane, any tool axis) directly into ONE shared world grid,
// in true program order, using the generalized cylinder swept-volume math - no per-plane sims,
// no fusion/precedence step at all. This is the harder, more valuable half of the "real rewrite":
// does removing the whole fuse-after-the-fact architecture (and its bugs) actually work, and is
// it fast enough on a real job?
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { cutMoveWorld } = require('./worlddexel.js');
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const t0 = Date.now();
const ncText = fs.readFileSync(DIR + 'O1160.NC', 'utf8');
const real = NC.parseProgram(ncText);
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };
console.log('planes:', real.planes.length, 'moves:', real.n);

const target = 360;
const W = stockBox.xmax - stockBox.xmin, H = stockBox.ymax - stockBox.ymin;
const c = Math.max(W, H) / target;
const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c));
const grid = {
  nx, ny, dx: W / nx, dy: H / ny, x0: stockBox.xmin, y0: stockBox.ymin,
  zBot: stockBox.zbot, zTop: stockBox.ztop,
  h: new Float32Array(nx * ny).fill(stockBox.ztop),
  op: new Int32Array(nx * ny),
};
console.log('grid', nx, 'x', ny);

const w = NC.worldizeMoves(real);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));

// Skip undercut tools entirely for this pass (out of scope here - see file header); everything
// else (the ordinary bull-nose/flat end mills that actually shape O1160's wedge) goes through
// the generalized cylinder cut, using each tool's FULL radius (bull-nose corner rounding is not
// modelled exactly yet).
let cutMoves = 0, skippedUndercut = 0;
const tCut0 = Date.now();
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue; // rapids never cut
  const T = simTools.get(real.TL[i]);
  if (!T) continue;
  if (T.undercut) { skippedUndercut++; continue; }
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  cutMoveWorld(grid, ax, ay, az, w.Xw[i], w.Yw[i], w.Zw[i], a, T, real.OP[i] + 1, 14);
  cutMoves++;
}
const cutMs = Date.now() - tCut0;
console.log('cut', cutMoves, 'moves (', skippedUndercut, 'undercut moves skipped) in', cutMs, 'ms =', (cutMs / cutMoves).toFixed(4), 'ms/move');

let untouched = 0, minH = Infinity, maxH = -Infinity;
for (const v of grid.h) { if (v === grid.zTop) untouched++; if (v < minH) minH = v; if (v > maxH) maxH = v; }
console.log(`untouched: ${(100 * untouched / grid.h.length).toFixed(1)}%, height range ${minH.toFixed(2)}..${maxH.toFixed(2)} (stock ${grid.zBot.toFixed(2)}..${grid.zTop.toFixed(2)})`);

const { pos, idx } = NC.meshFromHeightArray(grid.nx, grid.ny, grid.dx, grid.dy, grid.x0, grid.y0, grid.h);
fs.writeFileSync(path.join(__dirname, 'out-worlddexel-o1160.json'), JSON.stringify({
  nx: grid.nx, ny: grid.ny, dx: grid.dx, dy: grid.dy, x0: grid.x0, y0: grid.y0,
  box: stockBox, pos: Array.from(pos), idx: Array.from(idx),
}));
console.log('mesh:', pos.length / 3, 'verts', idx.length / 3, 'tris');
console.log('total time', Date.now() - t0, 'ms');
