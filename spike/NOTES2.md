# Round 2: shared-world-frame direct cutting (no fusion, no precedence hack)

Context: round 1 (NOTES.md) built a "fuse separate per-plane results together afterward"
approach. It worked for the disconnected-boxes bug but needed an increasingly complicated
precedence rule (op-index, "most recent wins") to patch real correctness bugs it kept surfacing
(untouched planes winning, wrong search range, deep-cut-erases-wall). John's read: we were
optimizing for lean/fast and paying for it in correctness, and real competing tools (CIMCO
confirmed CPU-only, no GPU) get away with heavier per-frame computation than we assumed we could
afford. Asked to try the more direct fix instead: one shared world-frame grid, cut by every move
(any tool axis, any orientation) DIRECTLY and CUMULATIVELY, in true chronological program order -
no separate per-plane results to reconcile afterward, so no precedence bug to have in the first
place.

## What was built (spike/worlddexel.js)

Generalizes the engine's own analytic swept-volume math (today's `HeightSim.cut`, which only
handles a world-vertical tool axis) to an ARBITRARY tool axis direction, for convex tool
profiles. Derivation and the key convexity argument (why "the deepest point reached, minimized
over the move's path parameter t" is still the right single number to track, even for a tilted
axis) are in the file's own comments. Verified against:

- Hand-computed synthetic cases (vertical plunge on-axis, lateral move off-axis within/beyond
  the tool radius, a genuinely tilted stationary tool) - all match expected values exactly.
- **Regression against the existing engine's own proven-correct `HeightSim.cut`** for a real
  diagonal move with a flat tool, at several columns - the real correctness bar, not just
  internal self-consistency. Matches within grid/search tolerance.

## Real-job result: O1160 (the escalated wedge/wall job)

Cut EVERY move from EVERY plane (any axis) directly into one shared grid, skipping only
undercut-tool moves (out of scope for this pass - see below). No fusion, no precedence step.

**Before this: a flat, wrong pocket shape with the wall completely missing (multiple rounds of
fusion-precedence patches). After: a coherent part with the wall standing correctly, a proper
pocket floor with real toolpath texture, and all 3 real holes** - see out-worlddexel-o1160-{0,1,2}.png
(gitignored, regenerate with run-worlddexel-o1160.js + screenshot-worlddexel.js - reads live
from the shared drive, never committed).

**Performance: 19,890 real cutting moves in ~10.4s (0.52ms/move).** This is a ONE-TIME PREPASS
cost - per John's own framing, that budget has real slack (jobs already take several seconds to
load with a progress bar today); this is not a per-frame number and shouldn't be read as one.

**Real robustness bug found and fixed along the way:** the first version used a ternary search
over the move's path parameter t, assuming the "deepest reach as a function of t" is unimodal.
That assumption breaks down where cylinderZLowAtT is null (not "large") outside its valid
t-range - comparing two "both invalid" ternary search probe points gives no information about
which side the real valid window is on, and the search can step right past a narrow valid
window it never sampled. Produced tall, spurious spike artifacts across the real O1160 render
(see git history for the "before" screenshot situation). Fixed by dense even sampling first (40
points) to reliably locate the true valid window, then a small local refinement around the best
sample found - not a global search that assumes unimodality holds everywhere.

## Known scope gaps, deliberately not addressed in this pass

1. **Bull-nose/ball/chamfer profiles are approximated as a plain cylinder** (the tool's full
   radius, no corner rounding). O1160's dominant tool (T61) has an 0.008in corner radius -
   nearly flat, so the error is likely small there, but this is a real, disclosed
   simplification, not exact. Extending the exact quadric-intersection math to ball (a sphere -
   still a clean quadratic) and chamfer/drill (a cone - also quadratic) is a natural next step
   using the same frame math already built. Bull-nose's corner is a torus (a quartic surface,
   not a quadric) and will need either a numerical per-t refinement (same style as the fix
   above) or an approximation, same as how the existing engine already falls back to ternary
   search for bull-nose even in the simple vertical-axis case.
2. **Undercut tools are skipped entirely** (not hidden via a stopgap - just not cut at all in
   this test). Real multi-interval support (the other half of the original spike, NOTES.md) is
   still a separate, larger, and separately-proven-too-slow-as-sampled piece of work. Whether
   the SAME "solve the swept range analytically instead of sampling" fix that worked here would
   also fix that piece's performance problem is an open, promising question, not yet tried.
3. Arcs: NC's parser's own move representation is used as-is (straight-line moves between
   parsed points) - not separately verified that arc moves are already finely subdivided
   upstream in a way this approach handles correctly, though nothing in this pass's real-job
   testing suggested a problem.
4. Not yet integrated into the app - this is still engine.js/spike-level math+data only, proven
   against real jobs via throwaway scripts, not wired into rebuild()/playback.

## Recommendation

This is a materially better foundation than the fusion approach: no precedence heuristic to get
subtly wrong, and it fixes the actual escalated bug (O1160's wall) at a real-job performance
cost that fits comfortably inside the "one-time prepass, seconds not milliseconds" budget John
confirmed is acceptable. Worth showing before doing any more scope expansion (bull/ball/chamfer
exactness, undercuts, live incremental integration) - each of those is a real, separate step
from here, not a detail.
