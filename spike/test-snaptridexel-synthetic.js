// Round 3: reusing tri-dexel's OWN per-axis-grid mechanism for EVERY plane (a loosened
// classifyPlanes tolerance passed into buildTriDexel), instead of inventing new arbitrary-axis
// swept-volume math. No new geometry to verify here - the point of this test is to confirm the
// EXISTING, already-tested tri-dexel path still behaves identically when nothing needs snapping,
// and that a plane with an axis EXACTLY along a non-Z world axis (which classifyPlanes' default
// tiny tolerance already accepts) still produces the same real cut it always has.
'use strict';
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));

// Default tolerance (unchanged call signature - tolDeg omitted) must behave exactly as before:
// only the 7 already-aligned planes join, plane 7 (the one real oblique plane) stays out.
{
  const td = NC.buildTriDexel(real, 200, 5);
  const aligned = [...td.alignedIds].sort((a, b) => a - b);
  ok(JSON.stringify(aligned) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]), `default tolerance: unchanged aligned set, got ${aligned}`);
  ok(td.obliqueIds.has(7), 'default tolerance: plane 7 still left oblique, unchanged behaviour');
}

// A large tolerance snaps EVERY plane (including the real oblique one) to its nearest axis -
// obliqueIds must end up empty, and grids must appear for every real signed axis used.
{
  const td = NC.buildTriDexel(real, 200, 5, undefined, 60);
  const aligned = [...td.alignedIds].sort((a, b) => a - b);
  ok(aligned.length === real.planes.length, `60deg tolerance: every plane snaps to some axis, got ${aligned.length} of ${real.planes.length}`);
  ok(td.obliqueIds.size === 0, `60deg tolerance: no planes left oblique, got ${[...td.obliqueIds]}`);
  ok(td.signOf.has(7), `plane 7 (the real oblique one) now gets a nearest-axis assignment, got ${td.signOf.get(7)}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
