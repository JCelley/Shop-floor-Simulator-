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
const U = require('path').join(ROOT, 'fixtures') + '/', C = require('path').join(ROOT, 'fixtures', 'setups') + '/';
const mk = (txt, name) => new w.File([txt], name);
const ready = async () => { await sleep(300); for (let i = 0; i < 600 && !w.__floorsim.S.ready; i++) await sleep(100); };
(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S, base = [mk(fs.readFileSync(U + 'O1228.NC', 'latin1'), 'O1228.NC'), mk(fs.readFileSync(U + 'O1228.csv', 'utf8'), 'O1228.csv'), mk(fs.readFileSync(require('path').join(ROOT, 'fixtures', 'tools.json'), 'utf8'), 'tools.json')];
  // 1. the file exactly as the first script version wrote it
  await F.handleFiles([...base, mk(fs.readFileSync(require('path').join(ROOT, 'fixtures', 'setups_original', 'OP50_floorsim.json'), 'utf8'), 'OP50_floorsim.json')]); await ready();
  console.log('--- ORIGINAL export:\n' + d.getElementById('warns').innerHTML.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''));
  ok(/nearest workholding part is \d+ mm from the stock/.test(d.getElementById('warns').textContent), 'page flags the mis-placed original file');
  // 2. the corrected file
  await F.handleFiles([mk(fs.readFileSync(C + 'OP50.floorsim.json', 'utf8'), 'OP50.floorsim.json')]); await ready();
  console.log('\n--- CORRECTED export:\n' + d.getElementById('warns').innerHTML.replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''));
  console.log('stock used (mm):', JSON.stringify(S.stock), '\nfixtures drawn:', F.fixScene.children.length, '| prepass', (S.stats.ms / 1000).toFixed(2), 's,', S.stats.nx + 'x' + S.stats.ny, 'grid,', S.stats.dx.toFixed(3), 'mm cells');
  ok(F.fixScene.children.length === 45, '45 workholding bodies drawn');
  ok(!/nearest workholding|cutting moves are inside|part outside the stock/.test(d.getElementById('warns').textContent), 'no placement warnings on the corrected file');
  ok(!/sinks \d/.test(d.getElementById('warns').textContent), 'the ~2.7 mm pin overlap is not flagged as a placement error');
  // simulate to the end and look at the final surface vs stock
  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'played to the end with fixtures loaded');
  console.log('\nerrors:', errors.length ? errors : 'none'); ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
