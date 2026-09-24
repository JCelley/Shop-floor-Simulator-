'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { cutMoveWorld, makeAxisFrame, cylinderZLowOverMove } = require('./worlddexel.js');
const DIR = 'G:\\Shared drives\\APW\\Posted Programs - UNPROVEN\\';

const real = NC.parseProgram(fs.readFileSync(DIR + 'O1160.NC', 'utf8'));
const setupText = fs.readFileSync(DIR + 'O1160.setup', 'utf8');
const stockBuf = fs.readFileSync(DIR + 'O1160_STOCK.stl');
const parsed = NC.parseCimcoSetup(setupText);
NC.applyCimcoTools(parsed, real.tools);
const result = NC.cimcoToFloorsimSetup(parsed, { stock: NC.parseStlBinary(stockBuf) }, 'O1160');
const s = result.setup;
const stockBox = { xmin: s.stock.xmin, xmax: s.stock.xmax, ymin: s.stock.ymin, ymax: s.stock.ymax, zbot: s.stock.zmin, ztop: s.stock.zmax };

const target = 360;
const W = stockBox.xmax - stockBox.xmin, H = stockBox.ymax - stockBox.ymin;
const c = Math.max(W, H) / target;
const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c));
const dx = W / nx, dy = H / ny, x0 = stockBox.xmin, y0 = stockBox.ymin;

const w = NC.worldizeMoves(real);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
const planeAxis = new Map(real.planes.map(p => [p.id, NC.planeAxisWorld(p.matrix)]));

// The bad column, from the comparison run.
const cx = 33.91252827909258, cy = -21.96995750802462;
const iCol = Math.floor((cx - x0) / dx), jCol = Math.floor((cy - y0) / dy);
console.log('column', iCol, jCol, 'center', x0 + (iCol + 0.5) * dx, y0 + (jCol + 0.5) * dy);

// Replay every real cutting move, and report the move(s) that push this ONE column's height
// down close to (or below) the bad value (65.87) - track the single deepest-so-far and log
// whenever a new move drives it below some threshold.
let curH = stockBox.ztop;
let worstMove = -1, worstOp = -1, worstTool = -1, worstPlane = -1;
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  const a = planeAxis.get(real.PL[i]);
  const ax = i > 0 ? w.Xw[i - 1] : w.init.x, ay = i > 0 ? w.Yw[i - 1] : w.init.y, az = i > 0 ? w.Zw[i - 1] : w.init.z;
  const bx = w.Xw[i], by = w.Yw[i], bz = w.Zw[i];
  // does this move's bounding box even reach the test column?
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
    worstMove = i; worstOp = real.OP[i]; worstTool = real.TL[i]; worstPlane = real.PL[i];
    if (curH < 70) console.log(`move ${i}: op ${real.OP[i]} tool T${real.TL[i]} plane ${real.PL[i]} axis ${a.map(v=>v.toFixed(3))} -> curH ${curH.toFixed(3)} (move A=(${ax.toFixed(2)},${ay.toFixed(2)},${az.toFixed(2)}) B=(${bx.toFixed(2)},${by.toFixed(2)},${bz.toFixed(2)}) R=${R})`);
  }
}
console.log('final height at this column:', curH, '(real part says 87.87)');
