# Spike: real stock removal for undercuts + oblique multi-plane union

Two separate problems got bundled under "the real rewrite" - they need different fixes.
Working on both, prioritizing #2 first since it's the one that's actively visually broken
on a real job (O1160) right now.

## Problem 1: undercut tools (T-slot/dovetail/lollipop)
A height field stores ONE number per (x,y) column ("material exists down to height h").
That can't represent an overhang - a shape needs a per-column LIST of solid Z-intervals
(a real multi-interval dexel) so a cut can remove a middle band and leave material both
above and below it.

## Problem 2: multiple oblique tilted planes not forming one continuous shape (O1160)
This is NOT an undercut problem - O1160's 8 tilted planes are cut with ordinary bull-nose/
flat end mills, not undercut tools. The actual bug: each oblique plane gets its OWN
disconnected box (buildPlaneSims), so a part with 8 angled faces meant to form one wedge
renders as 8 floating misaligned slabs instead of one solid.

Key insight: the EXISTING per-plane HeightSim computation is already correct (it's been
verified against real jobs for months) - the bug is purely in how the RESULTS get combined
for display, not in the cutting math itself. So instead of rewriting the cutting engine,
try: fuse the already-correct per-plane results into one shared world-space height grid as
a POST-PROCESSING step. For each world (x,y) column, walk a vertical ray through every
plane that might cover it (via bisection, since a plane's local axes are generally NOT
aligned with world X/Y for a real compound tilt - a world-vertical ray becomes a slanted
line in the plane's local frame), find where each plane's finished surface crosses that
ray, and take the shallowest (minimum world Z) hit as the true final surface.

This is lower-risk than problem 1's fix: no change to the cutting math, only to how
already-correct per-plane results get displayed. If it works, it might not even need to be
the "big isolated rewrite" - possibly adoptable as a smaller, more contained fix.

## Results

### Problem 2 (oblique multi-plane union) - WORKS, and it's cheap

`fuse.js` implements exactly the approach above. `test-fuse-synthetic.js` hand-verifies the
core math (two tilted planes, expected crossing computed independently by hand, matched to
5 decimal places). Then ran it for real:

- **O1160** (the escalated job: 8 oblique planes, 22,333 moves, ordinary bull-nose/flat end
  mills, no undercuts): cutting + fusion = **712ms total**. Result is a single continuous
  solid - a real machined-looking pocket with rounded corners, a radiused wall, three
  drilled holes, and one angled facet - not 8 disconnected boxes. Screenshots in this
  worktree (gitignored, regenerate with `run-o1160.js` + `screenshot.js` - reads live from
  the shared drive, never committed): `out-o1160-fused-{0,1,2}.png`.
- **O1224** (cross-check on a harder, already-shipped job: 8 planes, 71,984 moves): fusion
  step itself is still fast (365ms), but running *every* plane through the older
  `buildPlaneSims`/`cutMove` path (bypassing tri-dexel entirely, which is what this spike
  does for simplicity) takes 8.4s for the cutting itself - because tri-dexel exists
  specifically to make the 7 *aligned* planes fast, and this spike doesn't use it. Real
  integration should keep tri-dexel for aligned planes and only run oblique planes through
  the slower per-plane path (today's existing split) - then feed tri-dexel's own grids into
  the SAME fusion step as one more "plane" (identity transform), rather than bypassing it.
  Resulting shape still came out coherent - one connected part, no gaps - matching the
  known-good production render structurally.

**Known rough edge, understood not fixed:** one grid cell at a plane-box corner in O1160
came out nearly untouched (spiked up to ~88mm) while every neighbour was correctly cut down
to ~71mm - `diagnose-spike.js` finds it at world (45.07, 22.4), right at the edge of a
plane's padded box (5mm pad, same value implicated in the earlier holder/padding fixes on
the main branch). One plane's box falls just short of covering that corner and nothing else
picks it up, so it defaults to "untouched". Fixable (slightly larger pad, or a neighbour-fill
pass for isolated single-cell gaps) but not chased down further here - the point of this
spike was proving the approach, not polishing it.

**This is meaningfully lower-risk than "the big rewrite" people were bracing for** - it
doesn't touch cutting math (`HeightSim.cut`, `cutMove`) at all, only adds a display-time
fusion pass over results that are already correct and already tested. Worth discussing as a
smaller, faster path to fixing O1160 specifically, separate from problem 1.

### Problem 1 (undercut tools) - proven with a synthetic case, not yet tried on a real job

`multidexel.js` + `test-multidexel-synthetic.js`: a synthetic T-slot profile (wide head,
narrow neck) making one lateral pass produces a column with material on BOTH sides of a
removed band (`[[0,10],[12,30]]`) - a genuine overhang, which `HeightSim.cut`'s single
height number can never represent. All hand-computed expected values matched exactly.

This is a real, separate rewrite (touches the cutting math itself, not just display), and
per [[feedback-isolate-risky-engine-experiments]] is exactly the kind of change that
shouldn't land on the working build until proven - which is as far as this spike proves it
so far.

**Performance check (`perf-multidexel.js`) - this is the real open problem, not a detail.**
T81's real usage in O1224 is only 302 moves (too small to stress-test). Built a synthetic
raster instead: 133 full-width moves over a 360x240 grid. Result: 287ms at 2 samples/move,
693ms at 6 samples/move - roughly **2-5ms per move**. The real engine's existing analytic
`HeightSim.cut` handles O1224's 71,984 moves in under a second (a small fraction of a
millisecond per move) because it solves for the exact swept envelope directly instead of
sampling many stationary tool positions along each move and unioning the results. At 2-5ms/
move, a real job with tens of thousands of moves would take tens of seconds to minutes -
not usable as-is. This sampling approach is correct but was written to prove the
*representation* (multi-interval columns can hold an overhang), not to be fast. Making it
fast enough for real use would mean real analytic swept-volume math for a non-monotonic
profile (materially harder than HeightSim.cut's convex-profile case), or restricting the
expensive multi-interval treatment to only the specific tool passes that need it (most of a
job's moves aren't undercut tools at all) rather than running every column through it.

## Recommendation
Bring problem 2's fusion approach back to John as a candidate near-term fix for O1160 -
it's small, tested, doesn't touch proven cutting code, and the numbers are good today, as
measured, on real jobs.

Problem 1 (undercuts) is a different story: the REPRESENTATION is proven correct (a column
really can hold material on both sides of a removed band), but the performance numbers say
the current implementation is 10-1000x too slow for real move counts, and closing that gap
needs real swept-volume geometry work, not a tuning pass. This is genuinely the bigger,
riskier half of "the rewrite" - accurate to keep it isolated and not treat it as close to
done just because the concept works.
