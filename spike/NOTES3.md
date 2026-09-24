# Round 3: reuse tri-dexel's own per-axis grids for EVERY plane

## The root cause found in round 2 (recap)

worlddexel.js (round 2) generalized the swept-volume math to an arbitrary tool axis but still
collapsed each column to ONE height number, always measured along world Z. That is a
CATEGORICAL bug, not an imprecision, for any tool whose real axis is far from vertical: the
correct removed region for such a tool is a BOUNDED band (material exists above AND below it),
but treating "the bottom of that band" as "the new surface height" silently deletes everything
above it too - not a rounding error, a real deletion of material that should remain.

Confirmed by a per-plane error breakdown on O1224: plane 0 (world Z axis) was 0% wrong; planes
1/2/3/5 (axes like `(0,1,0)` - genuinely horizontal, cutting a side wall from the side) were
92-100% wrong. O1160 mostly escaped this because its tilted planes were only a few degrees off
vertical (small, bounded error from treating them as Z anyway) except one plane doing a few
small holes - which is exactly why O1160 looked "mostly fine" and O1224 didn't.

## The fix: don't invent a new representation - reuse tri-dexel's existing one

Tri-dexel already solves exactly this, TODAY, for planes it classifies as "aligned": it keeps
SEPARATE grids per signed world axis (Z+, Z-, X+, X-, Y+, Y-) and routes each plane's moves into
whichever grid actually matches its real tool axis - so "height" always means the right thing
for that plane. It also already cuts moves directly and cumulatively into those shared grids in
true program order (see `cutTriDexelMove`) - the earlier "fusion" work (round 1) was ONLY ever
needed to stitch tri-dexel's result together with the SEPARATE oblique-plane fallback, not
because tri-dexel itself has any precedence problem.

`classifyPlanes(planes, tolDeg)` already computes, for every plane, which world axis its real
tool axis is closest to (`idx`/`sign`) - it just then REJECTS planes past a tiny default
tolerance (0.01deg) as "oblique", leaving them for the separate fallback. Passing a much larger
tolerance (up to ~55deg, the worst case for "which axis is nearest") makes EVERY plane pass and
get a real signed-axis assignment instead. `buildTriDexel` now accepts this as an optional 5th
parameter (`tolDeg`, engine.js) - omitted, it's 100% unchanged behaviour (verified: existing
tri-dexel tests still pass unmodified). Passed a large value, every plane - including a
genuinely oblique one - snaps to its nearest axis and cuts through the EXISTING, already-tested,
exact `cutMove`/`HeightSim.cut` - no new swept-volume geometry at all. worlddexel.js's own math
is no longer needed for either job tested here.

## Ground truth results (compareToPart.js, kept from round 2 - see NOTES2.md)

| Job   | mean error (round 2, single-Z-column) | mean error (round 3, snap-to-axis) | >=10mm columns (round 2) | >=10mm columns (round 3) |
|-------|---------------------------------------|-------------------------------------|---------------------------|---------------------------|
| O1160 | 0.61mm                                | 0.66mm (no material change expected - O1160 had no planes needing the fix) | 2.4% | 2.4% (same, unrelated residual - see below) |
| O1224 | **18.66mm**                           | **0.082mm**                         | **63.1%**                 | **0.4%**                  |

O1224 went from "looks nothing like the part" (John's words, confirmed) to 99.0% of the surface
within 0.2mm of the real design geometry. Performance also improved substantially by REMOVING
the custom math: 70,541 real cutting moves in ~4.9s (0.065ms/move) using the exact, already-
optimized existing engine, versus 30s (0.43ms/move) for the same job with worlddexel.js's own
generalized math.

## Two known, smaller, NOT-yet-explained residuals

1. **O1160: 2.4% of columns (~1,600) off by >=10mm, max ~22mm, unchanged between round 2 and
   round 3.** Since round 3 uses the EXACT bull-nose profile (not the round-2 cylinder
   approximation), this rules out the tool-profile-approximation explanation I gave for it
   earlier - that diagnosis was wrong. Traced to a real move (T61 lateral cut) whose path passes
   4.64mm from the bad column against a 4.7625mm tool radius - a 0.12mm margin, under one grid
   cell. Whether this is a genuine small toolpath/coverage gap (real, but present in the actual
   job too), a scope issue (this NC file may only cover one of several setups/operations for the
   real part), or something else has NOT been determined - flagged, not resolved.
2. **O1224: 0.4% of columns (254), max ~17.7mm**, most likely the one real oblique plane (id 7,
   a genuine compound angle) now being approximated by snapping to its nearest axis instead of
   its own exact local frame (which the OLD buildPlaneSims fallback path used to give it exactly)
   - plausible but not confirmed by tracing the way item 1 was.

## Recommendation

This round's result is what "another stab, in the direction John asked for" was supposed to
produce: the SAME "one shared representation, cut directly and cumulatively, no fusion"
principle, but built by extending the EXISTING, already-proven tri-dexel mechanism instead of
inventing new geometry - smaller diff, faster, and an order of magnitude more correct against
the real part on the job that mattered most (O1224). Two small, real residuals remain
unexplained and should not be waved off, but neither is anywhere close to "looks nothing like
the part" anymore.
