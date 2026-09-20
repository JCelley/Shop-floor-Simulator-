// Cross-setup stock chaining, end-to-end on the actual page: loading a real setup (OP50, via the
// real O1228.NC + OP50.floorsim.json) then a "from preceding setup" one (the real Op_60.floorsim.json,
// stockMode 7, an actual second setup from the same real job) should seed the second one's starting
// stock from the first one's finished result, using the real WCS data from both.
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
const warns = () => d.getElementById('warns').textContent;

// a small synthetic "setup B" program - a simple facing pass, real content doesn't matter here,
// only that it's valid G-code inside Op_60's real stock box (X/Y +-15.875, Z 65.9..94.6 mm).
const SETUP_B_NC = 'G21 G90 G17\n(FACE)\nT1 M6\nS4000 M3\nG0 X-10 Y0\nG43 H1 Z90\nG1 Z85 F500\nG1 X10\nG0 Z90\nM5\nM30\n';

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;

  // ---- loading setup A (OP50, real) with no prior chainable data: no chaining, nothing to chain from
  ok(S.lastChainable === null, 'no chainable result yet, right after the page auto-loads the demo');
  const ncA = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'latin1');
  const setupA = fs.readFileSync(path.join(ROOT, 'fixtures', 'setups', 'OP50.floorsim.json'), 'utf8');
  await F.handleFiles([mk(ncA, 'O1228.NC'), mk(setupA, 'OP50.floorsim.json')]); await ready();
  ok(S.chainSeed === null, 'OP50 itself is Solid stock mode, not "from preceding setup" - nothing to chain FOR it');
  ok(S.lastChainable && S.lastChainable.name === 'OP50 ', 'OP50\'s own finished result is now recorded as chainable: "' + (S.lastChainable && S.lastChainable.name) + '"');
  const meshA = S.lastChainable.mesh;
  ok(meshA.pos.length > 0 && meshA.idx.length > 0, 'the recorded mesh has real geometry');

  // ---- loading setup B (Op 60, real, "from preceding setup") right after: chains from A
  const setupB = fs.readFileSync(path.join(ROOT, 'fixtures', 'setups', 'Op_60.floorsim.json'), 'utf8');
  await F.handleFiles([mk(SETUP_B_NC, 'O_test_B.NC'), mk(setupB, 'Op_60.floorsim.json')]); await ready();
  ok(!!S.chainSeed && S.chainSeed.fromName === 'OP50 ', 'loading a "from preceding setup" setup right after OP50 triggers chaining from it');
  ok(/Stock seeded from the previous setup/.test(warns()), 'the page says so in its notes: ' + warns().slice(0, 200));
  ok(S.chainCoverage != null && S.chainCoverage > 0, `real WCS data from the same real job actually overlaps (coverage ${(S.chainCoverage * 100).toFixed(1)}%)`);
  const flatCells = [...S.sim.h].filter(v => Math.abs(v - S.sim.zTop) < 1e-4).length; // h[] is Float32, zTop is a plain double
  ok(flatCells < S.sim.h.length, `the starting stock is not simply flat at zTop everywhere (${flatCells}/${S.sim.h.length} cells still flat)`);
  ok(!/Only its bounding box is used here/.test(warns()), 'the stale "only its bounding box" warning is suppressed once chaining actually supplied the real shape');

  // ---- loading an unrelated bare NC in between clears lastChainable - no stale chaining
  const demoText = w.eval('NC').demoProgram();
  await F.handleFiles([mk(demoText, 'unrelated.NC')]); await ready();
  ok(S.lastChainable === null, 'an unrelated program with no real WCS data clears lastChainable (' + S.lastChainable + ')');
  await F.handleFiles([mk(SETUP_B_NC, 'O_test_B.NC'), mk(setupB, 'Op_60.floorsim.json')]); await ready();
  ok(S.chainSeed === null, 'Op 60 loaded again with no chainable predecessor available - no chaining this time');
  ok(/no other setup.s simulated result is available/.test(warns()), 'and the page explains why: ' + warns().slice(0, 250));
  ok(/Only its bounding box is used here/.test(warns()), 'without chaining, the generic "only bounding box" warning is still shown - it is accurate here');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
