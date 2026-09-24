// Shared world-frame stock cut directly and cumulatively, in TRUE PROGRAM ORDER, by tools of
// ANY axis orientation - not just world-vertical ones. This replaces the whole "separate
// per-plane HeightSims fused together afterward" approach (fuse.js) with something simpler and
// more correct: there is only ever ONE grid, and every move (aligned or oblique) subtracts its
// own exact swept volume from it directly, the moment it happens. Whatever is left at a given
// column after the LAST real cut there is exactly what a real machine would leave - no
// after-the-fact "which plane wins" precedence logic needed at all, because there is nothing to
// reconcile.
//
// Scope of this first pass: CONVEX tool profiles only (flat/ball exactly; bull/chamfer
// approximated as a plain cylinder of the tool's full radius for now - see below). Undercut
// tools and true multi-interval columns are a deliberately separate, later increment - see
// NOTES.md. The point of this file is to prove the harder, more valuable half of the problem
// first: can a shared single-height world grid, cut by tools of ARBITRARY axis direction, in
// real chronological order, be both CORRECT (no fusion precedence bugs) and FAST ENOUGH on real
// jobs - without which the multi-interval work would inherit the same performance question.
'use strict';

// For a move with tool axis `a` (world-space unit vector, constant for the whole move) and tip
// travelling from A to B, find the DEEPEST world Z the tool's surface reaches at world column
// (cx,cy), for ONE fixed path parameter t (0<=t<=1). Returns null if the tool doesn't reach this
// column at all at this t. Only exact for a plain CYLINDER (flat tool, constant radius R,
// height 0..Hmax) - see cylinderZLowAtT.
//
// Derivation (see spike notes / commit message): let ez=(0,0,1), D=B-A. Decompose the vector
// from A to the column, and D itself, into components along `a` and perpendicular to `a` (since
// a solid of revolution's boundary only depends on those two coordinates). Both decompositions
// are affine in t; a further affine substitution in z (since the world point being tested is
// (cx,cy,z)) keeps the "distance from tool axis" a QUADRATIC function of z for fixed t, which is
// the same math a line-vs-cylinder intersection always reduces to.
function makeAxisFrame(a, A, D, cx, cy) {
  const u0 = [cx - A[0], cy - A[1], -A[2]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const h0 = dot(u0, a), hD = dot(D, a);
  const azComp = a[2]; // ez . a
  const sub = (p, q, s) => [p[0] - s * q[0], p[1] - s * q[1], p[2] - s * q[2]];
  const w0 = sub(u0, a, h0);
  const wD = sub(D, a, hD);
  const ezPerp = [-azComp * a[0], -azComp * a[1], 1 - azComp * a[2]];
  return { h0, hD, azComp, w0, wD, ezPerp, dot };
}

// Deepest world Z the tool (a plain cylinder, radius R, local height 0..Hmax from the tip)
// reaches at this column, for ONE fixed t. Returns null if no valid z exists at this t.
function cylinderZLowAtT(frame, t, R, Hmax) {
  const { h0, hD, azComp, w0, wD, ezPerp, dot } = frame;
  const w0t = [w0[0] - t * wD[0], w0[1] - t * wD[1], w0[2] - t * wD[2]];
  const h0t = h0 - t * hD;
  const Aq = dot(ezPerp, ezPerp), Bq = 2 * dot(w0t, ezPerp), Cq = dot(w0t, w0t) - R * R;

  // z-range where the column is within radius R of the tool axis at this t.
  let zLoR, zHiR;
  if (Aq < 1e-12) {
    // Tool axis's world-Z component of the perpendicular direction is ~0 (a is very close to
    // vertical) - the quadratic degenerates to linear (Bq*z + Cq <= 0).
    if (Math.abs(Bq) < 1e-12) { if (Cq > 0) return null; zLoR = -Infinity; zHiR = Infinity; }
    else if (Bq > 0) { zLoR = -Infinity; zHiR = -Cq / Bq; }
    else { zLoR = -Cq / Bq; zHiR = Infinity; }
  } else {
    const disc = Bq * Bq - 4 * Aq * Cq;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    zLoR = (-Bq - sq) / (2 * Aq); zHiR = (-Bq + sq) / (2 * Aq);
  }

  // z-range where the local height along the tool axis is within [0, Hmax].
  let zLoH, zHiH;
  if (Math.abs(azComp) < 1e-12) {
    if (h0t < -1e-9 || h0t > Hmax + 1e-9) return null; // this t never has a valid height at all
    zLoH = -Infinity; zHiH = Infinity;
  } else if (azComp > 0) { zLoH = (0 - h0t) / azComp; zHiH = (Hmax - h0t) / azComp; }
  else { zLoH = (Hmax - h0t) / azComp; zHiH = (0 - h0t) / azComp; }

  const zLo = Math.max(zLoR, zLoH), zHi = Math.min(zHiR, zHiH);
  if (zLo > zHi) return null;
  return zLo;
}

// Deepest world Z the tool reaches at column (cx,cy) over the WHOLE move (t in [0,1]).
//
// NOT a plain ternary search over t: cylinderZLowAtT is null (not "large") outside its valid
// t-range, and comparing two "both invalid" sample points gives no information about which
// direction the real valid window is in - a real bug this went through once already (verified
// against a real job: it produced tall spurious spikes all over the result, columns where a
// narrow valid window existed between the ternary search's probe points and got stepped past
// entirely). Dense, even sampling first to reliably LOCATE the valid window (or confirm there
// isn't one), then a local bisection-style refinement around the best sample found - not a
// global search that assumes unimodality holds everywhere, only within the small neighbourhood
// already known to contain the true minimum.
function cylinderZLowOverMove(frame, R, Hmax, samples, refineIters) {
  samples = samples || 40; refineIters = refineIters === undefined ? 24 : refineIters;
  let bestI = -1, best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, v = cylinderZLowAtT(frame, t, R, Hmax);
    if (v !== null && v < best) { best = v; bestI = i; }
  }
  if (bestI === -1) return null; // never valid anywhere along the move
  if (refineIters === 0) return best; // short move (see cutMoveWorld) - the coarse samples are already dense relative to how much the swept range can change
  // Refine locally in the neighbourhood of the best sample (one dense-sample step wide on each
  // side), where the swept volume's convexity argument is trustworthy over such a small range.
  let lo = Math.max(0, bestI - 1) / samples, hi = Math.min(samples, bestI + 1) / samples;
  for (let it = 0; it < refineIters; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const v1 = cylinderZLowAtT(frame, m1, R, Hmax), v2 = cylinderZLowAtT(frame, m2, R, Hmax);
    const V1 = v1 === null ? Infinity : v1, V2 = v2 === null ? Infinity : v2;
    if (V1 <= V2) hi = m2; else lo = m1;
  }
  for (let i = 0; i <= 4; i++) {
    const t = lo + (hi - lo) * i / 4, v = cylinderZLowAtT(frame, t, R, Hmax);
    if (v !== null && v < best) best = v;
  }
  return best;
}

// Cut one move into a shared, world-frame, single-height grid (same shape as engine.js's
// HeightSim: x0,y0,dx,dy,nx,ny,h,op). `a` is the tool's world-space axis direction for this
// move (constant per plane - the plane's matrix third column). Treats every profile kind as a
// plain cylinder of the tool's full radius for now (bull/chamfer's exact corner rounding is a
// later increment - see file header).
function cutMoveWorld(grid, ax, ay, az, bx, by, bz, a, T, opId, samples) {
  samples = samples || 40;
  const R = T.R, Hmax = 1e6; // Hmax effectively unbounded for a plain cylinder - the tool shank is assumed to extend well past any real cut depth
  const A = [ax, ay, az], D = [bx - ax, by - ay, bz - az];
  const L2 = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
  // Most real feed moves are short relative to the tool radius (fine stepover/finishing passes)
  // - the existing engine has the same "short move" fast path (HeightSim.cut's `short` branch)
  // for exactly this reason: over a short move the swept range barely changes, so a handful of
  // coarse samples (no expensive local refinement) is already accurate, and skipping the full
  // dense-sample-plus-refinement search for the majority of moves is what keeps a real job's
  // total cutting time reasonable (this was the actual cause of O1224 - more real cutting moves
  // than O1160, most of them short - taking 5x longer per move before this fast path existed).
  const short = L2 < (R * 1.5) * (R * 1.5);
  const fastSamples = 8, fastRefine = 0;
  const dx = grid.dx, dy = grid.dy, x0 = grid.x0, y0 = grid.y0, nx = grid.nx, ny = grid.ny;
  const xlo = Math.min(ax, bx) - R, xhi = Math.max(ax, bx) + R;
  const ylo = Math.min(ay, by) - R, yhi = Math.max(ay, by) + R;
  let i0 = Math.max(0, Math.floor((xlo - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((xhi - x0) / dx));
  let j0 = Math.max(0, Math.floor((ylo - y0) / dy)), j1 = Math.min(ny - 1, Math.floor((yhi - y0) / dy));
  if (i0 > i1 || j0 > j1) return;
  for (let j = j0; j <= j1; j++) {
    const cy = y0 + (j + 0.5) * dy;
    for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * dx;
      const idx = j * nx + i;
      if (grid.h[idx] <= grid.zBot + 1e-9) continue; // already at the bottom, nothing left to remove
      const frame = makeAxisFrame(a, A, D, cx, cy);
      const zLow = short ? cylinderZLowOverMove(frame, R, Hmax, fastSamples, fastRefine) : cylinderZLowOverMove(frame, R, Hmax, samples);
      if (zLow === null) continue;
      const clamped = Math.max(zLow, grid.zBot);
      if (clamped < grid.h[idx]) { grid.h[idx] = clamped; grid.op[idx] = opId; }
    }
  }
}

module.exports = { makeAxisFrame, cylinderZLowAtT, cylinderZLowOverMove, cutMoveWorld };
