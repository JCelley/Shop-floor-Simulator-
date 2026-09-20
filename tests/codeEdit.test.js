// G-code editing: operators can edit the program text and re-run it, purely in memory - nothing
// is ever saved, so it reverts to the real program the next time it's loaded (John's request).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
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

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;
  const originalText = S.text, originalName = S.name, originalMoves = S.prog.n;

  // ---- entering edit mode shows the real current program text, hides the compact view
  F.enterCodeEdit();
  ok(!d.getElementById('codeEditWrap').hidden && d.getElementById('code').hidden, 'edit mode shows the textarea, hides the compact view');
  ok(d.getElementById('codeEdit').value === originalText, 'textarea starts with the exact program text that is loaded');
  ok(d.getElementById('codeEditBtn').hidden, 'Edit button hides while already editing');

  // ---- cancel: no changes, back to the compact view, nothing re-simulated
  F.exitCodeEdit();
  ok(d.getElementById('code').hidden === false && d.getElementById('codeEditWrap').hidden, 'cancel returns to the compact view');
  ok(S.text === originalText && S.name === originalName, 'cancel does not touch the loaded program');

  // ---- editing and running: a real change actually re-simulates
  F.enterCodeEdit();
  const edited = originalText.replace('T1 M6', 'T1 M6\n(EDITED BY OPERATOR)');
  d.getElementById('codeEdit').value = edited;
  await F.runCodeEdit();
  await ready();
  ok(S.text === edited, 'the edited text is what actually got loaded');
  ok(S.name === originalName + ' (edited)', 'the name is marked as edited: ' + S.name);
  ok(d.getElementById('codeEditWrap').hidden && !d.getElementById('code').hidden, 'a successful run returns to the compact view automatically');
  ok(S.ready, 'the edited program is ready to play');

  // ---- editing again keeps a single "(edited)" suffix, not "(edited) (edited)"
  F.enterCodeEdit();
  ok(d.getElementById('codeEdit').value === edited, 'the second edit session starts from the already-edited text');
  d.getElementById('codeEdit').value = edited.replace('(EDITED BY OPERATOR)', '(EDITED AGAIN)');
  await F.runCodeEdit(); await ready();
  ok(S.name === originalName + ' (edited)', 'the name does not accumulate multiple "(edited)" suffixes: ' + S.name);

  // ---- a genuinely broken edit (no tool motion) is refused and leaves edit mode open to fix it
  F.enterCodeEdit();
  const before = S.text;
  d.getElementById('codeEdit').value = '(nothing but a comment, no moves at all)';
  await F.runCodeEdit(); await sleep(300);
  ok(S.text === before, 'a broken edit does not replace the working program');
  ok(!d.getElementById('codeEditWrap').hidden, 'edit mode stays open after a failed run, so the mistake is still there to fix');
  F.exitCodeEdit();

  // ---- loading something else entirely (folder/demo/file) always drops out of edit mode
  F.enterCodeEdit();
  ok(!d.getElementById('codeEditWrap').hidden, 'edit mode open again');
  const demoText = w.eval('NC').demoProgram();
  await F.handleFiles([new w.File([demoText], 'O9999.NC')]); await ready();
  ok(d.getElementById('codeEditWrap').hidden && !d.getElementById('code').hidden, 'loading a different file exits edit mode automatically');
  ok(S.prog.n === originalMoves, 'and the newly loaded program is the one actually shown: ' + S.prog.n + ' moves');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
