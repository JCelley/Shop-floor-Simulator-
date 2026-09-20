const ROOT = require('path').join(__dirname, '..');
const fs = require('fs'), NC = require('../src/engine.js');
const U = require('path').join(ROOT, 'fixtures') + '/';
(async () => {
  const text = fs.readFileSync(U + 'O1228.NC', 'latin1');
  const csv = NC.parseSetupCsv(fs.readFileSync(U + 'O1228.csv', 'utf8'));
  const zb = fs.readFileSync(U + 'CAM_-_SOL1-902195_REV_A_-_Outlet_Fitting.tools');
  const lib = JSON.parse(await NC.unzipText(new Uint8Array(zb)));
  console.log('csv: stock mm', JSON.stringify(csv.stock), 'cycle', csv.cycleSec, 's, ops', csv.ops.length, 'tools', csv.tools.length, csv.machine);
  console.log('lib tools', lib.data.length);
  const P = NC.parseProgram(text);
  console.log('\nparsed moves', P.n, '| ops', P.ops.length, '| tools', P.tools.map(t => t.no).join(','));
  console.log('notes:', P.notes); console.log('warnings:', P.warnings);
  console.log('ops:', P.ops.map((o, i) => `${i}:T${o.tool}:${o.label}`).join(' | '));
  console.log('first move (mm):', P.X[0].toFixed(2), P.Y[0].toFixed(2), P.Z[0].toFixed(2), ' (in):', (P.X[0] / 25.4).toFixed(4), (P.Y[0] / 25.4).toFixed(4), (P.Z[0] / 25.4).toFixed(4));
  console.log('name-guessed tools:'); P.tools.forEach(t => console.log(`  T${t.no} ${t.type} D=${(t.D / 25.4).toFixed(4)}in rc=${(t.rc / 25.4).toFixed(4)} tip=${t.tip} stick=${(t.stick / 25.4).toFixed(2)}in holder=${t.holderName}`));
  const nCsv = NC.applyCsvTools(P.tools, csv);
  const nLib = NC.applyLibrary(lib, P.tools);
  console.log('\ncsv-sized', nCsv, ' library-matched', nLib);
  P.tools.forEach(t => console.log(`  T${t.no} ${t.type} D=${(t.D / 25.4).toFixed(4)}in rc=${(t.rc / 25.4).toFixed(4)} tip=${t.tip} tipD=${(t.tipD / 25.4).toFixed(3)} flute=${(t.flute / 25.4).toFixed(3)}in stick=${(t.stick / 25.4).toFixed(2)}in holderH=${(t.holderH / 25.4).toFixed(2)}in holderD=${(t.holderD / 25.4).toFixed(3)}in segs=${t.holderSegs ? t.holderSegs.length : 0} "${t.name}"`));
  const b = P.bounds, inch = v => (v / 25.4).toFixed(3);
  console.log('\nfeed bounds (in): X', inch(b.xmin), inch(b.xmax), 'Y', inch(b.ymin), inch(b.ymax), 'Z', inch(b.zmin), inch(b.zmax));
  console.log('estimated time', (P.total / 60).toFixed(1), 'min   setup sheet says', (csv.cycleSec / 60).toFixed(1), 'min');
  // stock as the app will place it: CSV size centred on the cut bounds, top at highest cutting Z
  const cx = (b.xmin + b.xmax) / 2, cy = (b.ymin + b.ymax) / 2, top = Math.round(b.zmax * 100) / 100;
  const box = { xmin: cx - csv.stock.x / 2, xmax: cx + csv.stock.x / 2, ymin: cy - csv.stock.y / 2, ymax: cy + csv.stock.y / 2, ztop: top, zbot: top - csv.stock.z };
  console.log('stock (in): X', inch(box.xmin), inch(box.xmax), 'Y', inch(box.ymin), inch(box.ymax), 'Z', inch(box.zbot), inch(box.ztop));
  const simTools = new Map(P.tools.map(t => [t.no, NC.simTool(t)]));
  const sim = new NC.HeightSim(box, 360);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < P.n; i++) NC.cutMove(sim, P, simTools, i, 0, 1);
  console.log(`sim ${P.n} moves on ${sim.nx}x${sim.ny} (${sim.dx.toFixed(3)} mm): ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);
  // stats + ASCII depth map
  let cut = 0, thru = 0, minH = 1e9;
  for (const h of sim.h) { if (h < box.ztop - 1e-4) cut++; if (h <= box.zbot + 1e-4) thru++; if (h < minH) minH = h; }
  console.log(`cut cells ${(100 * cut / sim.h.length).toFixed(1)}%  at stock bottom ${thru}  deepest ${inch(minH)} in  (bottom ${inch(box.zbot)})`);
  const chars = ' .:-=+*#%@', depth = box.ztop - box.zbot, cols = 72, rows = 36;
  console.log('\ntop view, deeper = denser (Y up):');
  for (let r = rows - 1; r >= 0; r--) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const i = Math.min(sim.nx - 1, Math.floor(c / cols * sim.nx)), j = Math.min(sim.ny - 1, Math.floor(r / rows * sim.ny));
      const d = (box.ztop - sim.h[j * sim.nx + i]) / depth;
      line += chars[Math.min(9, Math.floor(d * 10 * 1.0))];
    }
    console.log(line);
  }
  // G18/G19 + G100 unit tests
  const T = NC.parseProgram('G20\nG00 X0 Y0 Z1\nG100 T5 X1 Y0 Z1\nG19 G03 Y1.0375 Z0.9625 J0.0375\nG18 G02 X1.0375 Z0.925 I0.0375\n');
  console.log('\nG100 -> tool', T.TL[T.n - 1], '| moves', T.n);
  let err = 0; for (let i = 1; i < T.n; i++) { }
  const last = T.n - 1; console.log('last move (in):', (T.X[last] / 25.4).toFixed(4), (T.Y[last] / 25.4).toFixed(4), (T.Z[last] / 25.4).toFixed(4), 'warnings', T.warnings);
})().catch(e => { console.error(e); process.exit(1); });
