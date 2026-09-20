// Phase 1 of 3+2 support: parse G68.2/G53.1/G69, tag every move with which tilted plane
// it belongs to, and expose each plane's rotation matrix. Does NOT yet change stock
// removal - see docs/NOTES.md. Tested against a real 3+2 job (O1224), not invented data.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, `${m}: got ${a.toFixed(4)} want ${b} ±${t}`);

// ---- an untilted program must be unaffected: exactly the base plane, old-style warning if any
const flat = NC.parseProgram('G21 G90 G17\nT1 M6\nG0 X0 Y0 Z0\nG1 X10\nA30.\nG1 X0\n');
ok(flat.planes.length === 1 && flat.planes[0].id === 0, 'no G68.2 -> only the base plane exists');
ok([...flat.PL].every(p => p === 0), 'no G68.2 -> every move tagged plane 0');
ok(flat.warnings.includes('Rotary axis moves (A/B/C) are ignored'), 'stray A/B/C without G68.2 still warns the old way');

// ---- a minimal synthetic tilt: verify G68.2 registers a plane, G53.1 activates it, G69 cancels it
const t = NC.parseProgram('G21 G90 G17\nT1 M6\nG0 X0 Y0 Z0\nG1 X1 Y0\nG00 A90. C90.\nG68.2 X0 Y0 Z0 I90. J90. K0.\nG53.1\nG1 X1 Y0\nG69\nG1 X2 Y0\n');
ok(t.planes.length === 2, `one tilted plane registered (got ${t.planes.length - 1})`);
ok(t.PL[0] === 0 && t.PL[1] === 0, 'moves before G53.1 stay on the base plane');
ok(t.PL[2] === 1, 'move between G53.1 and G69 tagged with the tilted plane');
ok(t.PL[3] === 0, 'move after G69 back on the base plane');
// exactly 4 real moves (G0 X0Y0Z0, G1 X1, G1 X1 [tilted], G1 X2) - the G68.2 line's own
// X0 Y0 Z0 must NOT have become a 5th, phantom rapid move under the still-modal G0/G1.
ok(t.n === 4, `no phantom move from the G68.2 line's own X0 Y0 Z0 (got ${t.n} moves)`);

// ---- real 3+2 job: O1224 (OP50 A SIDE), 7 distinct orientations confirmed by grep beforehand
const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1224.NC'), 'utf8'));
console.log('O1224:', real.n, 'moves,', real.planes.length - 1, 'tilted planes,', real.warnings.length, 'warnings');
ok(real.planes.length - 1 === 7, `7 distinct tilted orientations (got ${real.planes.length - 1})`);
ok(real.notes.some(n => /tilted work plane/i.test(n)), 'a specific tilted-plane note is shown');
ok(!real.warnings.includes('Rotary axis moves (A/B/C) are ignored'), 'the generic rotary warning is replaced, not duplicated, once real planes exist');
const tiltedMoves = [...real.PL].filter(p => p !== 0).length;
ok(tiltedMoves > 1000, `a meaningful fraction of the program is tilted (${tiltedMoves} of ${real.n} moves)`);

// every plane's matrix must be a proper rotation: orthonormal, determinant +1
const det3 = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
const apply = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
for (const pl of real.planes) {
  near(det3(pl.matrix), 1, 1e-9, `plane ${pl.id} (I${pl.ijk[0]} J${pl.ijk[1]} K${pl.ijk[2]}) matrix determinant`);
  const v = apply(pl.matrix, [1, 0, 0]);
  near(Math.hypot(v[0], v[1], v[2]), 1, 1e-9, `plane ${pl.id} preserves length (orthonormal)`);
}
// pure-yaw sanity check: I0 J0 K-180 only rotates about Z, so the local Z axis must stay world Z
const yawOnly = real.planes.find(pl => Math.abs(pl.ijk[0]) < 1e-6 && Math.abs(pl.ijk[1]) < 1e-6 && Math.abs(pl.ijk[2] + 180) < 1e-6);
ok(!!yawOnly, 'the pure-yaw plane (I0 J0 K-180) is present in this file');
if (yawOnly) { const z = apply(yawOnly.matrix, [0, 0, 1]); near(z[2], 1, 1e-9, 'pure yaw (K only) leaves the local Z axis pointing straight up in world space'); }

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
