'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { cutMoveWorld, makeAxisFrame, cylinderZLowOverMove } = require('./worlddexel.js');
const { compareToPart } = require('./compareToPart.js');

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

const target = 360;
const W = stockBox.xmax - stockBox.xmin, H = stockBox.ymax - stockBox.ymin;
const c = Math.max(W, H) / target;
const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c));
const dx = W / nx, dy = H / ny, x0 = stockBox.xmin, y0 = stockBox.ymin;
const grid = { nx, ny, dx, dy, x0, y0, zBot: stockBox.zbot, zTop: stockBox.ztop, h: new Float32Array(nx * ny).fill(stockBox.ztop), op: new Int32Array(nx * ny) };

const w = NC.worldizeMoves(real);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));

for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  cutMoveWorld(grid, ax, ay, az, w.Xw[i], w.Yw[i], w.Zw[i], a, T, real.OP[i] + 1, 40);
}

const stats = compareToPart(grid, partMesh);
console.log('mean', stats.meanAbs.toFixed(2), 'max', stats.maxAbs.toFixed(2));

// Which PLANE is responsible for the bad columns? Group bad (>=10mm error) columns by which
// plane's op index actually wrote the winning height there (grid.op only stores opId - map
// back to plane via P.PL at that move index... but we didn't keep a move index. Instead, track
// which plane touches which columns as a SEPARATE pass, so we can correlate).
const opToPlane = new Map();
for (let i = 0; i < real.n; i++) if (real.K[i]) opToPlane.set(real.OP[i] + 1, real.PL[i]);

const badByPlane = new Map(), totalByPlane = new Map();
for (let idx = 0; idx < grid.h.length; idx++) {
  const e = stats.err[idx];
  if (Number.isNaN(e)) continue;
  const pl = opToPlane.get(grid.op[idx]);
  totalByPlane.set(pl, (totalByPlane.get(pl) || 0) + 1);
  if (Math.abs(e) >= 10) badByPlane.set(pl, (badByPlane.get(pl) || 0) + 1);
}
console.log('bad(>=10mm)/total columns, by which plane last wrote that column:');
for (const [pl, tot] of [...totalByPlane].sort((a, b) => a[0] - b[0])) {
  console.log(`  plane ${pl}: ${badByPlane.get(pl) || 0} / ${tot} (${(100 * (badByPlane.get(pl) || 0) / tot).toFixed(1)}%)`);
}

// Trace the single worst column same as the O1160 diagnostic.
const [cx, cy] = [stats.maxAbsAt[0], stats.maxAbsAt[1]];
console.log('\ntracing worst column', cx, cy, 'sim=', stats.maxAbsAt[2], 'real=', stats.maxAbsAt[3]);
let curH = stockBox.ztop;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  const bx = w.Xw[i], by = w.Yw[i], bz = w.Zw[i];
  const R = T.R;
  if (Math.min(ax, bx) - R > cx || Math.max(ax, bx) + R < cx) continue;
  if (Math.min(ay, by) - R > cy || Math.max(ay, by) + R < cy) continue;
  const frame = makeAxisFrame(a, [ax, ay, az], [bx - ax, by - ay, bz - az], cx, cy);
  const L2 = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2;
  const short = L2 < (R * 1.5) * (R * 1.5);
  const zLow = short ? cylinderZLowOverMove(frame, R, 1e6, 8, 0) : cylinderZLowOverMove(frame, R, 1e6, 40);
  if (zLow === null) continue;
  const clamped = Math.max(zLow, stockBox.zbot);
  if (clamped < curH) {
    curH = clamped;
    console.log(`move ${i}: op ${real.OP[i]} tool T${real.TL[i]} plane ${real.PL[i]} axis ${a.map(v => v.toFixed(3))} -> curH ${curH.toFixed(3)} A=(${ax.toFixed(2)},${ay.toFixed(2)},${az.toFixed(2)}) B=(${bx.toFixed(2)},${by.toFixed(2)},${bz.toFixed(2)}) R=${R.toFixed(3)}`);
  }
}
console.log('final:', curH, 'vs real', stats.maxAbsAt[3]);
