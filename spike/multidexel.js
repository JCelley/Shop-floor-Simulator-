// Core proof-of-concept for undercut tools: a single dexel COLUMN as a sorted list of disjoint
// solid [lo,hi] Z-intervals (instead of one height number), so a cut can remove a middle band
// and leave material both above and below it - the thing a height field can never represent.
// Separate problem from fuse.js (multi-plane union); see NOTES.md.
'use strict';

// Subtract [lo,hi] from a sorted list of disjoint [a,b] solid intervals (a<b), splitting an
// interval in two if the removed range falls strictly inside it - THIS is what creates an
// overhang: material remains both below and above a removed band.
function subtractInterval(intervals, lo, hi) {
  if (lo >= hi) return intervals;
  const out = [];
  for (const [a, b] of intervals) {
    if (b <= lo || a >= hi) { out.push([a, b]); continue; }
    if (a < lo) out.push([a, lo]);
    if (b > hi) out.push([hi, b]);
  }
  return out;
}

// A tool profile is a polyline of [h, r] points, h measured UP from the tip (h=0), r the
// tool's radius at that height - NOT required to be monotonic (that's what a convex-only
// engine like today's HeightSim.cut can't handle). Returns the merged [h0,h1] ranges (in
// tool-local height) where the linearly-interpolated radius >= dist.
function heightRangesAtRadius(profile, dist) {
  const raw = [];
  for (let k = 0; k < profile.length - 1; k++) {
    const [h1, r1] = profile[k], [h2, r2] = profile[k + 1];
    if (r1 >= dist && r2 >= dist) { raw.push([h1, h2]); continue; }
    if (r1 < dist && r2 < dist) continue;
    const t = (dist - r1) / (r2 - r1), hc = h1 + t * (h2 - h1);
    raw.push(r1 < dist ? [hc, h2] : [h1, hc]);
  }
  if (!raw.length) return [];
  raw.sort((a, b) => a[0] - b[0]);
  const out = [raw[0].slice()];
  for (let i = 1; i < raw.length; i++) {
    const last = out[out.length - 1], cur = raw[i];
    if (cur[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], cur[1]); else out.push(cur.slice());
  }
  return out;
}

// Cut a stationary vertical plunge/dwell OR a lateral move (tip position A to B) into a
// dexel grid of columns (a Map keyed 'i,j' -> interval list). Approximates the move by
// sampling `samples` positions along it (fine for a prototype - exact analytic swept-volume
// math for an arbitrary non-monotonic profile is future work if this direction is adopted).
function cutMoveIntervals(grid, nx, ny, dx, dy, x0, y0, ax, ay, az, bx, by, bz, profile, samples) {
  const maxR = Math.max(...profile.map(p => p[1]));
  const xlo = Math.min(ax, bx) - maxR, xhi = Math.max(ax, bx) + maxR;
  const ylo = Math.min(ay, by) - maxR, yhi = Math.max(ay, by) + maxR;
  const i0 = Math.max(0, Math.floor((xlo - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((xhi - x0) / dx));
  const j0 = Math.max(0, Math.floor((ylo - y0) / dy)), j1 = Math.min(ny - 1, Math.floor((yhi - y0) / dy));
  for (let j = j0; j <= j1; j++) {
    const cy = y0 + (j + 0.5) * dy;
    for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * dx;
      const worldRanges = [];
      for (let s = 0; s <= samples; s++) {
        const t = samples ? s / samples : 0;
        const px = ax + t * (bx - ax), py = ay + t * (by - ay), pz = az + t * (bz - az);
        const d = Math.hypot(cx - px, cy - py);
        if (d > maxR) continue;
        for (const [h0, h1] of heightRangesAtRadius(profile, d)) worldRanges.push([pz + h0, pz + h1]);
      }
      if (!worldRanges.length) continue;
      worldRanges.sort((a, b) => a[0] - b[0]);
      const merged = [worldRanges[0].slice()];
      for (let k = 1; k < worldRanges.length; k++) {
        const last = merged[merged.length - 1], cur = worldRanges[k];
        if (cur[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], cur[1]); else merged.push(cur.slice());
      }
      const key = i + ',' + j;
      let col = grid.get(key);
      if (!col) continue; // column not initialized (outside the modeled stock) - skip
      for (const [lo, hi] of merged) col = subtractInterval(col, lo, hi);
      grid.set(key, col);
    }
  }
}

module.exports = { subtractInterval, heightRangesAtRadius, cutMoveIntervals };
