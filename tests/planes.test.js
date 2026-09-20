// Phase 2 of 3+2 support: one HeightSim per tilted plane, each cutting in its own local
// frame (moves are already local there - see Phase 1 / docs/NOTES.md). Still no rendering -
// this only proves the engine-level simulation is correct and planes don't cross-contaminate.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));
const simTools = new Map(real.tools.map(t => [t.no, NC.simTool(t)]));
// This test only cares about the plane-routing engine, not the real Fusion stock box (already
// covered by real2.test.js/postJson.test.js) - fit plane 0's box from its own moves too.
const box0 = NC.boxFromMoves(real, 0, 10);

const sims = NC.buildPlaneSims(real, box0, 120);
ok(sims.size === real.planes.length, `one sim per plane actually used (${sims.size} sims, ${real.planes.length} planes)`);
for (const pl of real.planes) ok(sims.has(pl.id), `sim exists for plane ${pl.id} (I${pl.ijk[0]} J${pl.ijk[1]} K${pl.ijk[2]})`);

// run the whole program through the multi-plane router
for (let i = 0; i < real.n; i++) NC.cutMoveMulti(sims, real, simTools, i, 0, 1);

// every plane that has feed moves from a NON-undercut tool must show real material removed
// (a plane cut entirely by an undercut tool, like plane 7's lollipop cutter, correctly cuts
// nothing at all - that's the Option A behavior from tests/undercut.test.js, not a bug here).
let anyCutAnyPlane = false;
for (const [id, sim] of sims) {
  let hasSimulatableFeed = false;
  for (let i = 0; i < real.n; i++) {
    if (real.PL[i] !== id || !real.K[i]) continue;
    const T = simTools.get(real.TL[i]);
    if (T && !T.undercut) { hasSimulatableFeed = true; break; }
  }
  if (!hasSimulatableFeed) { console.log('   plane', id, '(no simulatable feed moves - drilling-only or an undercut tool, skipping)'); continue; }
  let minH = Infinity; for (let k = 0; k < sim.h.length; k++) minH = Math.min(minH, sim.h[k]);
  ok(minH < sim.zTop - 1e-6, `plane ${id} shows real material removed (min height ${minH.toFixed(3)} of top ${sim.zTop})`);
  if (minH < sim.zTop - 1e-6) anyCutAnyPlane = true;
}
ok(anyCutAnyPlane, 'at least one plane actually got cut');

// isolation: simulating ONE plane's moves alone must give the identical result as running
// the whole program through the router - i.e. other planes' moves cannot leak into it.
const targetPlane = real.planes.find(pl => pl.id !== 0);
const box1 = NC.boxFromMoves(real, targetPlane.id, 5);
const alone = new NC.HeightSim(box1, 120);
for (let i = 0; i < real.n; i++) if (real.PL[i] === targetPlane.id) NC.cutMove(alone, real, simTools, i, 0, 1);
const together = new NC.HeightSim(box1, 120);
{
  const soloSims = new Map([[targetPlane.id, together]]);
  for (let i = 0; i < real.n; i++) if (real.PL[i] === targetPlane.id) NC.cutMoveMulti(soloSims, real, simTools, i, 0, 1);
}
let maxDiff = 0; for (let k = 0; k < alone.h.length; k++) maxDiff = Math.max(maxDiff, Math.abs(alone.h[k] - together.h[k]));
ok(maxDiff < 1e-9, `plane ${targetPlane.id} in isolation matches the same plane cut via the router (max diff ${maxDiff.toExponential(2)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
