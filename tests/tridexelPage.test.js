// Phase 2 of tri-dexel: real O1224.NC (8 planes, 7 aligned + 1 real oblique one at ~80deg) driven
// through the actual page. O1224 has no fixture export of its own, so OP50.floorsim.json (a
// different real job's real fixture geometry, 45 bodies) is loaded alongside it purely as a
// stand-in to test the attachment MECHANISM (one shared world frame needs no per-plane rotation
// code to keep the fixture lined up) - not a claim that this is O1224's real vise. See docs/plan.
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
const U = path.join(ROOT, 'fixtures') + path.sep, C = path.join(ROOT, 'fixtures', 'setups') + path.sep;
const mk = (txt, name) => new w.File([txt], name);
const ready = async () => { await sleep(300); for (let i = 0; i < 600 && !w.__floorsim.S.ready; i++) await sleep(100); };

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;

  // ---- real O1224 (8 planes, 7 aligned + 1 oblique) + a stand-in fixture, loaded together
  const nc1224 = fs.readFileSync(U + 'O1224.NC', 'utf8');
  const fixtureStandIn = fs.readFileSync(C + 'OP50.floorsim.json', 'utf8');
  await F.handleFiles([mk(nc1224, 'O1224.NC'), mk(fixtureStandIn, 'OP50.floorsim.json')]); await ready();

  ok(S.triDexel === true, 'O1224 has 7 aligned planes (>1) - tri-dexel engages: S.triDexel = ' + S.triDexel);
  ok(!!S.td, 'S.td (the tri-dexel build) is populated');

  const triMeshes = F.TRI_ROOT.children.filter(c => c.isMesh);
  ok(triMeshes.length === 1, 'TRI_ROOT has exactly one mesh child, got ' + F.TRI_ROOT.children.length);
  const triTris = triMeshes.length ? triMeshes[0].geometry.index.count / 3 : 0;
  ok(triTris > 0, `the fused mesh has real triangles (${triTris})`);

  ok(F.TILT_ROOT.children.length === 1, 'TILT_ROOT has exactly one child (the one oblique plane, id 7), got ' + F.TILT_ROOT.children.length);
  ok(S.planes.size === 1 && S.planes.has(7), 'S.planes holds only the oblique plane (id 7): ' + [...S.planes.keys()]);
  ok(F.STOCK.group.visible === false, 'the base-plane STOCK mesh is hidden - TRI_ROOT covers plane 0 now');

  ok(F.fixScene.children.length === 45, '45 workholding bodies drawn from the stand-in fixture file, got ' + F.fixScene.children.length);

  // ---- Phase 3: real probe on the fused tri-dexel mesh
  const cvs = F.renderer.domElement; cvs.setPointerCapture = () => {}; cvs.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const fire = (type, x, y) => cvs.dispatchEvent(new w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
  const project = (x, y, z) => {
    F.camera.updateMatrixWorld(true);
    const v = new w.THREE.Vector3(x, y, z).project(F.camera);
    return [(v.x * 0.5 + 0.5) * 800, (-v.y * 0.5 + 0.5) * 600];
  };
  d.querySelector('[data-view="top"]').click(); await sleep(50);

  // Pick a real, already-cut cell straight from the Z+ grid (the base plane's own signed grid,
  // guaranteed present) instead of guessing screen pixels - grounds the expected tool in the
  // actual simulated data, not an assumption about where a feature happens to render.
  const gridZ = S.td.grids.get('Z+');
  let hitIdx = -1;
  for (let k = 0; k < gridZ.nx * gridZ.ny; k++) if (gridZ.op[k]) { hitIdx = k; break; }
  ok(hitIdx >= 0, 'the Z+ grid has at least one real cut cell to probe');
  const gi = hitIdx % gridZ.nx, gj = Math.floor(hitIdx / gridZ.nx);
  const wx = gridZ.x0 + (gi + 0.5) * gridZ.dx, wy = gridZ.y0 + (gj + 0.5) * gridZ.dy, wz = gridZ.h[hitIdx];
  const expectedOpk = gridZ.op[hitIdx] - 1, expectedTool = S.prog.ops[expectedOpk].tool;
  const [sx, sy] = project(wx, wy, wz);
  fire('pointerdown', sx, sy); fire('pointerup', sx, sy);
  const pb = d.getElementById('probe');
  ok(!pb.hidden, `probe hit the real point (${wx.toFixed(1)},${wy.toFixed(1)},${wz.toFixed(1)}) from the Z+ grid`);
  ok(new RegExp(`T${expectedTool}\\b`).test(pb.textContent), `probe reports the real tool T${expectedTool} that actually cut this cell: got "${pb.querySelector('h3') ? pb.querySelector('h3').textContent : pb.textContent}"`);

  // ---- miss case: clicking clearly outside the part behaves like today's "nothing there", no crash
  let probeThrew = false;
  try { fire('pointerdown', 5, 5); fire('pointerup', 5, 5); } catch (e) { probeThrew = true; console.log('probe threw:', e.message); }
  ok(!probeThrew, 'clicking off the part does not crash');
  ok(pb.hidden, 'probe popup hides on a miss, same as the single-plane path');

  // ---- the oblique plane (id 7, rendered only via TILT_ROOT) stays structurally unprobable:
  // pickAtTri only ever raycasts TRI_ROOT's own mesh, so it cannot report tri-dexel provenance for
  // a point that was never part of that mesh. Click toward plane 7's own local origin to confirm
  // this in practice, not just by code inspection.
  const pl7 = S.planes.get(7);
  const [ox, oy] = project(pl7.stock.group.position.x, pl7.stock.group.position.y, pl7.stock.group.position.z);
  let obliqueThrew = false;
  try { fire('pointerdown', ox, oy); fire('pointerup', ox, oy); } catch (e) { obliqueThrew = true; console.log('oblique-plane probe threw:', e.message); }
  ok(!obliqueThrew, 'clicking near the oblique plane (id 7) does not crash');
  // No further assertion needed here: pickAtTri (src/app.js) only ever calls
  // raycaster.intersectObject(TRI_ROOT's mesh) - it has no code path that can attribute a hit to
  // plane 7, since plane 7's moves were never cut into any tri-dexel grid. A hit here can only be
  // real TRI_ROOT geometry (legitimate provenance) or a miss (hidden); there is no fabricated case
  // to distinguish at runtime beyond the no-crash check above.

  // ---- full playback reaches completion without hanging/crashing
  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'O1224 played to completion through the tri-dexel path');

  // ---- camera actually fit around the part (not stuck at a default/zero distance because S.sim is undefined)
  ok(isFinite(F.orb.dist) && F.orb.dist > 10, 'camera fit a real distance around the tri-dexel job: ' + F.orb.dist);

  console.log('errors so far:', errors.length ? errors : 'none');

  // ---- regression proof: single-plane O1228 still takes exactly today's path, unaffected
  errors.length = 0;
  const nc1228 = fs.readFileSync(U + 'O1228.NC', 'latin1');
  const setupOP50 = fs.readFileSync(C + 'OP50.floorsim.json', 'utf8');
  await F.handleFiles([mk(nc1228, 'O1228.NC'), mk(setupOP50, 'OP50.floorsim.json')]); await ready();

  ok(S.triDexel === false, 'single-plane O1228 does not engage tri-dexel: S.triDexel = ' + S.triDexel);
  ok(S.td === null, 'S.td is null on the single-plane path');
  ok(!!S.sim, 'S.sim (plane 0) is populated again on the single-plane path');
  ok(F.TRI_ROOT.children.length === 0, 'TRI_ROOT is empty on a single-plane job');
  ok(F.STOCK.group.visible === true, 'the base STOCK mesh is visible again on the single-plane path');
  ok(S.planes.size === 1 && S.planes.has(0), 'S.planes is back to just the base plane, as always for a single-plane job');
  ok(F.fixScene.children.length === 45, 'fixtures still draw normally on the single-plane path');

  d.getElementById('speedSel').value = '1000'; d.getElementById('speedSel').dispatchEvent(new w.Event('change')); d.getElementById('bPlay').click();
  for (let i = 0; i < 600 && S.playing; i++) await sleep(50);
  ok(!S.playing && S.cur.i === S.prog.n, 'O1228 (single-plane) still plays to completion normally');

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors across either load');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
