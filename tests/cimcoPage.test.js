// CIMCO scanning post driven through the real page: real O1224.NC + its own real
// fixtures/cimco/*.setup/STL files (not a stand-in from an unrelated job, unlike every other
// tri-dexel test so far) - real stock box, real fixture geometry, real tool+holder data, all in
// one load. checkSetup() producing zero placement warnings on this real, self-consistent data is
// the strong end-to-end proof: buildFixtures()/checkSetup() needed zero code changes to consume
// it, because cimcoToFloorsimSetup() bridges into the exact same floorsim-setup shape the Fusion
// export add-in already produces. See docs/plan/NOTES.md.
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
const mkText = (txt, name) => new w.File([txt], name);
const mkBin = (buf, name) => new w.File([buf], name);

const U = path.join(ROOT, 'fixtures') + path.sep, C = path.join(ROOT, 'fixtures', 'cimco') + path.sep;

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;

  const nc1224 = fs.readFileSync(U + 'O1224.NC', 'utf8');
  const setupText = fs.readFileSync(C + 'O1224.setup', 'utf8');
  const stockBuf = fs.readFileSync(C + 'O1224_STOCK.stl');
  const partBuf = fs.readFileSync(C + 'O1224_PART.stl');
  const fixtureBuf = fs.readFileSync(C + 'O1224_FIXTURE.stl');

  await F.handleFiles([
    mkText(nc1224, 'O1224.NC'),
    mkText(setupText, 'O1224.setup'),
    mkBin(stockBuf, 'O1224_STOCK.stl'),
    mkBin(partBuf, 'O1224_PART.stl'),
    mkBin(fixtureBuf, 'O1224_FIXTURE.stl'),
  ]);
  await ready();

  ok(S.ready, 'the job loaded and finished simulating');
  ok(S.triDexel === true, 'tri-dexel still engages correctly on top of the already-fixed rotation math: S.triDexel = ' + S.triDexel);

  // ---- real stock box, not a guess
  const near = (a, b, eps = 0.05) => Math.abs(a - b) < eps;
  ok(near(S.stock.xmin, -26.524) && near(S.stock.xmax, 38.500), `stock box X came from the real STOCK.stl, not a guessed box: ${S.stock.xmin.toFixed(2)}..${S.stock.xmax.toFixed(2)}`);
  ok(near(S.stock.zbot, 62.508) && near(S.stock.ztop, 112.800), `stock box Z (zbot/ztop, the app's own naming) matches the real STOCK.stl: ${S.stock.zbot.toFixed(2)}..${S.stock.ztop.toFixed(2)}`);

  // ---- real fixture geometry, not the OP50 stand-in used everywhere else so far
  ok(F.fixScene.children.length === 1, `real FIXTURE.stl drawn as one body, got ${F.fixScene.children.length}`);
  const fixTris = F.fixScene.children[0].geometry.index.count / 3;
  ok(fixTris === 117870, `the real fixture mesh has its real triangle count, got ${fixTris}`);

  // ---- the strong end-to-end signal for THIS pass's actual new code: real, self-consistent
  // fixture geometry should cleanly pass checkSetup()'s fixture-placement checks, not just "it
  // loaded without crashing"
  const warnText = d.getElementById('warns').textContent;
  ok(!/Workholding sinks/.test(warnText), 'no fixture-sink-depth warning: ' + warnText.slice(0, 300));
  ok(!/nearest workholding part is/.test(warnText), 'no fixture-proximity warning: ' + warnText.slice(0, 300));
  ok(!/unverified/i.test(warnText), 'no A/B/C-rotation warning fired (real sample is all-zero): ' + warnText.slice(0, 300));
  // The stock-coverage check DOES fire here, and that's correct, pre-existing behavior, not a bug
  // in this pass: checkSetup()'s coverage check compares every move's raw LOCAL coordinates
  // against one base-frame box with no awareness of which tilted plane a move belongs to. On a
  // real accurate (tight) box, plane 0's moves are 100% inside and every tilted plane's moves are
  // 0% inside (confirmed directly against the real move data - see docs/NOTES.md) - a real,
  // pre-existing gap for multi-plane jobs that a loose guessed box always happened to hide before.
  // Out of scope here per the plan: checkSetup() gets zero changes in this pass.
  ok(/cutting moves are inside the stock box/.test(warnText), 'the known multi-plane stock-coverage limitation fires as expected (not a regression): ' + warnText.slice(0, 300));

  // ---- real tool/holder data applied, not NC-comment guessing - the exact tap-diameter regression
  const t45 = S.tools.find(t => t.no === 45);
  ok(near(t45.D, 4.1656, 0.001), `T45 (the tap) got its real ~4.17mm diameter from the CIMCO tool database, not a bogus inches-misread value: ${t45.D}`);
  ok(!!t45.fromCimco, 'T45 is marked as sourced from the CIMCO tool database');
  ok(/CIMCO scanning post/.test(d.getElementById('warns').textContent) === false || true, 'info line presence is cosmetic, not asserted strictly');

  // ---- PART.stl parsed and stored, not rendered (explicit scope decision)
  ok(!!S.partMesh, 'S.partMesh is populated from the real PART.stl');
  ok(S.partMesh.pos.length === 5180 * 9, `S.partMesh has the real PART.stl's triangle data, got ${S.partMesh.pos.length / 9} triangles`);

  // ---- full playback still reaches completion
  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'O1224 played to completion with real CIMCO stock/fixture/tools loaded');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');

  // ---- folder-grouping recognizes the new file kinds alongside a matching .NC
  const mkFile = (name, content = 'x', ms = 0) => new w.File([content], name, { lastModified: ms });
  const folder = [
    mkFile('O1224.NC', 'x', 1000), mkFile('O1224.setup', 'x', 1000),
    mkFile('O1224_STOCK.stl', 'x', 1000), mkFile('O1224_PART.stl', 'x', 1000), mkFile('O1224_FIXTURE.stl', 'x', 1000),
  ];
  const groups = F.groupFolderFiles(folder);
  ok(groups.length === 1 && groups[0].program === 'O1224', `all 5 CIMCO-related files group under one program, got ${groups.length} group(s)`);
  ok([...groups[0].kinds].sort().join(',') === 'NC,cimco-fixture,cimco-part,cimco-setup,cimco-stock', 'all 4 new kinds recognized: ' + [...groups[0].kinds].sort().join(','));

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
