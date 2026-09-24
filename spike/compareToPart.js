// Compare a simulated height grid against the REAL finished-part geometry (PART.stl from the
// CIMCO scanning post - the actual CAD-derived design shape, not anything derived from our own
// simulation). This is the ground-truth check that was missing: "looks plausible" is not a
// substitute for "matches the real part". For each grid column, raycast straight down through
// the real part mesh and take the TOPMOST hit (the real part's own top surface at that XY,
// matching what our height grid represents) - compare to what the simulation computed there.
'use strict';

// Bin triangles by which grid columns their XY bounding box can possibly touch, so per-column
// lookup doesn't have to test every triangle in the mesh (real PART.stl files have thousands).
function binTriangles(partMesh, grid) {
  const bins = new Map(); // 'i,j' -> [triangle indices]
  const pos = partMesh.pos, idx = partMesh.idx;
  const addBin = (i, j, t) => { const k = i + ',' + j; let a = bins.get(k); if (!a) { a = []; bins.set(k, a); } a.push(t); };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const xs = [pos[a], pos[b], pos[c]], ys = [pos[a + 1], pos[b + 1], pos[c + 1]];
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    let i0 = Math.floor((xmin - grid.x0) / grid.dx), i1 = Math.floor((xmax - grid.x0) / grid.dx);
    let j0 = Math.floor((ymin - grid.y0) / grid.dy), j1 = Math.floor((ymax - grid.y0) / grid.dy);
    i0 = Math.max(0, i0); i1 = Math.min(grid.nx - 1, i1); j0 = Math.max(0, j0); j1 = Math.min(grid.ny - 1, j1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) addBin(i, j, t);
  }
  return bins;
}

// Topmost Z where a vertical ray at (px,py) crosses triangle t (indices into pos/idx), or null.
function rayTriangleTopZ(pos, idx, t, px, py) {
  const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
  const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
  const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
  // barycentric via 2D cross products (XY only - we're intersecting a vertical ray)
  const v0x = bx - ax, v0y = by - ay, v1x = cx - ax, v1y = cy - ay, v2x = px - ax, v2y = py - ay;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-12) return null;
  const v = (v2x * v1y - v1x * v2y) / den, w = (v0x * v2y - v2x * v0y) / den, u = 1 - v - w;
  if (u < -1e-7 || v < -1e-7 || w < -1e-7) return null;
  return u * az + v * bz + w * cz;
}

// Real height at (px,py) from the actual part mesh (topmost surface) using the precomputed bins.
function partHeightAt(partMesh, bins, grid, i, j, px, py) {
  const tris = bins.get(i + ',' + j);
  if (!tris) return null;
  let best = null;
  for (const t of tris) {
    const z = rayTriangleTopZ(partMesh.pos, partMesh.idx, t, px, py);
    if (z !== null && (best === null || z > best)) best = z;
  }
  return best;
}

// Compare a sim grid ({nx,ny,dx,dy,x0,y0,h}) against the real part mesh. Returns per-column
// stats and a signed-error array (sim - real; positive = sim left MORE material than the real
// part has there, i.e. under-cut; negative = sim removed too much, i.e. over-cut/gouge).
function compareToPart(grid, partMesh) {
  const bins = binTriangles(partMesh, grid);
  const n = grid.nx * grid.ny;
  const err = new Float32Array(n).fill(NaN); // NaN where the real part doesn't cover this column at all
  let count = 0, sumAbs = 0, maxAbs = 0, maxAbsAt = null;
  const HIST = [0, 0, 0, 0, 0]; // <0.2mm, <1mm, <3mm, <10mm, >=10mm
  for (let j = 0; j < grid.ny; j++) {
    const py = grid.y0 + (j + 0.5) * grid.dy;
    for (let i = 0; i < grid.nx; i++) {
      const px = grid.x0 + (i + 0.5) * grid.dx;
      const real = partHeightAt(partMesh, bins, grid, i, j, px, py);
      if (real === null) continue;
      const idx = j * grid.nx + i;
      const e = grid.h[idx] - real;
      err[idx] = e;
      count++;
      const ae = Math.abs(e);
      sumAbs += ae;
      if (ae > maxAbs) { maxAbs = ae; maxAbsAt = [px, py, grid.h[idx], real]; }
      if (ae < 0.2) HIST[0]++; else if (ae < 1) HIST[1]++; else if (ae < 3) HIST[2]++; else if (ae < 10) HIST[3]++; else HIST[4]++;
    }
  }
  return { err, count, meanAbs: sumAbs / count, maxAbs, maxAbsAt, hist: HIST, nx: grid.nx, ny: grid.ny };
}

module.exports = { binTriangles, rayTriangleTopZ, partHeightAt, compareToPart };
