// Step mode: pauses playback right after an operation finishes (before the next one starts), and
// right after cutter comp (G41/G42) first turns on within an operation - so an operator can read
// the tool/D-value off the HUD at that exact moment. Tested against the real O1228 job.
const ROOT = require('path').join(__dirname, '..');
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const three = fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.min.js'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'dist', 'nc-floor-sim.html'), 'utf8');
const stub = `THREE.WebGLRenderer = class { constructor(){ this.domElement = document.createElement('canvas'); } setPixelRatio(){} setClearColor(){} setSize(){} render(){} };`;
html = html.replace(/<script src="[^"]*three[^"]*"><\/script>/, '<script>' + three.replace(/<\/script>/g, '<\\/script>') + stub + '</script>');
const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e.detail || e.message))); vc.on('error', (...a) => errors.push(a.join(' ')));
const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' }).window, d = w.document;
const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const ready = async () => { await sleep(300); for (let i = 0; i < 600 && !w.__floorsim.S.ready; i++) await sleep(100); };
const mk = (txt, name) => new w.File([txt], name);

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;
  const ncText = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'latin1');
  await F.handleFiles([mk(ncText, 'O1228.NC')]); await ready();
  const P = S.prog;

  // ---- baseline: step mode OFF plays straight through, ignoring op/comp boundaries
  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change'));
  d.getElementById('bPlay').click();
  for (let i = 0; i < 400 && S.playing; i++) await sleep(20);
  ok(!S.playing && S.cur.i === P.n, 'step mode off: plays straight through to the end, ' + S.cur.i + '/' + P.n);

  // ---- step mode ON: play stops at the first operation boundary, not the whole program
  d.getElementById('stepMode').checked = true; d.getElementById('stepMode').dispatchEvent(new w.Event('change'));
  d.getElementById('bRestart').click(); await sleep(50);
  d.getElementById('bPlay').click();
  for (let i = 0; i < 400 && S.playing; i++) await sleep(20);
  ok(!S.playing, 'step mode stopped playback automatically');
  ok(S.cur.i > 0 && S.cur.i < P.n, `stopped partway through the program, not at the end: move ${S.cur.i}/${P.n}`);
  const stop1 = S.cur.i;
  ok(P.OP[stop1] !== P.OP[stop1 - 1] || (P.CC[stop1 - 1] && !(stop1 >= 2 && P.CC[stop1 - 2])),
     `stopped exactly at an operation boundary or a cutter-comp activation (move ${stop1}, op ${P.OP[stop1 - 1]}->${P.OP[stop1]}, CC ${P.CC[stop1 - 1]})`);

  // ---- pressing Play again resumes from exactly where it stopped, and reaches a later breakpoint
  d.getElementById('bPlay').click();
  for (let i = 0; i < 400 && S.playing; i++) await sleep(20);
  ok(!S.playing && S.cur.i > stop1, `resuming steps to the NEXT breakpoint, further along: ${stop1} -> ${S.cur.i}`);

  // ---- step repeatedly to the real 3 cutter-comp operations (O1228: 3 ops use G41 D58)
  let compStops = 0, guard = 0;
  while (S.cur.i < P.n && guard++ < 60) {
    const before = S.cur.i;
    d.getElementById('bPlay').click();
    for (let i = 0; i < 400 && S.playing; i++) await sleep(15);
    const at = S.cur.i;
    if (at > 0 && P.CC[at - 1] && !(at >= 2 && P.CC[at - 2])) compStops++;
    if (at === before) break; // nothing left to advance (end of program)
  }
  ok(compStops === 3, `stepping through the whole program hits exactly the 3 real cutter-comp activations (got ${compStops})`);

  // ---- turning step mode back off lets it play straight to the end again
  d.getElementById('bRestart').click(); await sleep(50);
  d.getElementById('stepMode').checked = false; d.getElementById('stepMode').dispatchEvent(new w.Event('change'));
  d.getElementById('bPlay').click();
  for (let i = 0; i < 400 && S.playing; i++) await sleep(20);
  ok(!S.playing && S.cur.i === P.n, 'turning step mode off restores normal straight-through playback');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
