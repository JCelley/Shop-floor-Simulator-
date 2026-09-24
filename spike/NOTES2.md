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

## Ground-truth check against the real PART.stl (spike/compareToPart.js)

Everything above was judged by eye - "does it look plausible" - which is exactly the kind of
check that already let two real defects through (O1224 "looking nothing like the part", O1160's
wall being torn through) without me noticing from a screenshot. The CIMCO scanning post already
gives us the actual design-intent geometry (`PART.stl`, unrelated to anything our own simulation
computes) for every job - there was no reason to keep eyeballing renders instead of diffing
against it directly. Built compareToPart.js: for every grid column, raycast straight down
through the real part mesh, take the topmost hit, and compare to the simulated height there.
Verified against a synthetic flat "part" with a known answer before trusting it on real data.

**O1160 result: mean error 0.61mm, but max error 22mm, and 2.4% of the compared surface
(1,632 of 68,544 columns) is off by 10mm or more.** That is a real fail by any reasonable bar,
not noise - confirmed and traced to an exact cause (see below), not just observed.

**Root cause, found by replaying the exact move history at the worst column:** a bull-nose
tool (T61, 0.008in/0.2mm corner radius) makes a lateral cut whose path passes 4.64mm from that
column - the tool's radius is 4.7625mm, a margin of 0.12mm, less than one grid cell (0.22mm).
Because bull-nose is approximated as a plain full-radius cylinder here (a disclosed
simplification - see "known scope gaps" above), the sim called it "touched" and cut the column
down to the move's own depth. A real bull-nose tool's corner rounds off near the bottom of the
tool, so the true tool very likely never reached this column at all. The disclosed
approximation was assumed to cost "a small rounding error near corners" - it actually cost a
binary touched/untouched flip at a real geometric boundary, and because a height-field has no
"barely touched" state (a column is either cut all the way to the tool's local depth, or left
completely untouched), a 0.12mm geometric miss became a 22mm visible gouge. This is NOT a flaw
in the shared-frame/no-fusion architecture itself (the regression test against the existing
engine's exact math still holds) - it is the specific, disclosed tool-profile simplification
mattering far more than assessed, at real geometric boundaries specifically.

O1224's comparison is running - see below once it lands.

## Recommendation

The architecture (one shared grid, cut directly and cumulatively in true program order, no
precedence heuristic) is proven sound by the regression test and is still the right direction.
But this specific attempt does NOT pass John's bar ("if it's really far off, it's a fail") as
shipped - the cylinder-for-every-profile simplification produces real, large, root-caused
errors at genuine tool-boundary locations, not just cosmetic corner rounding. The fix is
concrete and scoped (exact ball/chamfer via the same quadratic frame math already built;
bull-nose needs either the exact torus intersection or a tighter numerical fallback), not a
sign the whole direction is wrong - but it is real, undone work, not a detail to wave off.
