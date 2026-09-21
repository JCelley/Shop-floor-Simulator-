// Phase 3 visual verification: loads the real O1224 job (7 aligned planes + 1 real oblique one)
// in real Chromium via Playwright, not jsdom, and confirms something real is drawn - for a human
// to look at tests/.tmp/screenshots/tridexel-o1224.png and judge: one connected, fixtured solid
// for the 7 aligned planes, one separate mesh for the oblique plane (id 7), no obvious phantom
// gouges or disconnected floating pieces. Same fixture stand-in used elsewhere in this project's
// tri-dexel tests (O1224 has no fixture export of its own - see docs/plan and tridexelPage.test.js).
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require('playwright');
const OUT_DIR = path.join(ROOT, 'tests', '.tmp', 'screenshots');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

  const url = 'file://' + path.join(ROOT, 'dist', 'nc-floor-sim.html').replace(/\\/g, '/');
  await page.goto(url);
  await page.waitForFunction(() => window.__floorsim && window.__floorsim.S.ready, { timeout: 15000 });

  const nc1224 = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1224.NC'), 'utf8');
  const fixtureStandIn = fs.readFileSync(path.join(ROOT, 'fixtures', 'setups', 'OP50.floorsim.json'), 'utf8');
  await page.evaluate(({ nc, fx }) => {
    const F = window.__floorsim;
    return F.handleFiles([new File([nc], 'O1224.NC'), new File([fx], 'OP50.floorsim.json')]);
  }, { nc: nc1224, fx: fixtureStandIn });
  await page.waitForFunction(() => window.__floorsim && window.__floorsim.S.ready && window.__floorsim.S.triDexel === true, { timeout: 30000 });
  ok(true, 'real O1224 job loaded and tri-dexel engaged in real Chromium');
  ok(await page.$eval('#fatal', el => el.hidden), 'no fatal overlay');

  const state = await page.evaluate(() => {
    const F = window.__floorsim;
    const triMesh = F.TRI_ROOT.children.find(c => c.isMesh);
    return {
      triMeshes: F.TRI_ROOT.children.filter(c => c.isMesh).length,
      triTris: triMesh ? triMesh.geometry.index.count / 3 : 0,
      tiltChildren: F.TILT_ROOT.children.length,
      fixtureBodies: F.fixScene.children.length,
    };
  });
  ok(state.triMeshes === 1, `real browser: TRI_ROOT has exactly one mesh, got ${state.triMeshes}`);
  ok(state.triTris > 0, `real browser: fused mesh has real triangles (${state.triTris})`);
  ok(state.tiltChildren === 1, `real browser: TILT_ROOT has exactly one child (the oblique plane), got ${state.tiltChildren}`);
  ok(state.fixtureBodies === 45, `real browser: 45 workholding bodies drawn, got ${state.fixtureBodies}`);

  // canvas actually drew something real - same read-pixels-right-after-a-forced-render pattern as
  // tests/browser.test.js, since the drawing buffer can be cleared right after compositing
  const px = await page.evaluate(() => {
    const F = window.__floorsim;
    F.renderer.render(F.scene, F.camera);
    const gl = F.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const distinct = new Set();
    for (let i = 0; i < buf.length; i += 4 * 997) distinct.add(buf[i] + ',' + buf[i + 1] + ',' + buf[i + 2]);
    return { w, h, distinct: distinct.size };
  });
  ok(px.w > 0 && px.h > 0, `canvas has size ${px.w}x${px.h}`);
  ok(px.distinct > 3, `canvas shows real rendered content (${px.distinct} distinct sampled colours)`);

  await page.screenshot({ path: path.join(OUT_DIR, 'tridexel-o1224.png') });
  ok(fs.existsSync(path.join(OUT_DIR, 'tridexel-o1224.png')), 'screenshot written to tests/.tmp/screenshots/tridexel-o1224.png');

  console.log('\nconsole/js errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors in a real browser');

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall browser checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
