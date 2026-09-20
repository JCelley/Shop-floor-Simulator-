const NC = require('../src/engine.js');
const fs = require('fs'), path = require('path');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, `${m}: got ${a.toFixed(4)} want ${b} ±${t}`);

// ---- parse demo
const P = NC.parseProgram(NC.demoProgram());
console.log('moves', P.n, 'ops', P.ops.map(o => `${o.label}(T${o.tool}@${o.move})`).join(' | '));
console.log('tools', P.tools.map(t => `T${t.no} ${t.type} D${t.D} rc${t.rc} fl${t.flute} st${t.stick}`).join(' | '));
console.log('bounds', JSON.stringify(P.bounds), 'time s', P.total.toFixed(1), 'warnings', P.warnings);
ok(P.ops.length === 5, '5 operations detected');
ok(P.tools.length === 5, '5 tools detected');
ok(P.tools[0].type === 'flat' && P.tools[0].D === 10, 'T1 flat 10');
ok(P.tools[2].type === 'drill', 'T3 drill');
ok(P.tools[3].type === 'chamfer', 'T4 chamfer');
ok(P.tools[4].type === 'ball' && P.tools[4].D === 6, 'T5 ball 6');
ok(P.warnings.length === 0, 'no warnings');

// ---- arc with R word:  from (24,-14) G3 to (26,-12) R2, centre (24,-12)
const A = NC.parseProgram('G21 G90 G17\nT1 M6\nG0 X24 Y-14 Z0\nG1 F500\nG3 X26 Y-12 R2\n');
let maxErr = 0;
for (let i = 1; i < A.n; i++) maxErr = Math.max(maxErr, Math.abs(Math.hypot(A.X[i] - 24, A.Y[i] + 12) - 2));
ok(A.n > 3 && maxErr < 1e-4, `R-arc radius error ${maxErr.toExponential(2)} over ${A.n} pts`);
// CW check: G2 from (0,0) to (2,2) R2 centre should be (0,2): CW goes via (1.414,0.586)
const C = NC.parseProgram('G21 G90\nT1 M6\nG0 X0 Y0 Z0\nG1 F100\nG2 X2 Y2 R2\n');
const mid = C.n >> 1;
// CW with positive R is the minor arc: centre is to the RIGHT of travel, i.e. (2,0)
near(Math.hypot(C.X[mid] - 2, C.Y[mid] - 0), 2, 1e-3, 'G2 R arc keeps radius about (2,0)');
ok(C.X[mid] < 1 && C.Y[mid] > 1, 'G2 R arc bulges upper-left (minor arc, CW)');
const C2 = NC.parseProgram('G21 G90\nT1 M6\nG0 X0 Y0 Z0\nG1 F100\nG3 X2 Y2 R2\n'); const m2 = C2.n >> 1;
near(Math.hypot(C2.X[m2] - 0, C2.Y[m2] - 2), 2, 1e-3, 'G3 R arc keeps radius about (0,2)');
// inch program with tool comments before G20
const I = NC.parseProgram('(T1  D=0.5 CR=0. - ZMIN=-0.25 - FLAT END MILL)\nG20 G90\nT1 M6\nG0 X1. Y1. Z0.1\nG1 Z-0.25 F20.\n');
near(I.tools[0].D, 12.7, 1e-6, 'inch tool dia converted');
near(I.Z[I.n - 1], -6.35, 1e-4, 'inch Z converted');
near(I.F[I.n - 1], 508, 1e-3, 'inch feed converted');

// ---- simulate demo
const box = { xmin: -55, xmax: 55, ymin: -40, ymax: 40, ztop: 0, zbot: -20 };
const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));
const sim = new NC.HeightSim(box, 440);
console.log('grid', sim.nx, 'x', sim.ny, 'cell', sim.dx.toFixed(3), sim.dy.toFixed(3));
// sample at the centre of the cell containing (x,y), so cone/ball results are exact
const at = (x, y) => sim.h[Math.min(sim.ny - 1, Math.floor((y - sim.y0) / sim.dy)) * sim.nx + Math.min(sim.nx - 1, Math.floor((x - sim.x0) / sim.dx))];
const cc = (x, y) => [sim.x0 + (Math.floor((x - sim.x0) / sim.dx) + .5) * sim.dx, sim.y0 + (Math.floor((y - sim.y0) / sim.dy) + .5) * sim.dy];
let t0 = process.hrtime.bigint();
const endOp1 = P.ops[1].move;
for (let i = 0; i < endOp1; i++) NC.cutMove(sim, P, simTools, i, 0, 1);
near(at(0, 0), -7.8, 0.02, 'after rough: floor at -7.8');
near(at(29.85, 0), 0, 0.02, 'after rough: 0.3 wall stock left');
near(at(-27, 0), -7.8, 0.02, 'after rough: inside pocket cleared');
ok(at(29.3, 17.3) > -7, 'after rough: corner not cleared by 10mm tool (blue)');
for (let i = endOp1; i < P.n; i++) NC.cutMove(sim, P, simTools, i, 0, 1);
let ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('demo full sim ms', ms.toFixed(1));
near(at(0, 0), -8, 0.02, 'final: floor at -8');
near(at(29.85, 0), -8, 0.05, 'final: wall finished');
near(at(-29.5, 0), -8, 0.05, 'final: wall finished on -X');
near(at(31.5, 0), 0, 0.03, 'final: outside chamfer untouched (x=31.5)');
{ const [cx] = cc(30.5, 0); near(at(30.5, 0), -5 + (cx - 26), 0.01, `final: chamfer surface at x=${cx.toFixed(3)} follows 45 deg cone`); }
{ const [cx, cy] = cc(40, 25), dd = Math.hypot(cx - 40, cy - 25); near(at(40, 25), -14 + NC.prof(NC.simTool({ type: 'drill', D: 5, tip: 118 }), dd), 0.001, `drill point profile at r=${dd.toFixed(3)} from hole centre`); }
{ const [cx, cy] = cc(42, 25), dd = Math.hypot(cx - 40, cy - 25); near(at(42, 25), -14 + NC.prof(NC.simTool({ type: 'drill', D: 5, tip: 118 }), dd), 0.001, `drill cone at r=${dd.toFixed(2)}`); }
{ const [cx, cy] = cc(-40, -25), dd = Math.hypot(cx + 40, cy + 25); near(at(-40, -25), -14 + NC.prof(NC.simTool({ type: 'drill', D: 5, tip: 118 }), dd), 0.001, 'drill 2nd hole profile'); }
near(at(45.5, 0), -1.5, 0.06, 'ball groove depth on path');
near(at(45.5 - 5.5, 0), 0, 0.02, 'centre of groove circle untouched');
near(at(-34.5, 0), -1.5, 0.06, 'G2 groove depth on path');
near(at(0, 0) - at(0, 0), 0, 0, 'sanity');
ok(sim.op[Math.floor((0 - sim.y0) / sim.dy) * sim.nx + Math.floor((0 - sim.x0) / sim.dx)] === 2, 'floor centre attributed to op 2 (finish)');

// ---- ball nose profile check: a straight X move at z=-3 with R=3 ball; height across Y should be circle
const bs = new NC.HeightSim({ xmin: -10, xmax: 10, ymin: -10, ymax: 10, ztop: 0, zbot: -10 }, 200);
const ball = NC.simTool({ type: 'ball', D: 6 });
bs.cut(-8, 0, -3, 8, 0, -3, ball, 1);
let worst = 0;
for (let j = 0; j < bs.ny; j++) { const y = bs.y0 + (j + .5) * bs.dy; if (Math.abs(y) < 2.9) { const want = -3 + 3 - Math.sqrt(9 - y * y); worst = Math.max(worst, Math.abs(bs.h[j * bs.nx + (bs.nx >> 1)] - want)); } }
ok(worst < 1e-4, `ball-nose swept profile error ${worst.toExponential(2)} mm`);
// ramp with ball (non planar, ternary path) compared to dense stamping
const rs = new NC.HeightSim({ xmin: -10, xmax: 10, ymin: -10, ymax: 10, ztop: 0, zbot: -10 }, 100);
const rs2 = new NC.HeightSim({ xmin: -10, xmax: 10, ymin: -10, ymax: 10, ztop: 0, zbot: -10 }, 100);
rs.cut(-8, 0, -1, 8, 0, -5, ball, 1);
for (let k = 0; k <= 2000; k++) { const t = k / 2000; rs2.cut(-8 + 16 * t, 0, -1 - 4 * t, -8 + 16 * t, 0, -1 - 4 * t, ball, 1); }
let dmax = 0; for (let i = 0; i < rs.h.length; i++) dmax = Math.max(dmax, Math.abs(rs.h[i] - rs2.h[i]));
ok(dmax < 0.01, `ramp sweep vs dense stamping max diff ${dmax.toFixed(4)} mm`);

// ---- stress test timing
const S = NC.parseProgram(NC.stressProgram());
const sb = { xmin: -52, xmax: 52, ymin: -52, ymax: 52, ztop: 0, zbot: -12 };
const st = new Map(S.tools.map(t => [t.no, NC.simTool(t)]));
for (const target of [240, 360, 520]) {
  const ss = new NC.HeightSim(sb, target);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < S.n; i++) NC.cutMove(ss, S, st, i, 0, 1);
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`stress ${S.n} moves, grid ${ss.nx}x${ss.ny}: ${ms.toFixed(0)} ms (${(S.n / ms * 1000 / 1000).toFixed(1)}k moves/s)`);
}
// ---- numbered-drill naming: "25 .1496 140DEG..." (real APW name, T86 in O1224.NC) - the
// leading "25" is a drill index, not 25 inches; the real diameter is the decimal after it.
{
  const td = { no: 86 }; NC.guessFromName(td, '25 .1496 140DEG CARB DRILL TSC', true);
  near(td.D, 0.1496 * 25.4, 1e-6, 'numbered-drill index is not mistaken for a 25" diameter');
  const td2 = { no: 35 }; NC.guessFromName(td2, '16 .1772 140DEG CARB DRILL TSC', true);
  near(td2.D, 0.1772 * 25.4, 1e-6, 'a second numbered drill (T35 in O1224.NC) parses the same way');
  const td3 = { no: 1 }; NC.guessFromName(td3, '3/8 7FL Roughing EM', true);
  near(td3.D, 0.375 * 25.4, 1e-6, 'fraction-led names are unaffected by the numbered-drill fix');
  const td4 = { no: 2 }; NC.guessFromName(td4, '.2344 15/64 DRILL 5XD 140DEG TSC', true);
  near(td4.D, 0.2344 * 25.4, 1e-6, 'decimal-led names are unaffected too');
}

// ---- cutter comp (G41/G42) per-operation tracking
{
  const cp = NC.parseProgram('G21 G90 G17\nT1 M6\nG0 X0 Y0\nG1 G41 X10 Y0 D5 F500\nG1 X10 Y10\nG40 G1 X0 Y10\n');
  ok(cp.ops[0].comp === 1 && cp.ops[0].compD === 5, `G41 on the same block as the move is captured, with its D register: comp=${cp.ops[0].comp} D=${cp.ops[0].compD}`);
  const cp2 = NC.parseProgram('G21 G90 G17\nT1 M6\nG0 X0 Y0\nG1 G42 X10 Y0 D7 F500\n');
  ok(cp2.ops[0].comp === 2 && cp2.ops[0].compD === 7, `G42 (right) is distinguished from G41: comp=${cp2.ops[0].comp} D=${cp2.ops[0].compD}`);
  const cp3 = NC.parseProgram('G21 G90 G17\nT1 M6\nG100 T57 X0 Y0 G43 Z5 H57 D57 S3000 M03\nG1 X10 Y0 F500\n');
  ok(cp3.ops[0].comp === 0, "a tool-change block's own D word (H57 D57) is not mistaken for cutter comp");
  ok(P.ops[0].comp === 0, 'the baseline demo program has no cutter comp (unaffected by this change)');
}
// real job: verified against O1228.NC - 3 finishing-contour operations use G41 D58 (T58)
{
  const real = NC.parseProgram(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'O1228.NC'), 'latin1'));
  const withComp = real.ops.filter(o => o.comp);
  ok(withComp.length === 3, `O1228: 3 real operations use cutter comp (got ${withComp.length})`);
  ok(withComp.every(o => o.comp === 1 && o.compD === 58 && o.tool === 58), 'all 3 are G41 D58 on T58, matching the D-register-equals-tool-number convention');
}

// ---- Dim# extraction from the setup-sheet CSV, column 8 "Diameter control dim" -----
// No real fixture happens to contain an operation-comment DIM note, so this uses text shaped
// exactly like the real post's output (getDimNote()/csvRow() in CSV_Cascade_Post_v2_6_7.cps):
// "D<n> = DIM <note>" when both exist, just "D<n>" or just the note when only one does.
{
  const header = 'Seq#,Sequence Description,Tool #,G-Code Tool #,OOH,Holder,RTA #,Length control Dim,Diameter control dim,Cut Diameter,Gage Length,Tip (CR or Angle),T-description,LC\n';
  const csvText = header +
    '10,OP50 | Finish Bore,58,T58,1.2,HLDR,,0.500,D58 = DIM 1.250,0.375,0.42,,Boring bar,\n' +
    '15,OP50 | Rough Mill,44,T44,1.0,HLDR,,0.400,D44,0.500,0.40,,End mill,\n' +
    '20,OP50 | Face,46,T46,0.9,HLDR,,0.300,,0.750,0.38,,Face mill,\n';
  const csv = NC.parseSetupCsv(csvText);
  ok(csv.ops[0].dim === 'DIM 1.250', `"D58 = DIM 1.250" yields just the DIM part: "${csv.ops[0].dim}"`);
  ok(csv.ops[1].dim === '', `a D-value with no DIM note yields nothing: "${csv.ops[1].dim}"`);
  ok(csv.ops[2].dim === '', `no D-value and no note yields nothing: "${csv.ops[2].dim}"`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
