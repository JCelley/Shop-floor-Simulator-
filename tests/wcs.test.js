// Work offset per operation, shown next to Restart seq # (John, 2026-09-29). Two-table machines
// run one program with "G54.1 P#153", #153 picking each table's offset - the header lists every
// value the program gives that variable ("G54.1 P1 or G54.1 P2").
const fs = require('fs'), path = require('path');
const NC = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const prog = body => NC.parseProgram('G21 G90\n' + body);
const tc = (n, t) => `(OP${n})\nN${n} G100 T${t} X0 Y0 G43 Z10. H${t} D${t} S1000 M03\nG1 Z0 F100.\nX10.\n`;

{
  const P = prog('G54\n' + tc(10, 1) + 'G55\n' + tc(20, 2) + 'G54.1 P32\n' + tc(30, 3));
  ok(P.ops.map(o => o.wcsText).join('|') === 'G54|G55|G54.1 P32', 'plain offsets, one per op: ' + P.ops.map(o => o.wcsText).join(' | '));
}
{
  // the variable is set in the program for each table (here in an IF branch the machine picks)
  const P = prog('IF[#1000 EQ 1] GOTO 10\n#153 = 2\nGOTO 20\nN10 #153 = 1\nN20\nG54.1 P#153\n' + tc(10, 1));
  ok(P.ops[0].wcsText === 'G54.1 P1 or G54.1 P2' && !P.ops[0].wcsFromMachine, 'G54.1 P#153 with #153 set to 1 and 2 in the program: ' + P.ops[0].wcsText);
}
{
  const P = prog('G54.1P#153\n' + tc(10, 1));
  ok(P.ops[0].wcsText === 'G54.1 P#153' && P.ops[0].wcsFromMachine && P.ops[0].wcsVar === 153, 'never set in the program: shown as written, flagged as set on the machine');
}
{
  // real jobs: O1228 is G54 throughout, and nothing breaks without an offset
  const P = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1228.NC'), 'utf8'));
  ok(P.ops.every(o => o.wcsText === 'G54'), 'real O1228: every op on G54');
  ok(prog(tc(10, 1)).ops[0].wcsText === null, 'no offset in the program: nothing shown');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
