// Performance stress test for the multi-interval approach (spike/multidexel.js) at a move
// count representative of a real undercut operation - T81 in the real O1224 job only has 302
// moves (too small to be a meaningful stress test), so this builds a synthetic dense raster
// toolpath instead, sized similarly to a real finishing pass, and measures wall-clock time.
'use strict';
const { cutMoveIntervals } = require('./multidexel.js');

// A representative lollipop profile: ball nose (radius R) from the tip up to the equator,
// approximated with several points along the circular arc, then a thinner neck above it -
// the actual undercut shape (this is NOT T81's exact real geometry, just representative).
function lollipopProfile(R, neckR, neckLen) {
  const pts = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2); // 0 (tip) to 90deg (equator)
    pts.push([R - R * Math.cos(a), R * Math.sin(a)]);
  }
  pts.push([R + neckLen, neckR]);
  return pts;
}
const profile = lollipopProfile(2.38, 1.5, 5); // ~T81-scale (D=4.76mm), representative

const box = { xmin: -30, xmax: 30, ymin: -20, ymax: 20, zbot: 0, ztop: 20 };
const target = 360;
const W = box.xmax - box.xmin, H = box.ymax - box.ymin;
const c = Math.max(W, H) / target, nx = Math.round(W / c), ny = Math.round(H / c);
const dx = W / nx, dy = H / ny, x0 = box.xmin, y0 = box.ymin;
console.log('grid', nx, 'x', ny, '=', nx * ny, 'columns');

const grid = new Map();
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid.set(i + ',' + j, [[box.zbot, box.ztop]]);

// Dense raster: rows 0.3mm apart (typical finishing stepover) across the whole box, at a
// fixed depth - a real finishing pass shape, moves are short (stepover-sized).
const rows = Math.round(H / 0.3);
const moves = [];
for (let r = 0; r < rows; r++) {
  const y = box.ymin + 2 + r * (H - 4) / rows;
  const dir = r % 2 === 0 ? 1 : -1;
  const xa = dir > 0 ? box.xmin + 2 : box.xmax - 2, xb = dir > 0 ? box.xmax - 2 : box.xmin + 2;
  moves.push([xa, y, box.ztop - 10, xb, y, box.ztop - 10]);
}
console.log('moves:', moves.length);

for (const samples of [2, 6]) {
  // fresh grid each timing run
  const g2 = new Map(); for (const [k, v] of grid) g2.set(k, [v[0].slice()]);
  const t0 = Date.now();
  for (const [ax, ay, az, bx, by, bz] of moves) cutMoveIntervals(g2, nx, ny, dx, dy, x0, y0, ax, ay, az, bx, by, bz, profile, samples);
  const ms = Date.now() - t0;
  let totalIntervals = 0, multiInterval = 0;
  for (const v of g2.values()) { totalIntervals += v.length; if (v.length > 1) multiInterval++; }
  console.log(`samples=${samples}: ${ms}ms for ${moves.length} moves (${(ms / moves.length).toFixed(3)}ms/move), ${multiInterval} columns ended up with >1 interval (real overhangs), avg ${(totalIntervals / g2.size).toFixed(2)} intervals/column`);
}
