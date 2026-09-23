// Phase 2 of tri-dexel: real O1224.NC (8 planes, 7 aligned + 1 real oblique one at ~80deg) driven
// through the actual page. Loaded together with O1224's OWN real CIMCO scanning data
// (fixtures/cimco/O1224.*) rather than an unrelated job's stand-in - now that a real, matching
// fixture/stock export exists for this exact job, using it here is both more realistic and
// required: since buildTriDexel prefers a real stock box when S.setup.stock is present (see
// docs/plan), feeding it a MISMATCHED box (an unrelated job's stand-in) would size the tri-dexel
// grid for the wrong part and break the probe test below in a way that isn't a real bug - it was
// this test's own fixture choice becoming stale once that preference landed, not new code.
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
const U = path.join(ROOT, 'fixtures') + path.sep, C = path.join(ROOT, 'fixtures', 'cimco') + path.sep;
const mk = (txt, name) => new w.File([txt], name);
const mkBin = (buf, name) => new w.File([buf], name);
const ready = async () => { await sleep(300); for (let i = 0; i < 600 && !w.__floorsim.S.ready; i++) await sleep(100); };

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S;

  // ---- real O1224 (8 planes, 7 aligned + 1 oblique) + its own real CIMCO scanning data
  const nc1224 = fs.readFileSync(U + 'O1224.NC', 'utf8');
  const setupText = fs.readFileSync(C + 'O1224.setup', 'utf8');
  const stockBuf = fs.readFileSync(C + 'O1224_STOCK.stl');
  const partBuf = fs.readFileSync(C + 'O1224_PART.stl');
  const fixtureBuf = fs.readFileSync(C + 'O1224_FIXTURE.stl');
  await F.handleFiles([
    mk(nc1224, 'O1224.NC'),
    mk(setupText, 'O1224.setup'),
    mkBin(stockBuf, 'O1224_STOCK.stl'),
    mkBin(partBuf, 'O1224_PART.stl'),
    mkBin(fixtureBuf, 'O1224_FIXTURE.stl'),
  ]); await ready();

  ok(S.triDexel === true, 'O1224 has 7 aligned planes (>1) - tri-dexel engages: S.triDexel = ' + S.triDexel);
  ok(!!S.td, 'S.td (the tri-dexel build) is populated');

  const triMeshes = F.TRI_ROOT.children.filter(c => c.isMesh);
  ok(triMeshes.length === 1, 'TRI_ROOT has exactly one mesh child, got ' + F.TRI_ROOT.children.length);
  const triTris = triMeshes.length ? triMeshes[0].geometry.index.count / 3 : 0;
  ok(triTris > 0, `the fused mesh has real triangles (${triTris})`);

  // Plane 7's only tool is T81, a lollipop mill (undercut) - stock removal is always skipped for
  // it, so its separate slab never visibly changes. Drawing an eternally-untouched block reads as
  // broken rather than merely unsimulated, so the stopgap (2026-09-22) is to not draw it at all -
  // the toolpath still plays, there's just no stock shape for that plane. See NOTES.md.
  ok(F.TILT_ROOT.children.length === 0, 'TILT_ROOT is empty - plane 7 is undercut-only, so its stock is not drawn, got ' + F.TILT_ROOT.children.length);
  ok(S.planes.size === 0, 'S.planes holds nothing - the only oblique plane (id 7) is undercut-only and hidden: ' + [...S.planes.keys()]);
  ok(S.sims.has(7), 'plane 7 is still simulated under the hood (just not drawn) - S.sims still has it');
  ok(F.STOCK.group.visible === false, 'the base-plane STOCK mesh is hidden - TRI_ROOT covers plane 0 now');

  // cimcoToFloorsimSetup emits ONE fixture entry (the whole real FIXTURE.stl as a single merged
  // mesh, 117,870 real triangles), unlike the older Fusion export's per-body fixtures[] array.
  ok(F.fixScene.children.length === 1, 'the real FIXTURE.stl is drawn as one mesh, got ' + F.fixScene.children.length);

  // ---- oblique plane 7's own box must not visibly overshoot the real stock box in world space.
  // boxFromMoves pads a tilted plane's own move extents (there's normally no real stock shape for
  // a tilted face), but that padding is applied in the plane's own local frame - on a steep tilt
  // like this real ~80deg plane, a 5mm local pad projects into a much bigger world displacement
  // (measured: 5.8mm past the real wall). John spotted the resulting phantom block on 2026-09-22.
  // Once a real stock box IS known (as here), the pad drops to 0.5mm - this pins that it stays
  // within about 1mm of the real wall, not the old ~6mm.
  {
    const pl7 = S.prog.planes.find(p => p.id === 7), m = pl7.matrix, o = pl7.origin, box7 = S.sims.get(7).box;
    const real = S.setup.stock;
    let xmax = -Infinity;
    for (const x of [box7.xmin, box7.xmax]) for (const y of [box7.ymin, box7.ymax]) for (const z of [box7.zbot, box7.ztop]) {
      const wx = o[0] + m[0][0] * x + m[0][1] * y + m[0][2] * z;
      if (wx > xmax) xmax = wx;
    }
    ok(xmax < real.xmax + 1, `plane 7's box stays within ~1mm of the real stock's X wall (${real.xmax.toFixed(2)}), got world xmax ${xmax.toFixed(2)}`);
  }

  // ---- tool model worldization: position AND orientation must reflect the move's real plane,
  // not the raw local coordinates updateTool() used to render directly. Drive playback to a real
  // move on a genuinely tilted plane (id 1, ijk 90/90/0 - not the identity base plane) and to one
  // on plane 0, then compare the ACTUAL rendered tool group against hand-computed world values.
  {
    const P = S.prog;
    let ii1 = -1, ii0 = -1;
    for (let i = 0; i < P.n; i++) {
      if (ii1 < 0 && P.PL[i] === 1) ii1 = i;
      if (ii0 < 0 && P.PL[i] === 0) ii0 = i;
      if (ii1 >= 0 && ii0 >= 0) break;
    }
    ok(ii1 >= 0, 'O1224 has at least one real move on tilted plane 1');
    ok(ii0 >= 0, 'O1224 has at least one real move on base plane 0');

    const check = async (ii, label, expectIdentity) => {
      const pl = P.planes[P.PL[ii]], m = pl.matrix;
      const x = P.X[ii], y = P.Y[ii], z = P.Z[ii];
      const ex = pl.origin[0] + m[0][0] * x + m[0][1] * y + m[0][2] * z;
      const ey = pl.origin[1] + m[1][0] * x + m[1][1] * y + m[1][2] * z;
      const ez = pl.origin[2] + m[2][0] * x + m[2][1] * y + m[2][2] * z;
      F.goTo(ii > 0 ? P.cumT[ii - 1] : 0);
      await sleep(100); // updateTool() runs in the RAF loop (frame()), not synchronously inside goTo()
      const tg = F.toolGroups.get(P.TL[ii]);
      const dx = Math.abs(tg.position.x - ex), dy = Math.abs(tg.position.y - ey), dz = Math.abs(tg.position.z - ez);
      ok(dx < 1e-3 && dy < 1e-3 && dz < 1e-3, `${label}: tool world position matches hand-computed (${ex.toFixed(2)},${ey.toFixed(2)},${ez.toFixed(2)}) vs got (${tg.position.x.toFixed(2)},${tg.position.y.toFixed(2)},${tg.position.z.toFixed(2)})`);
      const q = tg.quaternion, isIdentity = Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9 && Math.abs(q.z) < 1e-9 && Math.abs(q.w - 1) < 1e-9;
      ok(isIdentity === expectIdentity, `${label}: tool quaternion identity=${isIdentity}, expected ${expectIdentity}`);
    };
    await check(ii1, 'plane 1 (tilted)', false);
    await check(ii0, 'plane 0 (base)', true);
  }

  // ---- live stock removal: the tri-dexel grids must genuinely carry PARTIAL cut state as the
  // program plays, not just the finished shape. Counting cut cells (op[] is non-zero only where a
  // real move removed material) at three points in the timeline proves progressive cutting rather
  // than a static mesh being repainted: uncut at the start, partly cut in the middle, more cut
  // later, and scrubbing BACK returns to a genuinely earlier state rather than staying at the end.
  {
    const P = S.prog;
    const cutCells = () => { let c = 0; for (const g of S.td.grids.values()) for (let k = 0; k < g.op.length; k++) if (g.op[k]) c++; return c; };

    F.goTo(0); await sleep(60);
    const atStart = cutCells();
    ok(atStart === 0, `at time zero the stock is uncut: ${atStart} cut cells (the "already machined before it runs" bug)`);

    F.goTo(P.total * 0.35); await sleep(200);
    const atMid = cutCells();
    ok(atMid > 0, `part-way through, material has actually been removed: ${atMid} cut cells`);

    F.goTo(P.total * 0.75); await sleep(200);
    const atLate = cutCells();
    ok(atLate > atMid, `further along, MORE has been removed: ${atLate} > ${atMid} cut cells`);

    F.goTo(P.total * 0.35); await sleep(200);
    const backAgain = cutCells();
    ok(backAgain < atLate, `scrubbing back restores an earlier, less-cut state: ${backAgain} < ${atLate} cut cells`);

    // The visible mesh must actually track that state, not just the underlying grids.
    const triAtMid = F.TRI_ROOT.children.find(c => c.isMesh).geometry.index.count / 3;
    F.goTo(P.total); await sleep(400);
    const triAtEnd = F.TRI_ROOT.children.find(c => c.isMesh).geometry.index.count / 3;
    ok(triAtMid > 0 && triAtEnd > 0, `the fused mesh is rebuilt at both points (${triAtMid} -> ${triAtEnd} tris)`);
    ok(triAtMid !== triAtEnd, `the fused mesh genuinely CHANGES between timeline points (${triAtMid} vs ${triAtEnd} tris) - not one static mesh`);
  }

  // ---- Phase 3: real probe on the fused tri-dexel mesh.
  // Runs at the END of the program (goTo(P.total) above), where the grids carry the finished cut
  // state - at time zero they are now correctly uncut, so there would be nothing to probe.
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

  // ---- the oblique plane (id 7, undercut-only and not drawn at all - see above) stays
  // structurally unprobable: pickAtTri only ever raycasts TRI_ROOT's own mesh, so it cannot report
  // tri-dexel provenance for a point that was never part of that mesh. Click toward plane 7's own
  // origin (S.planes has no entry for it now, so read straight from the program's own plane data,
  // the same origin rebuild() would have positioned its stock group at if it drew one) to confirm
  // this in practice, not just by code inspection.
  const pl7def = S.prog.planes.find(p => p.id === 7);
  const [ox, oy] = project(pl7def.origin[0], pl7def.origin[1], pl7def.origin[2]);
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
  const setupOP50 = fs.readFileSync(U + 'setups' + path.sep + 'OP50.floorsim.json', 'utf8'); // O1228's own real matching setup, not the cimco dir
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
