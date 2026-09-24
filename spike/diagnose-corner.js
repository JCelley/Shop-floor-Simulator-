// O1160 only uses two signed grids: Z+ (the floor/pockets/holes, ordinary vertical cutting) and
// X+ (the one wall whose real tool axis snapped to +X - the visibly angled wall in the
// screenshots). The fused mesh is solid only where BOTH grids agree ("boolean AND" - see
// triSampleSolid's comment: a grid outside its own footprint returns true, "no information,
// don't exclude"). The two bad clusters (y~+24 "extra material", y~-24 "gouge") sit at the two
// ends of that wall, spanning a range of X - exactly where the X+ wall's grid and the Z+ floor's
// grid transition into each other. This probes BOTH grids directly at representative bad points
// to see which one is actually wrong, instead of guessing.
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

const td = NC.buildTriDexel(real, 360, 5, stockBox, 60);
console.log('grids used:', [...td.grids.keys()]);
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
let movesByKey = { 'Z+': 0, 'X+': 0 };
for (let i = 0; i < real.n; i++) {
  if (!real.K[i]) continue;
  const T = simTools.get(real.TL[i]);
  if (!T || T.undercut) continue;
  const key = td.keyOfMove[i];
  if (key) movesByKey[key] = (movesByKey[key] || 0) + 1;
  NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
}
console.log('moves per grid:', movesByKey);

const zGrid = td.grids.get('Z+'), xGrid = td.grids.get('X+');

// Report what EACH grid, independently, thinks the top surface is at a world (wx,wy) - not the
// fused/AND result, the raw per-grid opinion, exactly as triSampleSolid would read it.
function probeZ(wx, wy) {
  const i = Math.floor((wx - zGrid.x0) / zGrid.dx), j = Math.floor((wy - zGrid.y0) / zGrid.dy);
  if (i < 0 || j < 0 || i >= zGrid.nx || j >= zGrid.ny) return { covered: false };
  return { covered: true, h: zGrid.h[j * zGrid.nx + i], zBot: zGrid.zBot, i, j };
}
// X+ grid's local frame (from buildTriDexel: axisIdx=0 -> box{xmin:ymin,xmax:ymax,ymin:zmin,ymax:zmax}, local ax=wy, ay=wz, az=wx).
// Its "h" is a MAX-X bound (world x <= h), and it only has an opinion for (wy,wz) inside its own box.
function probeX(wx, wy, wz) {
  const ax = wy, ay = wz;
  const i = Math.floor((ax - xGrid.x0) / xGrid.dx), j = Math.floor((ay - xGrid.y0) / xGrid.dy);
  if (i < 0 || j < 0 || i >= xGrid.nx || j >= xGrid.ny) return { covered: false };
  return { covered: true, h: xGrid.h[j * xGrid.nx + i], zBot: xGrid.zBot, i, j }; // h/zBot here are along world X
}

const points = [
  { label: 'gouge cluster (sim too LOW)', x: -18.80, y: -24.59, simZ: 65.92, realZ: 75.95 },
  { label: 'gouge cluster (max err)', x: 32.82, y: -23.06, simZ: 65.70, realZ: 87.87 },
  { label: 'extra-material cluster (sim too HIGH)', x: 42.66, y: 24.37, simZ: 87.13, realZ: 75.69 },
];

for (const p of points) {
  console.log(`\n--- ${p.label}: world (${p.x}, ${p.y})  sim=${p.simZ}  real=${p.realZ} ---`);
  const zp = probeZ(p.x, p.y);
  console.log('  Z+ grid (floor):', zp.covered ? `h(top bound)=${zp.h.toFixed(2)}  zBot=${zp.zBot.toFixed(2)}  cell(${zp.i},${zp.j})` : 'OUTSIDE this grid\'s footprint (no opinion, defaults solid)');
  // For the X+ grid we need a wz to test against (its own "az" coordinate is world z, its column
  // is keyed by (wy, wz) - so we must supply a wz; test across the full real Z range in a few steps
  // to see over what Z band the X+ grid actually constrains this (wx,wy) at all.
  console.log('  X+ grid (angled wall), scanning wz from stock bottom to top:');
  for (let wz = stockBox.zbot; wz <= stockBox.ztop + 1e-6; wz += (stockBox.ztop - stockBox.zbot) / 10) {
    const xp = probeX(p.x, p.y, wz);
    if (!xp.covered) { console.log(`    wz=${wz.toFixed(1)}: OUTSIDE X+ grid footprint`); continue; }
    console.log(`    wz=${wz.toFixed(1)}: X+ says world-X must be <= ${xp.h.toFixed(2)} (test point x=${p.x}) -> ${p.x <= xp.h + 1e-4 ? 'ALLOWS (solid)' : 'EXCLUDES (empty)'}  [cell ${xp.i},${xp.j}]`);
  }
}
