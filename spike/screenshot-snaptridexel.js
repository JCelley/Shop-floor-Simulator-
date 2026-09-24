const path = require('path'), fs = require('fs');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
(async () => {
  const url = 'file://' + path.join(__dirname, 'render.html').replace(/\\/g, '/');
  for (const job of ['o1160', 'o1224']) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('pageerror', e => console.log(job, 'pageerror:', e.message));
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, `out-snaptridexel-${job}.json`), 'utf8'));
    await page.addInitScript(d => { window.__FUSED_DATA = d; }, data);
    for (const angle of [0, 1, 2]) {
      await page.goto(url + '?angle=' + angle);
      await page.waitForFunction(() => window.__rendered === true, { timeout: 20000 });
      await page.screenshot({ path: path.join(__dirname, `out-snaptridexel-${job}-${angle}.png`) });
    }
    await browser.close();
    console.log(job, 'done');
  }
})().catch(e => { console.error(e); process.exit(1); });
