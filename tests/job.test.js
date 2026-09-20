const ROOT = require('path').join(__dirname, '..');
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const three = fs.readFileSync(require('path').join(ROOT, 'node_modules/three/build/three.min.js'), 'utf8');
let html = fs.readFileSync(require('path').join(ROOT, 'dist', 'nc-floor-sim.html'), 'utf8');
const stub = `THREE.WebGLRenderer = class { constructor(){ this.domElement = document.createElement('canvas'); } setPixelRatio(){} setClearColor(){} setSize(){} render(){} };`;
html = html.replace(/<script src="[^"]*three[^"]*"><\/script>/, '<script>' + three.replace(/<\/script>/g, '<\\/script>') + stub + '</script>');
const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e.detail || e.message))); vc.on('error', (...a) => errors.push(a.join(' ')));
const w = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' }).window, d = w.document;
const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const ready = async () => { await sleep(300); for (let i = 0; i < 600 && !w.__floorsim.S.ready; i++) await sleep(100); };
const warns = () => d.getElementById('warns').textContent;
(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;
  const jobText = fs.readFileSync(require('path').join(ROOT, 'tests', '.tmp', 'O1228.floorsim.json'), 'utf8');
  // the ONLY file the operator selects
  await F.handleFiles([new w.File([jobText], 'O1228.floorsim.json')]); await ready();
  console.log('--- warnings/notes shown:\n' + d.getElementById('warns').innerHTML.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''));
  ok(S.name === 'O1228' && S.prog.n === 19126, 'one file loads the whole job: ' + S.name + ', ' + S.prog.n + ' moves');
  ok(S.prog.ops.length === 16 && S.prog.ops[5].label === '2D Contour Finish Outside #26 #17 #18', 'operation names come from Fusion');
  ok(S.tools.length === 7 && S.tools.every(t => t.fromLib && t.holderSegs && t.holderSegs.length === 9), '7 tools with real holders');
  ok(Math.abs(S.stock.xmin + 26.988) < 1e-6 && Math.abs(S.stock.ztop - 118.794) < 1e-6, 'stock from the file');
  ok(F.fixScene.children.length === 2, 'workholding drawn (' + F.fixScene.children.length + ' parts)');
  ok(/exported/.test(d.getElementById('fname').textContent), 'export time shown in the header: ' + d.getElementById('fname').textContent);
  ok(/Job file exported/.test(warns()), 'export time shown in the notes');
  ok(!/out of date|nearest workholding|cutting moves are inside|sinks \d|placement self-test|transform may be wrong/.test(warns()), 'no stale or placement warnings for a good file');
  // stale file: Fusion's operation list no longer matches the program that is in the file
  const j = JSON.parse(jobText); j.ops.pop();
  await F.handleFiles([new w.File([JSON.stringify(j)], 'stale.floorsim.json')]); await ready();
  ok(/lists 15 operations but the program has 16/.test(warns()), 'a job file whose operation list disagrees with its program is flagged');
  // wrong tool in the file
  const j2 = JSON.parse(jobText); j2.ops[2].tool = 99;
  await F.handleFiles([new w.File([JSON.stringify(j2)], 'wrongtool.floorsim.json')]); await ready();
  ok(/lists 16 operations but the program has 16/.test(warns()), 'a tool mismatch is flagged too');
  // still plays through
  await F.handleFiles([new w.File([jobText], 'O1228.floorsim.json')]); await ready();
  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'plays through to the end');
  console.log('errors:', errors.length ? errors : 'none'); ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
