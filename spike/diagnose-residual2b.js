// (33.91,-19.35) e=-23.92 traced to Z+ (the ordinary aligned floor grid) itself excluding material
// at the REAL design's height (87.87, near full stock) - meaning plane 1/8 are NOT responsible for
// this specific gouge at all; some ordinary aligned move cut this column down to 63.95 on its own.
// Replay ONLY the aligned (Z+) cutting moves and find exactly which move last set this column's
// height, using the real exact HeightSim.cut (not an approximation).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
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

const target = 360;
const td = NC.buildTriDexel(real, target, 5, stockBox, 5); // same tolDeg as the fixed pipeline
console.log('tri-dexel grids:', [...td.grids.keys()]);
const zGrid = td.grids.get('Z+');
const cx = 33.91, cy = -19.35;
const ci = Math.floor((cx - zGrid.x0) / zGrid.dx), cj = Math.floor((cy - zGrid.y0) / zGrid.dy);
console.log('column', ci, cj, 'center', (zGrid.x0 + (ci + 0.5) * zGrid.dx).toFixed(2), (zGrid.y0 + (cj + 0.5) * zGrid.dy).toFixed(2));

const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
let prevH = zGrid.h[cj * zGrid.nx + ci];
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  if (!td.keyOfMove[i]) continue; // oblique, not this grid
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
  const h = zGrid.h[cj * zGrid.nx + ci];
  if (h < prevH - 1e-6) {
    console.log(`move ${i}: plane ${real.PL[i]} tool T${real.TL[i]} (R=${T.R}, kind=${T.kind}) op ${real.OP[i]} -> column height ${prevH.toFixed(3)} -> ${h.toFixed(3)}`);
    prevH = h;
  }
}
console.log('final Z+ height at this column:', zGrid.h[cj * zGrid.nx + ci], '(real part wants ~87.87, near stock top', stockBox.ztop, ')');
