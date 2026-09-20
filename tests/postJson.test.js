// Real-world check: CSV_Cascade_Post_v2_6_7.cps's actual output (fixtures/setups/OP50_from_cascading_post.floorsim.json,
// posted for real against O1228 on 2026-09-19) loaded alongside the real O1228.NC, exactly as an operator would drop
// both files in at once. Confirms the post's stock box lands correctly with no placement warnings.
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
const warns = () => d.getElementById('warns').textContent;

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;

  const ncText = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'utf8');
  const jsonText = fs.readFileSync(path.join(ROOT, 'fixtures', 'setups', 'OP50_from_cascading_post.floorsim.json'), 'utf8');

  // Operator drops the NC and the post's JSON in together.
  await F.handleFiles([new w.File([ncText], 'O1228.NC'), new w.File([jsonText], 'O1228.floorsim.json')]);
  await ready();

  console.log('--- warnings/notes shown:\n' + warns());
  ok(S.ready && S.prog.n === 19126, 'program loaded: ' + S.prog.n + ' moves');
  // Values match the ones already verified against the toolpath via the Python export route (NOTES.md section 5).
  ok(Math.abs(S.stock.xmin + 26.9875) < 1e-6, 'stock xmin from the post: ' + S.stock.xmin);
  ok(Math.abs(S.stock.xmax - 4.7625) < 1e-6, 'stock xmax from the post: ' + S.stock.xmax);
  ok(Math.abs(S.stock.ymin + 15.875) < 1e-6 && Math.abs(S.stock.ymax - 15.875) < 1e-6, 'stock Y from the post');
  ok(Math.abs(S.stock.zbot - 90.092) < 1e-6 && Math.abs(S.stock.ztop - 118.794) < 1e-6, 'stock Z from the post');
  ok(/stock box from Fusion/.test(warns()), 'page reports the stock came from the file, not a guess');
  ok(!/cutting moves are inside the stock box|out of date/.test(warns()), 'no placement or staleness warnings for the real post output');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
