// G-code panel: always editable (no Edit button), edits are never saved (John's request), and while
// unedited it steps the sim line by line - click a line, mouse wheel, arrow keys, or the two step
// buttons. Also covers the restart sequence number (N on each op's G100 line) on the real O1228 job.
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
const settled = async () => { for (let i = 0; i < 200 && w.__floorsim.S.pendingSeek !== null; i++) await sleep(20); await sleep(150); };

(async () => {
  for (let i = 0; i < 100 && !(w.__floorsim && w.__floorsim.S.ready); i++) await sleep(50);
  const F = w.__floorsim, S = F.S, ta = d.getElementById('code'), row = d.getElementById('codeEditRow');
  const type = v => { ta.value = v; ta.dispatchEvent(new w.Event('input')); };
  const originalText = S.text, originalName = S.name, originalMoves = S.prog.n;

  // ---- the box already holds the program; no Edit button exists any more
  ok(ta.tagName === 'TEXTAREA' && ta.value === originalText.replace(/\r/g, ''), 'the G-code box is an editable textarea holding the whole program');
  ok(!d.getElementById('codeEditBtn'), 'there is no separate Edit button');
  ok(row.hidden && !S.codeDirty, 'Run/Undo buttons hidden until something is actually changed');

  // ---- typing marks it edited and pauses playback; undo puts it back without re-simulating
  S.playing = true;
  const edited = originalText.replace('T1 M6', 'T1 M6\n(EDITED BY OPERATOR)');
  type(edited);
  ok(S.codeDirty && !row.hidden, 'typing shows Run/Undo');
  ok(!S.playing, 'typing pauses playback');
  d.getElementById('codeCancel').click();
  ok(!S.codeDirty && row.hidden && ta.value === originalText.replace(/\r/g, ''), 'Undo edits restores the original text');
  ok(S.text === originalText && S.name === originalName, 'undo does not touch the loaded program');
  type(originalText + '');
  ok(!S.codeDirty, 'text that matches the loaded program again is not "edited"');

  // ---- editing and running re-simulates the new text
  type(edited);
  await F.runCodeEdit(); await ready();
  ok(S.text === edited.replace(/\r/g, ''), 'the edited text is what actually got loaded');
  ok(S.name === originalName + ' (edited)', 'the name is marked as edited: ' + S.name);
  ok(!S.codeDirty && row.hidden, 'a successful run clears the edited state');

  type(S.text.replace('(EDITED BY OPERATOR)', '(EDITED AGAIN)'));
  await F.runCodeEdit(); await ready();
  ok(S.name === originalName + ' (edited)', 'no stacked "(edited) (edited)": ' + S.name);

  // ---- a broken edit is refused and stays in the box to fix
  const before = S.text;
  type('(nothing but a comment, no moves at all)');
  await F.runCodeEdit(); await sleep(300);
  ok(S.text === before, 'a broken edit does not replace the working program');
  ok(S.codeDirty && !row.hidden, 'the broken text stays in the box with Run/Undo still showing');

  // ---- loading something else throws away unsaved edits
  const demoText = w.eval('NC').demoProgram();
  await F.handleFiles([new w.File([demoText], 'O9999.NC')]); await ready();
  ok(!S.codeDirty && row.hidden && ta.value === demoText.replace(/\r/g, ''), 'loading a different file replaces the box and drops the edit');
  ok(S.prog.n === originalMoves, 'the newly loaded program is the one shown: ' + S.prog.n + ' moves');

  // ================= real O1228: restart sequence numbers + line-by-line stepping =================
  const nc = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.NC'), 'utf8');
  const csv = fs.readFileSync(path.join(ROOT, 'fixtures', 'O1228.csv'), 'utf8');
  await F.handleFiles([new w.File([nc], 'O1228.NC'), new w.File([csv], 'O1228.csv')]); await ready();
  const P = S.prog, lines = P.lines;

  // every op carries the N from its own G100 line, shown in the list
  const g100 = []; lines.forEach((l, k) => { const m = /^N(\d+)\s+G100\s+T(\d+)/.exec(l); if (m) g100.push({ line: k + 1, n: +m[1], tool: +m[2] }); });
  ok(g100.length > 3, `found ${g100.length} real G100 tool-change lines`);
  const opN = P.ops.map(o => o.seqN);
  ok(P.ops.every(o => g100.some(g => g.n === o.seqN && g.tool === o.tool)), 'each op\'s restart N is the N on a G100 line for its own tool: ' + opN.join(','));
  const csvSeq = w.eval('NC').parseSetupCsv(csv).ops.map(o => Math.floor(parseFloat(o.seq)));
  ok(csvSeq.length === P.ops.length && csvSeq.every((s, k) => s === P.ops[k].seqN), 'and it matches the setup-sheet CSV Seq# for every op');
  const badges = [...d.querySelectorAll('#ops .opbadge.seq')].map(b => b.textContent);
  ok(badges.length === P.ops.length && badges[0] === 'N' + P.ops[0].seqN, 'N badge next to every operation: ' + badges.slice(0, 5).join(' '));

  // clicking an operation shows its restart number
  const k3 = P.ops.findIndex(o => o.seqN === g100[3].n);
  d.querySelectorAll('#ops button')[k3].click(); await settled();
  const rb = d.getElementById('restartBox');
  ok(!rb.hidden && /Restart seq #/.test(rb.textContent) && d.getElementById('restartN').textContent === String(g100[3].n), `clicking op ${k3 + 1} shows "Restart seq # ${g100[3].n}": "${rb.textContent}"`);

  // ---- jump to a line: everything on and before it has run, nothing after
  const L = g100[2].line + 6;
  F.goToLine(L, true); await settled();
  let k = -1; for (let i = 0; i < P.n; i++) if (P.LN[i] <= L) k = i;
  const tg = F.toolGroups.get(P.TL[k]);
  ok(S.hudLine === L && !d.getElementById('codeHl').hidden, 'the chosen line is the highlighted current line');
  ok(tg && tg.visible && Math.abs(tg.position.x - P.X[k]) < 1e-3 && Math.abs(tg.position.z - P.Z[k]) < 1e-3, `tool sits at the end of the last move on or before line ${L} (move ${k})`);
  ok(d.getElementById('tNo').textContent === 'T' + P.TL[k], 'HUD tool matches that line: ' + d.getElementById('tNo').textContent);

  // ---- step buttons, wheel and arrow keys each move exactly one line
  d.getElementById('lineDn').click(); await settled();
  ok(S.selLine === L + 1 && S.hudLine === L + 1, 'step-forward button: one line down');
  d.getElementById('lineUp').click(); d.getElementById('lineUp').click(); await settled();
  ok(S.selLine === L - 1, 'step-back button twice: two lines up');
  ta.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100, cancelable: true })); await settled();
  ok(S.selLine === L, 'one mouse-wheel notch down = one line');
  ta.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100, cancelable: true })); await settled();
  ok(S.selLine === L - 1, 'one notch up = one line back');
  ta.focus(); ta.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settled();
  ok(S.selLine === L, 'Down arrow in the code box = one line forward');

  // stepping back across a tool change shows the earlier tool again
  F.goToLine(g100[2].line - 1, true); await settled();
  ok(d.getElementById('tNo').textContent === 'T' + g100[1].tool, `line before the 3rd tool change shows the previous tool (T${g100[1].tool}): ${d.getElementById('tNo').textContent}`);
  F.stepLine(1); await settled();
  ok(d.getElementById('tNo').textContent === 'T' + g100[2].tool, `stepping onto the G100 line shows the new tool (T${g100[2].tool}): ${d.getElementById('tNo').textContent}`);

  // ---- clicking a line jumps there
  const L2 = g100[4].line + 3, starts = [0]; for (let i = ta.value.indexOf('\n'); i >= 0; i = ta.value.indexOf('\n', i + 1)) starts.push(i + 1);
  ta.setSelectionRange(starts[L2 - 1] + 1, starts[L2 - 1] + 1); ta.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settled();
  ok(S.selLine === L2 && S.hudLine === L2, `clicking in line ${L2} jumps the sim there (got ${S.selLine})`);

  // ---- pressing Play hands the panel back to following the sim
  const t0 = S.tau; d.getElementById('bPlay').click(); await sleep(300); d.getElementById('bPlay').click();
  ok(S.selLine === null && S.tau > t0, 'Play resumes from the stepped line and the panel follows the sim again');

  // ---- once edited, the wheel is plain scrolling and does not step the sim
  const sel0 = S.selLine, tau0 = S.tau;
  type(ta.value + '\n(NOTE)');
  ta.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100, cancelable: true })); await sleep(200);
  ok(S.selLine === sel0 && S.tau === tau0, 'while edited, scrolling the code does not move the sim');
  d.getElementById('codeCancel').click();

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
