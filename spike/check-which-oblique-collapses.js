// Isolate whether plane 1 or plane 8 (or both) is causing the oblique-fallback local-frame boxes
// to wrongly overlap and exclude territory that belongs to the shared Z+ floor grid.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const NC = require(path.join(ROOT, 'src', 'engine.js'));
const { binTriangles, partHeightAt } = require('./compareToPart.js');
const { triSolid, obliqueSolid } = require('./fusedpipeline.js');

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
const partMesh = result.partMesh;
const target = 360;

function test(obliqueSet) {
  const td = NC.buildTriDexel(real, target, 5, stockBox, 5);
  const obliqueIds = new Set(obliqueSet);
  const obliqueSims = NC.buildPlaneSims(real, stockBox, target, 5, obliqueIds);
  const planeById = new Map(real.planes.map(p => [p.id, p]));
  const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
  for (let i = 0; i < real.n; i++) {
    if (!real.K[i]) continue;
    const T = simTools.get(real.TL[i]);
    if (!T || T.undercut) continue;
    if (obliqueIds.has(real.PL[i])) { if (obliqueSims.has(real.PL[i])) NC.cutMoveMulti(obliqueSims, real, simTools, i, 0, 1); }
    else if (td.keyOfMove[i]) NC.cutTriDexelMove(td, real, simTools, i, 0, 1);
  }
  for (const [id, sim] of obliqueSims) console.log(`  plane ${id} local box:`, sim.box, 'nx,ny', sim.nx, sim.ny);

  // voxelize
  const box = td.box;
  const W = box.xmax - box.xmin, H = box.ymax - box.ymin, D = box.zmax - box.zmin;
  const c = Math.max(W, H, D) / target;
  const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c)), nz = Math.max(8, Math.round(D / c));
  const gridEntries = [...td.grids.entries()].map(([key, grid]) => ({ axisIdx: 'XYZ'.indexOf(key[0]), sign: key[1] === '+' ? 1 : -1, grid }));
  const obliqueEntries = [...obliqueSims.entries()].map(([id, sim]) => ({ matrix: planeById.get(id).matrix, origin: planeById.get(id).origin, sim }));
  let solidCount = 0, excludedByOblique = 0, total = 0;
  const occ = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const wz = box.zmin + (k + 0.5) * c;
    for (let j = 0; j < ny; j++) {
      const wy = box.ymin + (j + 0.5) * c;
      for (let i = 0; i < nx; i++) {
        const wx = box.xmin + (i + 0.5) * c;
        total++;
        let solidGrids = true;
        for (const e of gridEntries) { if (!triSolid(e.grid, e.axisIdx, e.sign, wx, wy, wz)) { solidGrids = false; break; } }
        let solid = solidGrids;
        if (solid) for (const e of obliqueEntries) { if (!obliqueSolid(e.sim, e.matrix, e.origin, wx, wy, wz)) { solid = false; break; } }
        if (solidGrids && !solid) excludedByOblique++;
        if (solid) { occ[(k * ny + j) * nx + i] = 1; solidCount++; }
      }
    }
  }
  console.log(`  voxels: total=${total} solidAfterGrids-onlyCheck N/A, finalSolid=${solidCount}, excludedONLYByOblique=${excludedByOblique}`);
}

console.log('--- oblique = {1} only (plane 8 forced into tri-dexel via wide box test not done here, just excluded from cutting - for isolation only) ---');
test([1]);
console.log('--- oblique = {8} only ---');
test([8]);
console.log('--- oblique = {1,8} ---');
test([1, 8]);
