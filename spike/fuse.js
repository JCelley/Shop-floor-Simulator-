// Fuse multiple per-plane HeightSims (each already correctly cut in its OWN local frame,
// via the existing buildPlaneSims/cutMove) into ONE shared world-space height grid, so a
// part built from several oblique tilted-plane facets renders as one continuous shape
// instead of disconnected boxes. Does not touch the cutting math at all - this is a
// display-time fusion of already-correct results. See NOTES.md.
'use strict';

// Bilinear-interpolate a HeightSim's height at an arbitrary LOCAL (lx, ly). Returns null if
// outside the sim's own box (that plane does not cover this point at all).
function sampleHeightSim(sim, lx, ly) {
  const fx = (lx - sim.x0) / sim.dx - 0.5, fy = (ly - sim.y0) / sim.dy - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > sim.nx - 0.5 || fy > sim.ny - 0.5) return null;
  const cfx = Math.min(Math.max(fx, 0), sim.nx - 1), cfy = Math.min(Math.max(fy, 0), sim.ny - 1);
  const i0 = Math.floor(cfx), j0 = Math.floor(cfy);
  const i1 = Math.min(i0 + 1, sim.nx - 1), j1 = Math.min(j0 + 1, sim.ny - 1);
  const tx = cfx - i0, ty = cfy - j0;
  const h = sim.h, nx = sim.nx;
  const h00 = h[j0 * nx + i0], h10 = h[j0 * nx + i1], h01 = h[j1 * nx + i0], h11 = h[j1 * nx + i1];
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

// A plane's rigid transform: world = origin + M*local. Since M is a rotation (orthonormal),
// local = M^T * (world - origin). Precompute the pieces needed to walk a WORLD-VERTICAL ray
// (fixed world x,y; wz varying) through local space: local(wz) = C0 + wz*Cz, all three local
// coordinates linear in wz. Mt is M transposed (row i of Mt = column i of M).
function rayInLocal(plane, wx, wy) {
  const M = plane.matrix, o = plane.origin;
  const Mt = [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]],
  ];
  const dx = wx - o[0], dy = wy - o[1], dz0 = -o[2]; // world point (wx,wy,0) minus origin
  const C0 = [
    Mt[0][0] * dx + Mt[0][1] * dy + Mt[0][2] * dz0,
    Mt[1][0] * dx + Mt[1][1] * dy + Mt[1][2] * dz0,
    Mt[2][0] * dx + Mt[2][1] * dy + Mt[2][2] * dz0,
  ];
  const Cz = [Mt[0][2], Mt[1][2], Mt[2][2]]; // Mt * (0,0,1)
  return { C0, Cz };
}

// Find the world Z where a vertical ray at (wx,wy) crosses this plane's finished surface -
// i.e., where local Z along the ray equals the HeightSim's own height at the ray's local
// (lx,ly) at that same point. Returns null if the ray never enters the plane's own box in
// the given [zLo,zHi] search range (that plane simply does not cover this world column).
function crossingWorldZ(plane, sim, wx, wy, zLo, zHi, iters) {
  const { C0, Cz } = rayInLocal(plane, wx, wy);
  const localAt = wz => [C0[0] + wz * Cz[0], C0[1] + wz * Cz[1], C0[2] + wz * Cz[2]];
  const f = wz => {
    const [lx, ly, lz] = localAt(wz);
    const h = sampleHeightSim(sim, lx, ly);
    if (h === null) return null; // ray's local xy is outside this plane's box at this wz
    return lz - h; // negative = below the surface (solid), positive = above (air)
  };
  // Sample across the search range to find a sign change (a real crossing), since f can be
  // undefined (null) outside the plane's local box - scan first, only bisect a bracket where
  // both ends are defined and opposite sign.
  const N = 24;
  let prevWz = null, prevF = null;
  for (let k = 0; k <= N; k++) {
    const wz = zHi - (zHi - zLo) * k / N; // walk downward from the top
    const fv = f(wz);
    if (fv !== null && prevF !== null && ((fv <= 0) !== (prevF <= 0))) {
      // bracket found between prevWz and wz
      let lo = prevWz, hi = wz, flo = prevF;
      for (let it = 0; it < iters; it++) {
        const mid = 0.5 * (lo + hi), fm = f(mid);
        if (fm === null) { hi = mid; continue; } // shrink toward the defined side
        if ((fm <= 0) === (flo <= 0)) { lo = mid; flo = fm; } else { hi = mid; }
      }
      return 0.5 * (lo + hi);
    }
    if (fv !== null) { prevWz = wz; prevF = fv; }
  }
  return null;
}

// Build one shared world-space height grid by fusing every plane's own (already-correct)
// HeightSim result. planes: array of {matrix, origin, sim} (sim = a HeightSim-shaped object
// with x0,y0,dx,dy,nx,ny,h). box: the real (or guessed) world stock box. target: cells along
// the longer XY side, same convention as HeightSim.
function fusePlanesToWorldGrid(planes, box, target, iters) {
  iters = iters || 22;
  const W = box.xmax - box.xmin, H = box.ymax - box.ymin;
  const c = Math.max(W, H) / target;
  const nx = Math.max(8, Math.round(W / c)), ny = Math.max(8, Math.round(H / c));
  const dx = W / nx, dy = H / ny;
  // Untouched columns (no plane covers them at all) stay at box.ztop - full, uncut stock -
  // not box.zbot, which would wrongly mean "everything here is gone". Where planes DO
  // overlap, the correct final surface is the DEEPEST cut (min world Z): each plane's own
  // HeightSim already computes "material remains up to here" for the region it covers, and
  // whichever operation removed the most material there is the one that actually determines
  // the final result - a rough pass covering the whole area, refined by a finishing pass on
  // one facet, must show the finishing pass's deeper result where they overlap.
  const out = new Float32Array(nx * ny).fill(box.ztop);
  const contributors = new Int32Array(nx * ny).fill(-1); // which plane index won at each cell, for diagnostics
  for (let j = 0; j < ny; j++) {
    const wy = box.ymin + (j + 0.5) * dy;
    for (let i = 0; i < nx; i++) {
      const wx = box.xmin + (i + 0.5) * dx;
      let best = box.ztop, bestK = -1;
      for (let k = 0; k < planes.length; k++) {
        const { matrix, origin, sim } = planes[k];
        const wz = crossingWorldZ({ matrix, origin }, sim, wx, wy, box.zbot, box.ztop, iters);
        if (wz !== null && wz < best) { best = wz; bestK = k; }
      }
      out[j * nx + i] = best;
      contributors[j * nx + i] = bestK;
    }
  }
  return { nx, ny, dx, dy, x0: box.xmin, y0: box.ymin, zTop: box.ztop, zBot: box.zbot, h: out, contributors };
}

module.exports = { sampleHeightSim, rayInLocal, crossingWorldZ, fusePlanesToWorldGrid };
