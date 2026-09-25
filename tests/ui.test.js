const ROOT = require('path').join(__dirname, '..');
const fs = require('fs'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const three = fs.readFileSync(require('path').join(ROOT, 'node_modules/three/build/three.min.js'), 'utf8');
let html = fs.readFileSync(require('path').join(ROOT, 'dist', 'nc-floor-sim.html'), 'utf8');
const stub = `
window.__renders = 0;
THREE.WebGLRenderer = class { constructor(){ this.domElement = document.createElement('canvas'); }
  setPixelRatio(){} setClearColor(){} setSize(){} render(){ window.__renders++; } };
`;
html = html.replace(/<script src="[^"]*three[^"]*"><\/script>/, '<script>' + three.replace(/<\/script>/g, '<\\/script>') + stub + '</script>');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
const w = dom.window, d = w.document;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;
  ok(S.ready, 'demo loaded and pre-pass finished');
  ok(d.getElementById('fatal').hidden, 'no fatal overlay');
  ok(d.getElementById('ops').children.length === 5, '5 operations listed');
  ok(d.getElementById('tNo').textContent === 'T1', 'HUD shows T1 at start: ' + d.getElementById('tNo').textContent);
  ok(/Flat end mill/.test(d.getElementById('tName').textContent), 'tool name: ' + d.getElementById('tName').textContent);
  ok(d.getElementById('tSvg').innerHTML.includes('polygon'), 'tool silhouette drawn');
  ok(d.getElementById('code').value === S.text.replace(/\r/g, ''), 'G-code box holds the whole program');
  ok(d.getElementById('codeGutter').children.length > 5, 'G-code line numbers drawn');
  ok(d.querySelector('.title img.logo') && /^data:image\/webp;base64,.{1000}/.test(d.querySelector('.title img.logo').src), 'APW logo embedded in the header');
  ok(d.title === 'APW Floor Sim', 'page title: ' + d.title);

  // Ortho toggle swaps the projection, keeps the same view, and is remembered
  const proj = d.getElementById('projBtn');
  ok(F.camera.isPerspectiveCamera && proj.getAttribute('aria-pressed') === 'false', 'starts in perspective');
  proj.click();
  ok(F.camera.isOrthographicCamera && proj.getAttribute('aria-pressed') === 'true', 'Ortho button switches to an orthographic camera');
  const oc = F.camera, halfH = F.orb.dist * Math.tan(35 * Math.PI / 360);
  ok(Math.abs(oc.top - halfH) < 1e-6 && oc.right > 0, `ortho frustum matches the perspective view's size at the target (top ${oc.top.toFixed(2)} vs ${halfH.toFixed(2)})`);
  ok(w.localStorage.getItem('floorsim.ortho') === '1', 'ortho choice remembered');
  d.querySelector('[data-view="top"]').click();
  ok(F.camera.isOrthographicCamera, 'view buttons keep ortho on');
  proj.click();
  ok(F.camera.isPerspectiveCamera && w.localStorage.getItem('floorsim.ortho') === '0', 'toggles back to perspective');
  d.querySelector('[data-view="fit"]').click();
  ok(d.getElementById('timeTxt').textContent.startsWith('0:00 /'), 'time readout: ' + d.getElementById('timeTxt').textContent);
  console.log('   stats', JSON.stringify(S.stats), 'speed', S.speed);

  // colour check at start: blue where stock remains, green elsewhere
  const count = () => { const c = F.STOCK.col; let b = 0, g = 0; for (let k = 0; k < c.length; k += 3) { if (c[k + 2] > 0.9 && c[k] < 0.3) b++; else if (c[k + 1] > 0.7 && c[k + 2] < 0.5) g++; } return [b, g]; };
  let [b0, g0] = count();
  ok(b0 > 500 && g0 > 500, `start: blue ${b0}, green ${g0} vertices`);
  ok(F.STOCK.zv.every(v => v === 0), 'start: stock surface flat at Z0');

  // play at max speed
  const sel = d.getElementById('speedSel'); sel.value = '1000'; sel.dispatchEvent(new w.Event('change'));
  d.getElementById('bPlay').click();
  ok(S.playing, 'playing');
  for (let i = 0; i < 100 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'ran to the end: move ' + S.cur.i + '/' + S.prog.n);
  await sleep(150);
  const [b1, g1] = count();
  ok(b1 === 0, `end: no blue left (blue ${b1}, green ${g1})`);
  // the live sim must equal the pre-pass result
  let dm = 0; for (let i = 0; i < S.sim.h.length; i++) dm = Math.max(dm, Math.abs(S.sim.h[i] - S.finalH[i]));
  ok(dm < 1e-3, 'live playback == pre-pass result (max diff ' + dm.toExponential(2) + ')');
  ok(d.getElementById('tNo').textContent === 'T5', 'HUD ends on T5');
  ok(w.__renders > 3, 'renderer invoked ' + w.__renders + ' times');
  // mesh depth at pocket floor: vertex near (0,0) should be at -8
  const sim = S.sim, vx = sim.nx + 1, vi = Math.round((0 - sim.x0) / sim.dx), vj = Math.round((0 - sim.y0) / sim.dy);
  ok(Math.abs(F.STOCK.zv[vj * vx + vi] + 8) < 0.01, 'mesh vertex at pocket centre z=' + F.STOCK.zv[vj * vx + vi].toFixed(3));
  ok(F.STOCK.nor[(vj * vx + vi) * 3 + 2] > 0.999, 'floor normal points up');

  // scrub back: click op 3 (drill) and check state
  d.getElementById('ops').children[2].querySelector('button').click();
  await sleep(200);
  ok(S.cur.i === S.prog.ops[2].move && !S.playing, 'jump to op 3 -> move ' + S.cur.i);
  ok(d.getElementById('tNo').textContent === 'T3' || d.getElementById('tNo').textContent === 'T2', 'HUD tool after jump: ' + d.getElementById('tNo').textContent);
  const pre = S.sim.h.slice();
  // state before op 3 must equal state after op 2 computed independently
  const at = (x, y) => S.sim.h[Math.floor((y - sim.y0) / sim.dy) * sim.nx + Math.floor((x - sim.x0) / sim.dx)];
  ok(Math.abs(at(0, 0) + 8) < 0.02, 'after jump: floor finished');
  ok(at(40.1, 25.1) > -0.01, 'after jump: holes not drilled yet');
  // scrub slider to 100% then to 50%
  const sc = d.getElementById('scrub'); sc.value = '5000'; sc.dispatchEvent(new w.Event('input'));
  await sleep(200);
  ok(Math.abs(S.tau - S.prog.total / 2) < 1, 'slider to 50%: tau=' + S.tau.toFixed(1) + ' of ' + S.prog.total.toFixed(1));
  // colour mode
  d.querySelector('[data-mode="tool"]').click(); await sleep(50);
  ok(d.getElementById('legend').textContent.includes('T3'), 'by-tool legend lists tools');
  d.querySelector('[data-mode="progress"]').click();
  // probe
  S.sim.restore(S.snaps[0].state.get(0)); S.sim.reset();
  F.goTo(S.prog.total); await sleep(50);

  // ---- camera controls + probe
  const cvs = F.renderer.domElement; cvs.setPointerCapture = () => {}; cvs.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const fire = (type, x, y, extra) => cvs.dispatchEvent(Object.assign(new w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }), extra || {}));
  const az0 = F.orb.az; fire('pointerdown', 100, 100); fire('pointermove', 160, 100); fire('pointerup', 160, 100);
  ok(Math.abs(F.orb.az - az0) > 0.3, 'drag rotates camera (az ' + az0.toFixed(2) + ' -> ' + F.orb.az.toFixed(2) + ')');
  const dist0 = F.orb.dist; cvs.dispatchEvent(Object.assign(new w.WheelEvent('wheel', { deltaY: 300, cancelable: true }))); ok(F.orb.dist > dist0, 'wheel zooms out');
  d.querySelector('[data-view="top"]').click(); ok(F.orb.el > 1.4, 'top view button');
  // load demo again, run to end, click centre of view (looking down at pocket floor)
  await F.loadText(w.eval('NC').demoProgram(), 'Demo program', { stock: { xmin: -50, xmax: 50, ymin: -35, ymax: 35, zbot: -20, ztop: 0 } });
  for (let i = 0; i < 100 && !S.ready; i++) await sleep(50);
  F.goTo(S.prog.total); d.querySelector('[data-view="top"]').click();
  fire('pointerdown', 400, 300); fire('pointerup', 400, 300);
  const pb = d.getElementById('probe');
  ok(!pb.hidden && /Machined by T2/.test(pb.textContent), 'probe at pocket floor: ' + pb.querySelector('h3').textContent);
  // click on an un-machined corner of the stock (top view, well outside the pocket)
  fire('pointerdown', 40, 40); fire('pointerup', 40, 40);
  console.log('   probe (corner):', pb.hidden ? '(missed stock)' : pb.querySelector('h3').textContent);
  // probe at start: floor "will be machined by"
  F.goTo(0); d.querySelector('[data-view="top"]').click(); fire('pointerdown', 400, 300); fire('pointerup', 400, 300);
  ok(/Not cut yet/.test(pb.textContent) && /T2/.test(pb.textContent), 'probe before cutting: ' + pb.querySelector('h3').textContent + ' / ' + pb.querySelector('p').textContent.split('.')[0]);

  // ---- edit a tool, re-simulate
  const card = d.querySelector('.tool-card[data-no="2"]'); const inp = card.querySelector('[data-k="D"]');
  inp.value = '8'; inp.dispatchEvent(new w.Event('change')); d.getElementById('applyTools').click();
  await sleep(300); for (let i = 0; i < 100 && !S.ready; i++) await sleep(50);
  ok(S.tools.find(t => t.no === 2).D === 8 && S.ready, 'edited T2 diameter to 8 and re-simulated');


  // ---- real job files, loaded together the way an operator would
  const R = require('path').join(ROOT, 'fixtures') + '/';
  const mk = (buf, name) => new w.File([buf], name);
  await F.handleFiles([mk(fs.readFileSync(R + 'O1228.NC', 'latin1'), 'O1228.NC'), mk(fs.readFileSync(R + 'O1228.csv', 'utf8'), 'O1228.csv'), mk(fs.readFileSync(require('path').join(ROOT, 'fixtures', 'tools.json'), 'utf8'), 'tools.json')]);
  await sleep(300); for (let i = 0; i < 400 && !(S.ready && S.name === 'O1228.NC'); i++) await sleep(100);
  ok(S.ready && S.name === 'O1228.NC', 'real job loaded: ' + S.prog.n + ' moves, prepass ' + (S.stats.ms / 1000).toFixed(2) + ' s at ' + S.stats.nx + 'x' + S.stats.ny);
  ok(S.prog.ops.length === 16, '16 operations');
  ok(S.prog.ops[5].label === '2D Contour Finish Outside #26 #17 #18', 'operation names come from the setup sheet: ' + S.prog.ops[5].label);
  ok(S.tools.every(t => t.fromLib && t.holderSegs && t.holderSegs.length === 9), 'all 7 tools from library with 9-segment holders');
  ok(Math.abs((S.stock.xmax - S.stock.xmin) - 31.75) < 0.05 && Math.abs((S.stock.ztop - S.stock.zbot) - 28.7) < 0.05, 'stock from setup sheet: ' + (S.stock.xmax - S.stock.xmin).toFixed(2) + ' x ' + (S.stock.ymax - S.stock.ymin).toFixed(2) + ' x ' + (S.stock.ztop - S.stock.zbot).toFixed(2) + ' mm');
  ok(/inches/.test(d.getElementById('warns').textContent), 'units note shown');
  ok(/setup sheet/.test(d.getElementById('chips').textContent), 'cycle-time chip shows');
  ok(d.getElementById('opNow').textContent === '3D Adaptive Roughing3', 'HUD op name: ' + d.getElementById('opNow').textContent);
  ok(d.getElementById('tNo').textContent === 'T57' && /3\/8/.test(d.getElementById('tName').textContent), 'HUD tool: ' + d.getElementById('tNo').textContent + ' ' + d.getElementById('tName').textContent);
  const sel2 = d.getElementById('speedSel'); sel2.value = '1000'; sel2.dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'real job played to the end');
  let dm2 = 0; for (let i = 0; i < S.sim.h.length; i++) dm2 = Math.max(dm2, Math.abs(S.sim.h[i] - S.finalH[i]));
  ok(dm2 < 1e-3, 'real job: live playback == pre-pass (max diff ' + dm2.toExponential(1) + ')');
  ok(d.getElementById('tNo').textContent === 'T65', 'ends on T65: ' + d.getElementById('tNo').textContent);


  // ---- setup file from the Fusion export script (synthetic here): stock in program coordinates + two vise jaws
  const bx = (x0, y0, z0, x1, y1, z1, name) => ({ name, positions: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7] });
  const stk = { xmin: -26.95, xmax: 4.8, ymin: -15.875, ymax: 15.875, zmin: 91.08, zmax: 119.79 };
  const setupJson = (dx, sdx) => JSON.stringify({ format: 'floorsim-setup', version: 1, units: 'mm', setup: 'OP50 A side', stockMode: 0, stock: Object.assign({}, stk, { xmin: stk.xmin + sdx, xmax: stk.xmax + sdx }), fixtures: [bx(-60 + dx, -40, 60, -27.2 + dx, 40, 105, 'left jaw'), bx(5.1 + dx, -40, 60, 38 + dx, 40, 105, 'right jaw')], check: { status: 'ok' } });
  await F.handleFiles([mk(setupJson(0, 0), 'OP50.floorsim.json')]);
  await sleep(300); for (let i = 0; i < 400 && !S.ready; i++) await sleep(100);
  ok(S.ready && S.setup && S.setup.fixtures.length === 2, 'setup file loaded onto the open program (csv + library kept: ' + !!S.csv + '/' + !!S.lib + ')');
  ok(Math.abs(S.stock.xmin + 26.95) < 1e-6 && Math.abs(S.stock.ztop - 119.79) < 1e-6 && Math.abs(S.stock.zbot - 91.08) < 1e-6, 'stock comes from the setup file, not the guess');
  ok(F.fixScene.children.length === 2 && F.fixScene.visible, 'both workholding parts drawn');
  ok(!/sinks \d|cutting moves are inside/.test(d.getElementById('warns').textContent), 'correct placement raises no placement warnings');
  d.getElementById('fixSel').value = 'off'; d.getElementById('fixSel').dispatchEvent(new w.Event('change')); ok(!F.fixScene.visible, 'workholding can be hidden');
  await F.handleFiles([mk(setupJson(20, 0), 'bad1.floorsim.json')]); await sleep(300); for (let i = 0; i < 400 && !S.ready; i++) await sleep(100);
  ok(/Workholding sinks \d+/.test(d.getElementById('warns').textContent), 'fixtures pushed into the stock are flagged: ' + (d.getElementById('warns').textContent.match(/sinks [\d.]+ mm/) || [''])[0]);
  await F.handleFiles([mk(setupJson(0, 100), 'bad2.floorsim.json')]); await sleep(300); for (let i = 0; i < 400 && !S.ready; i++) await sleep(100);
  ok(/cutting moves are inside the stock box/.test(d.getElementById('warns').textContent), 'stock in the wrong place is flagged: ' + (d.getElementById('warns').textContent.match(/Only \d+%/) || [''])[0]);

  // toggle theme, display selects
  d.getElementById('themeBtn').click(); ok(!!d.documentElement.dataset.theme, 'theme toggled');
  // stress load
  const ds = d.getElementById('demoSel'); ds.value = 'stress'; ds.dispatchEvent(new w.Event('change'));
  await sleep(300); for (let i = 0; i < 600 && !(S.ready && S.name === 'Stress test' && S.stats.moves === S.prog.n); i++) await sleep(100);
  ok(S.ready && S.name === 'Stress test', 'stress program loaded: ' + S.prog.n + ' moves, prepass ' + (S.stats.ms / 1000).toFixed(2) + ' s at ' + S.stats.nx + 'x' + S.stats.ny);
  // tool library import (guessed Fusion format)
  const lib = { data: [{ 'post-process': { number: 1 }, type: 'ball end mill', unit: 'millimeters', description: 'Ø8 ball', geometry: { DC: 8, LCF: 20, LB: 35 }, holder: { segments: [{ height: 20, 'lower-diameter': 20, 'upper-diameter': 40 }, { height: 30, 'lower-diameter': 40, 'upper-diameter': 40 }] } }] };
  const n = w.eval('NC').applyLibrary(lib, S.tools);
  ok(n === 1 && S.tools[0].D === 8 && S.tools[0].type === 'ball' && S.tools[0].holderD === 40, 'tool library mapping: D=' + S.tools[0].D + ' type=' + S.tools[0].type + ' holderD=' + S.tools[0].holderD);
  console.log('\nconsole/js errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall UI checks passed');
  process.exit(fails ? 1 : 0);
})();
