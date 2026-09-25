// Tri-dexel: a shared-world-frame stock model for real 3+2 jobs, sitting alongside
// buildPlaneSims/cutMoveMulti (tests/planes.test.js), not replacing it. Only planes whose real
// tool axis lands on a world X/Y/Z axis (classifyPlanes) join tri-dexel; a genuinely oblique
// plane (O1224 has one real example) is left for the caller to render via the existing
// buildPlaneSims/cutMoveMulti path instead. See the design plan for the full rationale -
// notably, grids are keyed by SIGNED axis direction because O1224 has two planes sharing the Y
// axis with opposite tool directions, which a single unsigned "Y grid" cannot represent.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));

/* ---------- classifyPlanes pinned against the real job ---------- */
{
  const cls = NC.classifyPlanes(real.planes);
  const aligned = [...cls.alignedIds].sort((a, b) => a - b);
  const oblique = [...cls.obliqueIds].sort((a, b) => a - b);
  ok(JSON.stringify(aligned) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]), `aligned planes are exactly 0-6 (got ${aligned})`);
  ok(JSON.stringify(oblique) === JSON.stringify([7]), `oblique planes are exactly {7} (got ${oblique})`);
  // Real signed-axis assignment, computed from the fixed engine (planeMatrix's Z-X-Z Fanuc
  // convention, verified decisively against a real posted job's actual stock geometry - see
  // docs/plan/NOTES.md). I80/J90/K0 at fixtures/O1224.NC:32579 is plane 7, the one genuinely
  // oblique tilt.
  const want = { 0: 'Z+', 1: 'X+', 2: 'X-', 3: 'Y-', 4: 'Z+', 5: 'X+', 6: 'Y+' };
  for (const [id, key] of Object.entries(want)) ok(cls.signOf.get(+id) === key, `plane ${id} (ijk ${real.planes[id].ijk}) -> ${key} (got ${cls.signOf.get(+id)})`);
  ok(!cls.signOf.has(7), 'plane 7 (the oblique one) has no signed-axis assignment');
}

/* ---------- undercutOnlyPlanes: the "hide a slab that never changes" stopgap ---------- */
{
  // Plane 7's only tool is T81, a real lollipop mill (undercut), so it should be the one and only
  // undercut-only plane in this real job - every other plane mixes in at least one normal tool.
  const hidden = NC.undercutOnlyPlanes(real);
  ok(hidden.size === 1 && hidden.has(7), `plane 7 (lollipop-only) is the one undercut-only plane, got ${[...hidden]}`);

  // A plane mixing an undercut tool with a normal one must NOT be hidden - only an all-undercut
  // plane reads as "nothing will ever be shown cut here".
  const mixed = { n: 2, PL: [0, 0], TL: [1, 2], tools: [{ no: 1, undercut: true }, { no: 2, undercut: false }] };
  ok(NC.undercutOnlyPlanes(mixed).size === 0, 'a plane with at least one normal tool is never hidden');

  const allUndercut = { n: 2, PL: [3, 3], TL: [1, 1], tools: [{ no: 1, undercut: true }] };
  ok(NC.undercutOnlyPlanes(allUndercut).size === 1, 'a plane touched only by undercut tools is hidden');
}

/* ---------- ground-truth: synthetic job with a hand-computable expected shape ----------
   Three single-pass channel cuts: base (Z+, ordinary case), and two planes sharing the world X
   axis with OPPOSITE sign (I90/J90/K0 -> axis +X, I-90/J90/K0 -> axis -X - the exact real angle
   pairs found in O1224 at ids 1 and 2). Expected world-space removed/solid regions are hand-
   derived from each plane's own rotation matrix (computed independently, not by calling any code
   under test) and checked against the actual pipeline's output. This is the first "does it match
   a known answer" check tri-dexel has - not just "does it look plausible". Originally ported from
   the design spike (spikes/11_groundtruth.js); the expected axis/coordinates below were
   re-derived after planeMatrix was corrected to Fanuc's real Z-X-Z convention (found and verified
   against a real posted job's stock geometry - see docs/plan/NOTES.md), since the old expected
   values were computed from the wrong (roll-pitch-yaw) rotation order and this test correctly
   failed once that got fixed. Still confirmed to actually discriminate: forcing the old sign-blind
   behavior back in fails this test exactly where expected. */
{
  const gcode = `G21 G90 G17
(T1  D=10. CR=0. - FLAT END MILL)
T1 M6
S5000 M3
(-- plane 0: base, ordinary Z+ channel --)
G0 X20. Y25. Z10.
G1 Z4. F500.
G1 X40. F800.
G0 Z10.
(-- plane A: I90 J90 K0 -> world axis +X --)
G68.2 X0 Y0 Z0 I90. J90. K0.
G53.1
G0 X20. Y25. Z10.
G1 Z4. F500.
G1 X40. F800.
G0 Z10.
G69
(-- plane B: I-90 J90 K0 -> world axis -X --)
G68.2 X0 Y0 Z0 I-90. J90. K0.
G53.1
G0 X20. Y25. Z10.
G1 Z4. F500.
G1 X40. F800.
G0 Z10.
G69
M9
`;
  const P = NC.parseProgram(gcode);
  const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));
  const td = NC.buildTriDexel(P, 240, 3);
  ok(JSON.stringify([...td.grids.keys()].sort()) === JSON.stringify(['X+', 'X-', 'Z+']), `synthetic job builds exactly the 3 grids it needs (got ${[...td.grids.keys()]})`);
  for (let i = 0; i < P.n; i++) NC.cutTriDexelMove(td, P, simTools, i, 0, 1);

  // Reads td.grids' HeightSim instances directly (public fields, same as tests/planes.test.js
  // reading sim.h) - mirrors the sampling logic fuseTriDexel uses internally, but duplicated here
  // deliberately so this test doesn't just re-check fuseTriDexel's own math against itself.
  const sampleSolid = (key, wx, wy, wz) => {
    const grid = td.grids.get(key);
    const axisIdx = 'XYZ'.indexOf(key[0]), sign = key[1] === '+' ? 1 : -1;
    let ax, ay, az;
    if (axisIdx === 2) { ax = wx; ay = wy; az = sign * wz; }
    else if (axisIdx === 0) { ax = wy; ay = wz; az = sign * wx; }
    else { ax = wz; ay = wx; az = sign * wy; }
    const i = Math.floor((ax - grid.x0) / grid.dx), j = Math.floor((ay - grid.y0) / grid.dy);
    if (i < 0 || j < 0 || i > grid.nx - 1 || j > grid.ny - 1) return true;
    return az <= grid.h[j * grid.nx + i] + 1e-4;
  };
  const solidAt = (wx, wy, wz) => { for (const key of td.grids.keys()) if (!sampleSolid(key, wx, wy, wz)) return false; return true; };

  // Expectations re-derived from the fixed engine's own worldizeMoves output for these exact
  // moves (not hand algebra - see the investigation in docs/plan/NOTES.md for why hand-deriving
  // this by assumed rotation order is exactly how the old, wrong values got baked in). Local
  // channel (both A and B): rapid -> (20,25,10), plunge to Z=4, sweep X 20->40 at Y=25,Z=4.
  // Removed (local): local_z > 4 within the swept footprint (test well inside at x=30). Plane 0
  // (identity): world = local directly. Plane A (I90 J90 K0), confirmed via worldizeMoves: world
  // = (local_z, local_x, local_y). Plane B (I-90 J90 K0): world = (-local_z, -local_x, local_y).
  const cases = [
    ['plane0 removed (local 30,25,8, identity)', [30, 25, 8], false],
    ['plane0 solid   (local 30,25,2, identity)', [30, 25, 2], true],
    ['planeA removed (local 30,25,8 -> world (z,x,y))', [8, 30, 25], false],
    ['planeA solid   (local 30,25,2 -> world (z,x,y))', [2, 30, 25], true],
    ['planeB removed (local 30,25,8 -> world (-z,-x,y))', [-8, -30, 25], false],
    ['planeB solid   (local 30,25,2 -> world (-z,-x,y))', [-2, -30, 25], true],
    // same-axis-opposite-sign isolation: plane A and B share the world X axis with opposite tool
    // direction - the whole reason grids are keyed by SIGNED axis, not just axis.
    ["planeA's removed point is not masked back to solid by planeB's grid (sign isolation)", [8, 30, 25], false],
    ["planeB's solid point is not wrongly removed by planeA's grid (sign isolation)", [-2, -30, 25], true],
  ];
  for (const [label, [wx, wy, wz], expectSolid] of cases) {
    const got = solidAt(wx, wy, wz);
    ok(got === expectSolid, `${label}: got solid=${got}, want solid=${expectSolid}`);
  }

  const mesh = NC.fuseTriDexel(td, 60);
  ok(mesh.idx.length > 0, 'synthetic job: fused mesh is nonempty');
}

/* ---------- real O1224 job: full run ---------- */
{
  const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
  const td = NC.buildTriDexel(real, 120, 5);
  ok(td.grids.size === 5, `real job builds exactly the 5 signed grids it needs (got ${td.grids.size}: ${[...td.grids.keys()]})`);
  ok(!td.grids.has('Z-'), 'no Z- grid built (O1224 has no plane with that tool axis)');

  const before = new Map([...td.grids].map(([k, g]) => [k, g.h.slice()]));
  for (let i = 0; i < real.n; i++) NC.cutTriDexelMove(td, real, simTools, i, 0, 1);

  // Oblique plane 7's moves must never have touched any tri-dexel grid - keyOfMove[i] is null
  // for every one of its moves, so cutTriDexelMove no-ops on all of them by construction; spot
  // check this directly rather than just trusting the no-op.
  let obliqueMovesTouchedAGrid = false;
  for (let i = 0; i < real.n; i++) if (real.PL[i] === 7 && td.keyOfMove[i] !== null) obliqueMovesTouchedAGrid = true;
  ok(!obliqueMovesTouchedAGrid, "plane 7's (oblique) moves were never assigned to any tri-dexel grid");

  // At least one aligned-plane grid actually shows real material removed.
  let anyCut = false;
  for (const [key, grid] of td.grids) {
    let minH = Infinity; for (let k = 0; k < grid.h.length; k++) minH = Math.min(minH, grid.h[k]);
    if (minH < grid.zTop - 1e-6) anyCut = true;
    ok(true, `grid ${key}: min height ${minH.toFixed(3)} of top ${grid.zTop.toFixed(3)}`);
  }
  ok(anyCut, 'at least one tri-dexel grid actually got cut on the real job');

  const mesh = NC.fuseTriDexel(td, 60);
  ok(mesh.idx.length > 0, 'real job: fused mesh is nonempty');
  ok(mesh.pos.length > 0, 'real job: fused mesh has vertices');
  // fuseTriDexel sizes its voxel grid via Math.round(axisLength / cellSize), which can round up -
  // the grid can then overshoot td.box by a fraction of one voxel cell on axes where that happens
  // (confirmed: predicted overflow from the rounding arithmetic matches observed values exactly).
  // That's expected voxel quantization, not a correctness bug, so the tolerance here is one full
  // fuse-resolution cell width, not a tight epsilon.
  const fuseCell = Math.max(td.box.xmax - td.box.xmin, td.box.ymax - td.box.ymin, td.box.zmax - td.box.zmin) / 60;
  let ok2 = true;
  for (let i = 0; i < mesh.pos.length; i += 3) {
    if (mesh.pos[i] < td.box.xmin - fuseCell || mesh.pos[i] > td.box.xmax + fuseCell) ok2 = false;
    if (mesh.pos[i + 1] < td.box.ymin - fuseCell || mesh.pos[i + 1] > td.box.ymax + fuseCell) ok2 = false;
    if (mesh.pos[i + 2] < td.box.zmin - fuseCell || mesh.pos[i + 2] > td.box.zmax + fuseCell) ok2 = false;
  }
  ok(ok2, 'real job: every fused mesh vertex lies inside the shared world box (within one fuse voxel cell)');
}

/* ---------- oblique fallback is genuinely unmodified existing code ----------
   buildPlaneSims' new onlyIds parameter, restricted to just the oblique plane (7), must produce
   byte-identical .h/.op arrays to running plane 7 alone through today's unrestricted
   buildPlaneSims/cutMoveMulti - the concrete proof this isn't a reimplementation. */
{
  const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
  const box0 = NC.boxFromMoves(real, 0, 10);

  const unrestricted = NC.buildPlaneSims(real, box0, 120);
  for (let i = 0; i < real.n; i++) NC.cutMoveMulti(unrestricted, real, simTools, i, 0, 1);
  const baseline = unrestricted.get(7);

  const restricted = NC.buildPlaneSims(real, box0, 120, 5, new Set([7]));
  ok(restricted.size === 1 && restricted.has(7), `buildPlaneSims restricted to {7} builds exactly one sim (got ${restricted.size}: ${[...restricted.keys()]})`);
  for (let i = 0; i < real.n; i++) NC.cutMoveMulti(restricted, real, simTools, i, 0, 1);
  const onlyOblique = restricted.get(7);

  let maxHDiff = 0, maxOpDiff = 0;
  for (let k = 0; k < baseline.h.length; k++) maxHDiff = Math.max(maxHDiff, Math.abs(baseline.h[k] - onlyOblique.h[k]));
  for (let k = 0; k < baseline.op.length; k++) maxOpDiff = Math.max(maxOpDiff, Math.abs(baseline.op[k] - onlyOblique.op[k]));
  ok(maxHDiff === 0, `restricted buildPlaneSims({7}) .h is byte-identical to the unrestricted run's plane 7 (max diff ${maxHDiff})`);
  ok(maxOpDiff === 0, `restricted buildPlaneSims({7}) .op is byte-identical to the unrestricted run's plane 7 (max diff ${maxOpDiff})`);

  // omitted onlyIds must behave exactly as before (every plane, not just aligned/oblique subsets).
  const omitted = NC.buildPlaneSims(real, box0, 120);
  ok(omitted.size === real.planes.length, `buildPlaneSims with onlyIds omitted still builds one sim per plane (${omitted.size} of ${real.planes.length})`);
}

/* ---------- obliquePlaneSolid: don't trust a cell a plane never actually cut ----------
   buildPlaneSims fits a plane's box to its own moves' EXTENTS, which can be much larger than
   what it actually cuts (e.g. a perimeter/rim pass whose path spans nearly the whole part while
   only removing a thin band). A cell inside that box but never touched by a real cut is still at
   its initial value (op===0) and must read as "no opinion" (true), not "empty" (false) - an
   unclipped version wrongly excludes real material that belongs to some OTHER plane/grid
   entirely. Found tracing a real ~20mm depth error to exactly this on a real job (O1160's plane
   1, a genuine 14.66deg tilt) during the tri-dexel/oblique-fusion spike - see spike/NOTES3.md and
   spike/fusedpipeline.js for the investigation; that job's data is private and not in fixtures/,
   so this pins the fix with a minimal synthetic case instead. */
{
  const sim = new NC.HeightSim({ xmin: 0, xmax: 10, ymin: 0, ymax: 10, zbot: 0, ztop: 10 }, 10);
  const T = { R: 1, kind: 0 };
  sim.cut(2, 2, 5, 2, 2, 5, T, 1); // one small plunge near (2,2) - leaves h=5, op=1 there
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin = [0, 0, 0];

  // Untouched cell, tested BELOW the box's own zBot - an unclipped version would read this as
  // "empty" (local z < zBot), when the correct answer is "this plane has no opinion here at all".
  ok(NC.obliquePlaneSolid(sim, identity, origin, 8, 8, -1) === true,
    'untouched cell: no opinion even below the box zBot (would be wrongly excluded unclipped)');
  // The one cell this plane's real cut DID touch must still assert its real, correct constraint.
  ok(NC.obliquePlaneSolid(sim, identity, origin, 2, 2, 6) === false,
    'cut cell: correctly excludes material above where it actually removed material');
  ok(NC.obliquePlaneSolid(sim, identity, origin, 2, 2, 4) === true,
    'cut cell: correctly allows material below its own cut depth');

  // A CUT cell (op!=0), queried BELOW the box's own zBot: the plane's real box is tightly padded
  // around just its own moves' local Z extent (as little as 0.5mm - see app.js's tiltPad), not the
  // real stock's actual depth. Fusing into one mesh queries every plane along a WORLD-vertical
  // ray, which does NOT stay within one local Z column when the local frame is tilted - it can
  // swing local Z far outside a plane's own narrow real range (confirmed on O1160: a 25mm world-Z
  // sweep crossed local Z from ~59 to past 88 while plane 1's own box only spanned 75.98-79.25).
  // "Below zBot = empty" is correct for a box that IS the real stock's floor (tri-dexel's grids);
  // for an oblique plane's narrow box it only means "below the deepest real cut THIS plane ever
  // made" - querying below that must be "no opinion", not "empty", even on a cell this plane did
  // cut. Missing this produced a real, visible bug: O1160's side walls rendered as disconnected
  // floating slivers (a solid-empty-solid void), because a WORLD-vertical ray through plane 1
  // wrongly read "empty" for most of the wall's real height, far outside plane 1's own ~1mm-thick
  // local box.
  ok(NC.obliquePlaneSolid(sim, identity, origin, 2, 2, -1) === true,
    'cut cell, queried below zBot: no opinion (out of this plane\'s real Z range), not wrongly excluded');
}

/* ---------- fuseTriDexel: optional oblique-plane AND-fusion into the same mesh ----------
   New trailing (obliqueSims, planeById) parameters, both optional - omitted, 100% today's
   tri-dexel-only behaviour (every existing call site/test above still passes with exactly 2
   args, proving that). Passed, a genuinely oblique plane's own HeightSim (buildPlaneSims,
   unmodified) is ANDed in via obliquePlaneSolid, so the real oblique fallback joins the SAME
   watertight mesh instead of being drawn as a disconnected slab - the point of app.js's fold-in.
   Uses two widely-separated moves on the oblique plane so its own box (fit to move extent) spans
   a big chunk of the shared world box while only cutting two small spots within it - exactly the
   shape of bug obliquePlaneSolid's test above guards against, now exercised end-to-end. */
{
  const gcode = `G21 G90 G17
(T1  D=10. CR=0. - FLAT END MILL)
T1 M6
S5000 M3
(-- plane 0: base block, one real feed move to establish real stock extent --)
G0 X0. Y0. Z10.
G1 Z9. F500.
G1 X100. Y100. F800.
G0 Z10.
(-- plane C: a genuine oblique tilt (I80 J90 K0 - same real angle family as O1224's plane 7) --)
G68.2 X0 Y0 Z0 I80. J90. K0.
G53.1
G0 X5. Y5. Z10.
G1 Z8. F500.
G0 Z10.
G0 X90. Y90. Z10.
G1 Z9.5 F500.
G0 Z10.
G69
M9
`;
  const P = NC.parseProgram(gcode);
  const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));
  const cls = NC.classifyPlanes(P.planes);
  ok(cls.obliqueIds.has(1), `plane 1 (I80/J90/K0) is genuinely oblique, not near any world axis (got aligned=${[...cls.alignedIds]}, oblique=${[...cls.obliqueIds]})`);

  const td = NC.buildTriDexel(P, 60, 5);
  for (let i = 0; i < P.n; i++) NC.cutTriDexelMove(td, P, simTools, i, 0, 1);
  const meshAlone = NC.fuseTriDexel(td, 40);

  const obliqueSims = NC.buildPlaneSims(P, undefined, 60, 5, new Set([1]));
  ok(obliqueSims.size === 1 && obliqueSims.has(1), `buildPlaneSims restricted to the oblique plane builds exactly one sim (got ${[...obliqueSims.keys()]})`);
  for (let i = 0; i < P.n; i++) NC.cutMoveMulti(obliqueSims, P, simTools, i, 0, 1);
  const planeById = new Map(P.planes.map(p => [p.id, p]));
  const meshCombined = NC.fuseTriDexel(td, 40, obliqueSims, planeById);

  ok(meshCombined.idx.length > 0, 'combined fuse: mesh is nonempty');
  // The regression this guards against: an unclipped oblique AND-test wipes out most of the
  // shared box (measured on the real job: 2.1M of 10.2M voxels wrongly excluded by one plane
  // alone). A correctly-clipped combine should stay in the same ballpark as tri-dexel alone, not
  // collapse to a sliver - loose bound (not exact equality: the oblique plane's own two real cuts
  // legitimately remove a little extra material near its own moves).
  ok(meshCombined.pos.length > meshAlone.pos.length * 0.5,
    `combined fuse keeps most of the shared box's volume, not collapsed by the oblique plane's box (alone=${meshAlone.pos.length / 3} verts, combined=${meshCombined.pos.length / 3} verts)`);
}

/* ---------- smooth stock surface (stockField + surfaceNets) ----------
   Replaces the blocky cube-face mesh for display. Pinned: vertices really sit on the stock
   surface, a flat cut floor comes out at its exact depth (not rounded to a voxel), the finished
   shape as a field reads "nothing left" on its own surface, and the real job stays in its box. */
{
  const P = NC.parseProgram(`G21 G90 G17
(T1  D=10. CR=0. - FLAT END MILL)
T1 M6
S5000 M3
G0 X10. Y10. Z10.
G1 Z-3.37 F500.
G1 X40. F800.
G1 Y30.
G1 X10.
G1 Y10.
G0 Z10.
M30`);
  const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));
  const box = { xmin: 0, xmax: 50, ymin: 0, ymax: 40, zbot: -10, ztop: 0 };
  const td = NC.buildTriDexel(P, 200, 3, box);
  for (let i = 0; i < P.n; i++) NC.cutTriDexelMove(td, P, simTools, i, 0, 1);
  const m = NC.meshTriDexelSmooth(td, 100, new Map(), new Map());
  ok(m.idx.length > 0 && m.nor.length === m.pos.length, `smooth mesh built (${m.idx.length / 3} triangles, one normal per vertex)`);
  let worst = 0; const errs = [];
  for (let q = 0; q < m.pos.length; q += 3) { const f = Math.abs(m.field.value(m.pos[q], m.pos[q + 1], m.pos[q + 2])); errs.push(f); if (f > worst) worst = f; }
  errs.sort((a, b) => a - b);
  const cellSm = m.cell, med = errs[Math.floor(errs.length / 2)], p95 = errs[Math.floor(errs.length * 0.95)];
  ok(med < 0.005, `typical vertex sits on the stock surface (median off by ${med.toFixed(4)} mm)`);
  ok(p95 < 0.2 * cellSm && worst < 0.6 * cellSm, `edge/corner vertices stay within a fraction of a ${cellSm.toFixed(2)}mm cell (95th pct ${p95.toFixed(3)}, worst ${worst.toFixed(3)} mm)`);
  // the channel floor, well away from its walls: exactly -3.37, not snapped to a lattice level
  let floorZ = []; for (let q = 0; q < m.pos.length; q += 3) { const x = m.pos[q], y = m.pos[q + 1]; if (Math.abs(x - 25) < 5 && Math.abs(y - 10) < 1.5 && m.nor[q + 2] > 0.99) floorZ.push(m.pos[q + 2]); }
  ok(floorZ.length > 3 && floorZ.every(z => Math.abs(z + 3.37) < 0.005), `cut floor comes out at its exact depth -3.37 (got ${floorZ.length} vertices, ${floorZ.slice(0, 3).map(z => z.toFixed(4))})`);
  ok(floorZ.length && m.field.op(25, 10, -3.37) === P.OP[P.n - 3] + 1, 'the field names the operation that cut the floor');
  // the finished program as a field compared against itself: no material left anywhere on the surface
  const fin = NC.stockField(td, new Map(), new Map(), new Map([['Z+', { h: td.grids.get('Z+').h.slice(), op: td.grids.get('Z+').op.slice() }]]));
  let maxLeft = 0; for (let q = 0; q < m.pos.length; q += 3) maxLeft = Math.max(maxLeft, m.field.value(m.pos[q], m.pos[q + 1], m.pos[q + 2]) - fin.value(m.pos[q], m.pos[q + 1], m.pos[q + 2]));
  ok(maxLeft < 1e-6, `finished state vs itself reads zero material left everywhere (max ${maxLeft.toExponential(1)})`);

  // real O1224 (5 grids + 1 oblique plane): nonempty and inside the shared box
  const simToolsR = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
  const tdR = NC.buildTriDexel(real, 120, 5);
  for (let i = 0; i < real.n; i++) NC.cutTriDexelMove(tdR, real, simToolsR, i, 0, 1);
  const mr = NC.meshTriDexelSmooth(tdR, 60, new Map(), new Map());
  const cell = Math.max(tdR.box.xmax - tdR.box.xmin, tdR.box.ymax - tdR.box.ymin, tdR.box.zmax - tdR.box.zmin) / 60;
  let inside = true; for (let q = 0; q < mr.pos.length; q += 3) { const [x, y, z] = [mr.pos[q], mr.pos[q + 1], mr.pos[q + 2]]; if (x < tdR.box.xmin - cell || x > tdR.box.xmax + cell || y < tdR.box.ymin - cell || y > tdR.box.ymax + cell || z < tdR.box.zmin - cell || z > tdR.box.zmax + cell) inside = false; }
  ok(mr.idx.length > 1000 && inside, `real O1224 smooth mesh: ${mr.idx.length / 3} triangles, all inside the shared box`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
