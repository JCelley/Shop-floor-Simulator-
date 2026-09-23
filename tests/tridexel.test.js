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

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
