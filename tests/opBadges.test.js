// Operations list badges: cutter comp (G41/G42 + D register) and Dim# (from the setup CSV's
// "Diameter control dim" column), with a green highlight on any op that has a Dim# note.
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
  const F = w.__floorsim;

  // ---- real O1228 job (no CSV): cutter comp badges show on exactly its 3 real G41 D58 operations
  const ncText = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'latin1');
  await F.handleFiles([mk(ncText, 'O1228.NC')]); await ready();
  const items = () => [...d.querySelectorAll('#ops > li')];
  const ccItems = items().filter(li => li.querySelector('.opbadge.cc'));
  ok(ccItems.length === 3, `3 operations show a cutter-comp badge (got ${ccItems.length})`);
  ok(ccItems.every(li => li.querySelector('.opbadge.cc').textContent === 'G41 D58'), 'each badge reads exactly "G41 D58"');
  ok(items().filter(li => li.classList.contains('op-dim')).length === 0, 'no Dim# highlight without a CSV (O1228.NC has no DIM data of its own)');

  // ---- same job + a setup CSV shaped like the real post's output, with one DIM note
  const header = 'Seq#,Sequence Description,Tool #,G-Code Tool #,OOH,Holder,RTA #,Length control Dim,Diameter control dim,Cut Diameter,Gage Length,Tip (CR or Angle),T-description,LC\n';
  // O1228's op[5] is "T58 2D Contour Finish Outside #26 #17 #18" per the real job - give it a DIM note.
  const label = F.S.prog.ops[5].label, toolNo = F.S.prog.ops[5].tool;
  const rows = F.S.prog.ops.map((o, k) => `${10 + k},OP50 | ${o.label},${o.tool},T${o.tool},1.0,HLDR,,0.4,${k === 5 ? 'D' + toolNo + ' = DIM 1.250' : ''},0.5,0.4,,Tool,\n`).join('');
  await F.handleFiles([mk(header + rows, 'O1228.csv')]); await ready();
  const dimItems = items().filter(li => li.classList.contains('op-dim'));
  ok(dimItems.length === 1, `exactly the one operation with a DIM note is highlighted (got ${dimItems.length})`);
  ok(dimItems[0].querySelector('.opbadge.dim').textContent === 'DIM 1.250', 'its badge reads the Dim# note: ' + (dimItems[0].querySelector('.opbadge.dim') || {}).textContent);
  ok(dimItems[0].textContent.includes(label), 'the highlighted operation is the right one (T' + toolNo + ' finishing op): ' + dimItems[0].textContent.trim());
  // the cutter-comp badges must still be there too - the CSV only adds the Dim# badge, doesn't replace anything
  ok(items().filter(li => li.querySelector('.opbadge.cc')).length === 3, 'cutter-comp badges are unaffected by adding the CSV');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
