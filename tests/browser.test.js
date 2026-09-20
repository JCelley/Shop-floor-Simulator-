// Loads the built page in a real Chromium (via Playwright), not jsdom. Confirms WebGL actually
// draws something and the sim survives CPU throttling that approximates a Chromebook.
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
  ok(true, 'demo program loaded and pre-pass finished in real Chromium');
  ok(await page.$eval('#fatal', el => el.hidden), 'no fatal overlay');

  // canvas actually drew something: force one render, then read pixels back from the WebGL
  // context immediately (the browser can clear the drawing buffer right after compositing,
  // so reading on a stale frame gives a false blank)
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
  await page.screenshot({ path: path.join(OUT_DIR, 'demo.png') });

  // ---- CPU throttle 4x (rough Chromebook approximation) + the stress program ----
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.selectOption('#demoSel', 'stress');
  await page.waitForFunction(
    () => window.__floorsim && window.__floorsim.S.ready && window.__floorsim.S.name === 'Stress test',
    { timeout: 30000 }
  );
  const stats = await page.evaluate(() => window.__floorsim.S.stats);
  ok(stats.moves > 0, `stress program (${stats.moves} moves) pre-pass under 4x CPU throttle: ${(stats.ms / 1000).toFixed(2)}s`);

  await page.evaluate(() => {
    document.getElementById('speedSel').value = '1000';
    document.getElementById('speedSel').dispatchEvent(new Event('change'));
    document.getElementById('bPlay').click();
  });
  const t0 = Date.now();
  await page.waitForFunction(() => !window.__floorsim.S.playing, { timeout: 60000 });
  ok(true, `stress playback ran to completion under throttle in ${Date.now() - t0}ms`);
  await page.screenshot({ path: path.join(OUT_DIR, 'stress.png') });

  console.log('\nconsole/js errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors in a real browser');

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall browser checks passed');
  process.exit(fails ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
