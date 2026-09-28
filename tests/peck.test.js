// Peck drilling cycles are simulated peck by peck (John, 2026-09-27: "the canned pecking cycle
// doesn't simulate the pecks"). Expected moves are worked out by hand from the cycle words.
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;
const moves = P => Array.from({ length: P.n }, (_, i) => ({ k: P.K[i], x: P.X[i], y: P.Y[i], z: P.Z[i] }));

// G83, R2, Z-10, Q3 from Z10: pecks to -1, -4, -7, then the last feed to -10. After each peck a
// rapid out to R (2), then a rapid back down to 0.5 above that peck's depth.
{
  const P = NC.parseProgram('G21 G90\nT1 M6\nS1000 M3\nG0 X0 Y0 Z10\nG98 G83 X5 Y5 Z-10 R2 Q3 F100\nG80\nM30\n');
  const m = moves(P).filter(v => near(v.x, 5) && near(v.y, 5));
  const feeds = m.filter(v => v.k === 1).map(v => +v.z.toFixed(3));
  ok(JSON.stringify(feeds) === JSON.stringify([-1, -4, -7, -10]), `G83 feeds peck by peck: ${feeds.join(', ')}`);
  const afterFirst = m.slice(m.findIndex(v => v.k === 1) + 1, m.findIndex(v => v.k === 1) + 3).map(v => [v.k, +v.z.toFixed(3)]);
  ok(JSON.stringify(afterFirst) === JSON.stringify([[0, 2], [0, -0.5]]), `after a peck: rapid out to R, rapid back to just above the last depth ${JSON.stringify(afterFirst)}`);
  ok(near(m[m.length - 1].z, 10) && m[m.length - 1].k === 0, 'G98: back up to the starting height at the end');
  // the hole is the same as one straight plunge
  const one = NC.parseProgram('G21 G90\nT1 M6\nS1000 M3\nG0 X0 Y0 Z10\nG98 G81 X5 Y5 Z-10 R2 F100\nG80\nM30\n');
  ok(one.total < P.total, `pecking takes longer than a straight plunge (${P.total.toFixed(1)} s vs ${one.total.toFixed(1)} s)`);
}

// G73 (chip break): no trip out to R between pecks, only a small back-off
{
  const P = NC.parseProgram('G21 G90\nT1 M6\nS1000 M3\nG0 X0 Y0 Z10\nG99 G73 X0 Y0 Z-10 R2 Q3 F100\nG80\nM30\n');
  const m = moves(P), first = m.findIndex(v => v.k === 1);
  const feeds = m.filter(v => v.k === 1).map(v => +v.z.toFixed(3));
  ok(JSON.stringify(feeds) === JSON.stringify([-1, -4, -7, -10]), `G73 feeds peck by peck: ${feeds.join(', ')}`);
  ok(m[first + 1].k === 0 && near(m[first + 1].z, -0.5) && m[first + 2].k === 1, 'G73 only backs off 0.5 before the next peck');
}

// Q modal across holes, inches converted, and a depth that is an exact multiple of Q adds no extra peck
{
  const P = NC.parseProgram('G20 G90\nT1 M6\nS1000 M3\nG0 X0 Y0 Z1.\nG98 G83 X0 Y0 Z-.3 R.1 Q.2 F10.\nX1.\nG80\nM30\n');
  const feeds = moves(P).filter(v => v.k === 1).map(v => +(v.z / 25.4).toFixed(3));
  ok(JSON.stringify(feeds) === JSON.stringify([-0.1, -0.3, -0.1, -0.3]), `inch G83 on two holes, Q kept for the second: ${feeds.join(', ')}`);
}

// G81 / G83 without Q stay a single plunge
{
  const P = NC.parseProgram('G21 G90\nT1 M6\nG0 X0 Y0 Z10\nG83 X0 Y0 Z-10 R2 F100\nG80\n');
  ok(moves(P).filter(v => v.k === 1).length === 1, 'G83 with no Q is one plunge');
}

// real job: O1228's "G83 X-0.7525 Y0 Z3.6222 R3.9387 Q0.02" is 0.3165" deep -> 16 pecks of .02
// (the last one short), all at that one hole
{
  const P = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1228.NC'), 'utf8'));
  const L = P.lines.findIndex(l => /^G83 X-0\.7525/.test(l)) + 1;
  const hole = moves(P).filter((v, i) => P.LN[i] === L && v.k === 1);
  const deepest = Math.min(...hole.map(v => v.z)) / 25.4;
  ok(hole.length === 16 && near(deepest, 3.6222, 1e-4), `O1228's G83 hole: ${hole.length} feeds down to Z${deepest.toFixed(4)}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
