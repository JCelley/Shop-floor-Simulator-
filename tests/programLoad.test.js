// Load by program number: type O1228 (or just 1228), press Load, and every file for that program
// is read from a folder picked once and remembered. Real browsers do this with the File System
// Access API; jsdom has none, so a fake folder handle stands in with the same methods Chrome gives
// (values(), getFile(), queryPermission/requestPermission) holding the real O1228 files plus
// unrelated ones that must be ignored. Whether the real picker can reach a Google Shared Drive on
// a Chromebook is NOT covered here - that needs a real Chromebook.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { JSDOM, VirtualConsole } = require('jsdom');
const three = fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.min.js'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'dist', 'nc-floor-sim.html'), 'utf8');
const stub = `THREE.WebGLRenderer = class { constructor(){ this.domElement = document.createElement('canvas'); } setPixelRatio(){} setClearColor(){} setSize(){} render(){} };`;
html = html.replace(/<script src="[^"]*three[^"]*"><\/script>/, '<script>' + three.replace(/<\/script>/g, '<\\/script>') + stub + '</script>');
const sleep = ms => new Promise(r => setTimeout(r, ms)); let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const nc = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'utf8');
const csv = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.csv'), 'utf8');

function page(url, withApi, permission) {
  const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(String(e.detail || e.message))); vc.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url,
    beforeParse(win) {
      if (!withApi) return;
      const file = (name, text, ms) => new win.File([text], name, { lastModified: ms });
      const entries = [
        file('O1228.NC', nc, 2000), file('O1228.csv', csv, 2000),
        file('O1229.NC', 'G0 X0', 3000), file('O12280.NC', 'G0 X0', 3000),   // near-miss program numbers - must not be picked up
        file('notes.txt', 'x', 1),
      ];
      win.__picks = 0; win.__perm = permission || 'granted'; win.__asked = 0;
      const dir = {
        kind: 'directory', name: 'Posted Programs - UNPROVEN',
        async queryPermission() { return win.__perm; },
        async requestPermission() { win.__asked++; win.__perm = 'granted'; return 'granted'; },
        async *values() { for (const f of entries) yield { kind: 'file', name: f.name, getFile: async () => f }; yield { kind: 'directory', name: 'old' }; },
      };
      win.showDirectoryPicker = async () => { win.__picks++; return dir; };
    },
  });
  return { w: dom.window, d: dom.window.document, errors };
}
const ready = async w => { for (let i = 0; i < 400 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50); };

(async () => {
  // ---- a browser without the API keeps the old "Open job folder" button
  {
    const { w, d, errors } = page('http://localhost/', false);
    await ready(w); await sleep(100);
    ok(d.getElementById('progForm').hidden && !d.getElementById('folderFallback').hidden, 'no folder API: program box hidden, "Open job folder" kept');
    ok(errors.length === 0, 'no runtime errors (no API): ' + errors.join(' | '));
  }

  // ---- with the API: type the number, press Load, first time asks for the folder once
  {
    const { w, d, errors } = page('http://localhost/', true);
    await ready(w); await sleep(100);
    const F = w.__floorsim, S = F.S;
    ok(!d.getElementById('progForm').hidden && d.getElementById('folderFallback').hidden, 'program box shown, old folder button hidden');
    ok(d.getElementById('folderName').textContent === 'not set', 'no folder chosen yet');
    d.getElementById('progNo').value = '1228';
    d.getElementById('progForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 400 && S.name !== 'O1228.NC'; i++) await sleep(50);
    await ready(w);
    ok(w.__picks === 1, 'the folder was asked for exactly once');
    ok(d.getElementById('folderName').textContent === 'Posted Programs - UNPROVEN', 'the folder name is shown: ' + d.getElementById('folderName').textContent);
    ok(d.getElementById('progNo').value === 'O1228', 'a bare number is read as O1228');
    ok(S.name === 'O1228.NC' && S.prog.n > 1000, 'O1228 loaded from the folder: ' + S.name + ', ' + S.prog.n + ' moves');
    ok(!!S.csv && S.prog.ops[0].label && !/^T\d+$/.test(S.prog.ops[0].label), 'its CSV came along too (named operations): ' + S.prog.ops[0].label);

    // second load: same folder, no new prompt
    await F.loadProgram('o1228', true); await ready(w);
    ok(w.__picks === 1, 'loading again does not ask for the folder again');

    // a program that isn't there
    const before = S.name;
    const res = await F.loadProgram('O4444', true);
    ok(res === false && S.name === before, 'a missing program leaves the current one loaded');
    ok(/No O4444\.NC/.test(d.getElementById('toast').textContent), 'and says so: ' + d.getElementById('toast').textContent);

    // "Folder:" button picks a different folder
    d.getElementById('folderBtn').click(); await sleep(100);
    ok(w.__picks === 2, 'the Folder button opens the picker to change folders');
    ok(errors.length === 0, 'no runtime errors: ' + errors.join(' | '));
  }

  // ---- a link with ?program= fills the box; with no folder chosen yet it waits for a click
  {
    const { w, d, errors } = page('http://localhost/?program=O1228', true);
    await ready(w); await sleep(300);
    ok(d.getElementById('progNo').value === 'O1228', '?program=O1228 fills the program box');
    ok(w.__picks === 0 && w.__floorsim.S.name !== 'O1228.NC', 'with no folder remembered yet, nothing pops up on its own (the picker needs a click)');
    ok(errors.length === 0, 'no runtime errors (link): ' + errors.join(' | '));
  }

  // ---- a remembered folder whose permission lapsed: Load re-asks, then loads
  {
    const { w, d, errors } = page('http://localhost/', true, 'prompt');
    await ready(w); await sleep(100);
    const F = w.__floorsim;
    F.S.folder = await w.showDirectoryPicker(); w.__picks = 0;   // stand-in for the handle IndexedDB would hand back
    const quiet = await F.loadProgram('O1228', false);
    ok(quiet === false && w.__asked === 0, 'without a click it does not prompt for permission');
    await F.loadProgram('O1228', true); await ready(w);
    ok(w.__asked === 1 && F.S.name === 'O1228.NC', 'with a click (Load) it asks once, then loads');
    ok(errors.length === 0, 'no runtime errors (permission): ' + errors.join(' | '));
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
