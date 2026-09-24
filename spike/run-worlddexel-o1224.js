'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { cutMoveWorld } = require('./worlddexel.js');

const t0 = Date.now();
const real = NC.parseProgram(fs.readFileSync(path.join(ROOT, 'fixtures', 'O1224.NC'), 'utf8'));
const setupText = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224.setup'), 'utf8');
const stockBuf = fs.readFileSync(path.join(ROOT, 'fixtures', 'cimco', 'O1224_STOCK.stl'));
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1224');
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
  h: new Float32Array(nx * ny).fill(stockBox.ztop), op: new Int32Array(nx * ny),
};

const w = NC.worldizeMoves(real);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));

let cutMoves = 0, skippedUndercut = 0;
const tCut0 = Date.now();
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T) continue;
  if (T.undercut) { skippedUndercut++; continue; }
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  cutMoveWorld(grid, ax, ay, az, w.Xw[i], w.Yw[i], w.Zw[i], a, T, real.OP[i] + 1, 40);
  cutMoves++;
}
const cutMs = Date.now() - tCut0;
console.log('cut', cutMoves, 'moves (', skippedUndercut, 'undercut skipped) in', cutMs, 'ms =', (cutMs / cutMoves).toFixed(4), 'ms/move');

const { pos, idx } = NC.meshFromHeightArray(grid.nx, grid.ny, grid.dx, grid.dy, grid.x0, grid.y0, grid.h);
fs.writeFileSync(path.join(__dirname, 'out-worlddexel-o1224.json'), JSON.stringify({ pos: Array.from(pos), idx: Array.from(idx), box: stockBox }));
console.log('mesh:', pos.length / 3, 'verts', idx.length / 3, 'tris');
console.log('total time', Date.now() - t0, 'ms');
