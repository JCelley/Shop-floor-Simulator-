// "Open job folder": groups a whole shared folder's files by program number (the shared folder
// has every job mixed together, not one folder per job - see NOTES.md), auto-loads when there's
// only one match, otherwise shows a small picker sorted newest-first.
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
const ready = async () => { await sleep(200); for (let i = 0; i < 400 && !w.__floorsim.S.ready; i++) await sleep(50); };
const mk = (name, content = 'x', ms = 0) => new w.File([content], name, { lastModified: ms });

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim;

  // ---- pure grouping logic: real filename conventions from the real fixtures, trivial content
  const folder = [
    mk('O1228.NC', 'x', 1000), mk('O1228.csv', 'x', 900), mk('O1228.floorsim.json', 'x', 950),
    mk('O1224.NC', 'x', 5000), mk('O1224.csv', 'x', 4900),
    mk('CAM_-_SOL1-902195_REV_A_-_Outlet_Fitting.tools', 'x', 100),   // shared tool library, own name
    mk('leftover_setup_notes.csv', 'x', 200),                          // CSV with no matching NC - must be excluded
    mk('random_readme.txt', 'x', 300),                                 // unrecognized extension - ignored
  ];
  const groups = F.groupFolderFiles(folder);
  ok(groups.length === 2, `only programs with an NC file are listed (got ${groups.length})`);
  ok(groups[0].program === 'O1224', 'newest program (by lastModified) sorts first: ' + groups[0].program);
  ok(groups[1].program === 'O1228', 'older program sorts second: ' + groups[1].program);
  ok([...groups[0].kinds].sort().join(',') === 'CSV,NC', 'O1224 group has NC+CSV: ' + [...groups[0].kinds]);
  ok([...groups[1].kinds].sort().join(',') === 'CSV,NC,job/setup', 'O1228 group has NC+CSV+job/setup: ' + [...groups[1].kinds]);
  ok(!groups.some(g => g.program === 'leftover_setup_notes'), 'a CSV with no matching NC is not offered as a program');

  // ---- single match: loads immediately, no picker shown
  const demoText = w.eval('NC').demoProgram();
  await F.openFolder([mk('O1001.NC', demoText, 1000)]);
  await ready();
  ok(d.getElementById('pickerBack').hidden, 'exactly one match loads directly, no picker shown');
  ok(F.S.ready && F.S.name === 'O1001.NC', 'the single matching program actually loaded: ' + F.S.name);

  // ---- multiple matches: picker shown, search filters, clicking loads the right one
  await F.openFolder([mk('O1001.NC', demoText, 1000), mk('O1002.NC', demoText, 2000), mk('O1003.NC', demoText, 500)]);
  ok(!d.getElementById('pickerBack').hidden, 'multiple matches show the picker');
  const items = () => [...d.querySelectorAll('#pickerList button[data-program]')].map(b => b.dataset.program);
  ok(items().join(',') === 'O1002,O1001,O1003', 'picker lists programs newest-first: ' + items());
  const search = d.getElementById('pickerSearch');
  search.value = '1003'; search.dispatchEvent(new w.Event('input'));
  ok(items().join(',') === 'O1003', 'search filters the list: ' + items());
  search.value = ''; search.dispatchEvent(new w.Event('input'));
  d.querySelector('#pickerList button[data-program="O1002"]').click();
  await ready();
  ok(d.getElementById('pickerBack').hidden, 'picking a program hides the picker');
  ok(F.S.ready && F.S.name === 'O1002.NC', 'the picked program loaded: ' + F.S.name);

  // ---- cancel button closes without loading
  await F.openFolder([mk('O1001.NC', demoText, 1000), mk('O1002.NC', demoText, 2000)]);
  ok(!d.getElementById('pickerBack').hidden, 'picker open again');
  d.getElementById('pickerCancel').click();
  ok(d.getElementById('pickerBack').hidden, 'cancel closes the picker');
  ok(F.S.name === 'O1002.NC', 'cancel does not change what is loaded');

  // ---- a folder with no .NC files at all
  await F.openFolder([mk('setup.csv'), mk('tools.tools')]);
  ok(d.getElementById('pickerBack').hidden, 'no NC files -> no picker (just a toast, nothing to show)');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
