// Full combined pipeline: tri-dexel (world-frame per-axis grids) for planes that are genuinely,
// exactly aligned to a world axis (default tiny tolerance - NOT the round-3 tolDeg=60 snap), plus
// the pre-existing per-plane oblique fallback (buildPlaneSims/cutMoveMulti, each in its own local
// frame with its own real tilted axis) for everything else, fused into ONE watertight mesh by
// voxelizing both representations into the same 3D grid and ANDing them together (a plane with no
// opinion at a given point - outside its own footprint - imposes no constraint, same convention
// tri-dexel's own triSampleSolid already uses). This exists to test the hypothesis from
// spike/NOTES3.md's corner-cluster investigation: round 3's "snap everything within tolDeg to the
// nearest world axis" was wrong for O1160's plane 1 (14.66deg real tilt, wrongly cut as if
// vertical) - the actual fix is to NOT snap planes that aren't really aligned, and instead cut
// them correctly via their own real axis (what buildPlaneSims already does, unmodified).
'use strict';
const path = require('path');
const NC = require(path.join(__dirname, '..', 'src', 'engine.js'));

// Same convention as engine.js's internal (unexported) triSampleSolid: true if this ONE signed
// world-axis grid still calls the point solid, treating "outside this grid's footprint" as
// "no opinion, don't exclude" (the grid simply doesn't cover that area).
function triSolid(grid, axisIdx, sign, wx, wy, wz) {
  let ax, ay, az;
  if (axisIdx === 2) { ax = wx; ay = wy; az = sign * wz; }
  else if (axisIdx === 0) { ax = wy; ay = wz; az = sign * wx; }
  else { ax = wz; ay = wx; az = sign * wy; }
  const i = Math.floor((ax - grid.x0) / grid.dx), j = Math.floor((ay - grid.y0) / grid.dy);
  if (i < 0 || j < 0 || i > grid.nx - 1 || j > grid.ny - 1) return true;
  const h = grid.h[j * grid.nx + i];
  const EPS = 1e-4;
  return az <= h + EPS && az >= grid.zBot - EPS;
}

// Same idea, generalized to an oblique plane's own real rotation matrix/origin instead of a world
// axis permutation. sim.h/zBot are in the plane's own LOCAL frame (boxFromMoves' box, matching how
// buildPlaneSims/cutMoveMulti already cut into it) - transform the world test point into that
// local frame first (local = M^T . (world - origin), valid since M is a rotation matrix).
function obliqueSolid(sim, matrix, origin, wx, wy, wz) {
  const dx = wx - origin[0], dy = wy - origin[1], dz = wz - origin[2];
  const lx = matrix[0][0] * dx + matrix[1][0] * dy + matrix[2][0] * dz;
  const ly = matrix[0][1] * dx + matrix[1][1] * dy + matrix[2][1] * dz;
  const lz = matrix[0][2] * dx + matrix[1][2] * dy + matrix[2][2] * dz;
  const i = Math.floor((lx - sim.x0) / sim.dx), j = Math.floor((ly - sim.y0) / sim.dy);
  if (i < 0 || j < 0 || i > sim.nx - 1 || j > sim.ny - 1) return true;
  const h = sim.h[j * sim.nx + i];
  const EPS = 1e-4;
  return lz <= h + EPS && lz >= sim.zBot - EPS;
}

// Builds and cuts the full pipeline for program P, given the real stock box. tolDeg controls
// tri-dexel's aligned/oblique split (default: engine.js's own tiny default, NOT a wide snap).
function buildFused(P, stockBox, target, tolDeg) {
  const td = NC.buildTriDexel(P, target, 5, stockBox, tolDeg);
  const obliqueIds = td.obliqueIds;
  const obliqueSims = NC.buildPlaneSims(P, stockBox, target, 5, obliqueIds);
  const planeById = new Map(P.planes.map(p => [p.id, p]));
  const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));

  let alignedCut = 0, obliqueCut = 0, noSim = 0;
  for (let i = 0; i < P.n; i++) {
    if (!P.K[i]) continue;
    const T = simTools.get(P.TL[i]);
    if (!T || T.undercut) continue;
    if (td.keyOfMove[i]) { NC.cutTriDexelMove(td, P, simTools, i, 0, 1); alignedCut++; }
    else if (obliqueSims.has(P.PL[i])) { NC.cutMoveMulti(obliqueSims, P, simTools, i, 0, 1); obliqueCut++; }
    else noSim++;
  }

  return { td, obliqueSims, planeById, alignedCut, obliqueCut, noSim };
}

// Voxelize the combined result (tri-dexel grids AND oblique per-plane sims) into one watertight
// mesh, same culled-cube-face meshing fuseTriDexel uses (still blocky - that's a separate, already
// -flagged issue, not what this pipeline change is testing).
function fuseCombined(built, target) {
  const { td, obliqueSims, planeById } = built;
  const box = td.box;
  const W = box.xmax - box.xmin, H = box.ymax - box.ymin, D = box.zmax - box.zmin;
  const c = Math.max(W, H, D) / target;
  const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c)), nz = Math.max(8, Math.round(D / c));
  const gridEntries = [...td.grids.entries()].map(([key, grid]) => ({ axisIdx: 'XYZ'.indexOf(key[0]), sign: key[1] === '+' ? 1 : -1, grid }));
  const obliqueEntries = [...obliqueSims.entries()].map(([id, sim]) => ({ matrix: planeById.get(id).matrix, origin: planeById.get(id).origin, sim }));
  const occ = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const wz = box.zmin + (k + 0.5) * c;
    for (let j = 0; j < ny; j++) {
      const wy = box.ymin + (j + 0.5) * c;
      for (let i = 0; i < nx; i++) {
        const wx = box.xmin + (i + 0.5) * c;
        let solid = true;
        for (const e of gridEntries) { if (!triSolid(e.grid, e.axisIdx, e.sign, wx, wy, wz)) { solid = false; break; } }
        if (solid) for (const e of obliqueEntries) { if (!obliqueSolid(e.sim, e.matrix, e.origin, wx, wy, wz)) { solid = false; break; } }
        if (solid) occ[(k * ny + j) * nx + i] = 1;
      }
    }
  }
  const isSolidAt = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) ? false : occ[(k * ny + j) * nx + i] === 1;
  const pos = [], tri = [];
  const pushQuad = (v0, v1, v2, v3) => {
    const base = pos.length / 3;
    for (const v of [v0, v1, v2, v3]) pos.push(v[0], v[1], v[2]);
    tri.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let k = 0; k < nz; k++) {
    const z0 = box.zmin + k * c, z1 = z0 + c;
    for (let j = 0; j < ny; j++) {
      const y0 = box.ymin + j * c, y1 = y0 + c;
      for (let i = 0; i < nx; i++) {
        if (!isSolidAt(i, j, k)) continue;
        const x0 = box.xmin + i * c, x1 = x0 + c;
        if (!isSolidAt(i - 1, j, k)) pushQuad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
        if (!isSolidAt(i + 1, j, k)) pushQuad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
        if (!isSolidAt(i, j - 1, k)) pushQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
        if (!isSolidAt(i, j + 1, k)) pushQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
        if (!isSolidAt(i, j, k - 1)) pushQuad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
        if (!isSolidAt(i, j, k + 1)) pushQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
      }
    }
  }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(tri) };
}

module.exports = { buildFused, fuseCombined, triSolid, obliqueSolid };
