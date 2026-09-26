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

  // ---- the box already holds the program; no Edit or Run button
  ok(ta.tagName === 'TEXTAREA' && ta.value === originalText.replace(/\r/g, ''), 'the G-code box is an editable textarea holding the whole program');
  ok(!d.getElementById('codeEditBtn') && !d.getElementById('codeRun'), 'there is no Edit button and no Run button');
  ok(row.hidden && !S.codeDirty, 'Undo hidden until something is actually changed');
  ok(!!d.querySelector('#vp #codePane'), 'the G-code sits over the 3D view');

  // ---- typing updates the sim by itself after a short pause - no Run button (John: the reload
  // lost his place). The camera stays where he put it.
  S.playing = true;
  const edited = originalText.replace('T1 M6', 'T1 M6\n(EDITED BY OPERATOR)');
  w.__floorsim.orb.az = 1.234;
  type(edited);
  ok(S.codeDirty && !S.playing, 'typing marks the box changed and pauses playback');
  ok(S.text === originalText, 'nothing re-simulates on every keystroke');
  await sleep(900); await ready();
  ok(S.text === edited.replace(/\r/g, ''), 'a moment after typing stops, the edited text is what is simulated');
  ok(!S.codeDirty && !row.hidden, 'the box counts as applied, and "Undo all edits" is offered');
  ok(S.name === originalName + ' (edited)', 'the name is marked as edited: ' + S.name);
  ok(w.__floorsim.orb.az === 1.234, 'the camera was not reset by the live update');

  // a second edit does not stack "(edited) (edited)"; typing again before the pause runs it once
  type(S.text.replace('(EDITED BY OPERATOR)', '(EDITED A)'));
  type(S.text.replace('(EDITED BY OPERATOR)', '(EDITED AGAIN)'));
  await sleep(900); await ready();
  ok(/\(EDITED AGAIN\)/.test(S.text) && S.name === originalName + ' (edited)', 'only the last text is applied, name not stacked: ' + S.name);

  // ---- code with no moves at all is not applied; the last good version stays in the sim
  const before = S.text;
  type('(nothing but a comment, no moves at all)');
  await sleep(900);
  ok(S.text === before && S.codeDirty, 'text with no moves does not replace the working program, and stays in the box to fix');

  // ---- "Undo all edits" goes back to the program as opened, and simulates it
  d.getElementById('codeCancel').click(); await sleep(200); await ready();
  ok(S.text === originalText.replace(/\r/g, '') && ta.value === S.text && !S.codeDirty && row.hidden, 'Undo all edits restores and re-runs the original program');
  ok(S.name === originalName, 'and the name loses "(edited)": ' + S.name);

  // ---- loading something else throws away edits
  type(edited);
  const demoText = w.eval('NC').demoProgram();
  await F.handleFiles([new w.File([demoText], 'O9999.NC')]); await ready(); await sleep(900);
  ok(!S.codeDirty && row.hidden && ta.value === demoText.replace(/\r/g, ''), 'loading a different file replaces the box and drops the edit');
  ok(S.prog.n === originalMoves && S.name === 'O9999.NC', 'the newly loaded program is the one shown: ' + S.name);

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
  // the list shows the setup sheet's own Seq# (30, 30.1, 30.2...), not the tool change's N (John,
  // 2026-09-26: "display the N number from the sequence detail"); Restart seq # keeps the G100 N
  const badges = [...d.querySelectorAll('#ops .opbadge.seq')].map(b => b.textContent);
  const csvSeqStr = w.eval('NC').parseSetupCsv(csv).ops.map(o => 'N' + String(o.seq).trim());
  ok(badges.length === P.ops.length && badges.every((b, k) => b === csvSeqStr[k]), 'each operation shows its setup-sheet Seq#: ' + badges.slice(0, 8).join(' '));

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

  // ---- while typing (before the pause), the wheel is plain scrolling and does not step the sim
  const sel0 = S.selLine, tau0 = S.tau;
  type(ta.value + '\n(NOTE)');
  ta.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100, cancelable: true })); await sleep(200);
  ok(S.selLine === sel0 && S.tau === tau0, 'while typing, scrolling the code does not move the sim');

  // ---- the live update lands on the line being edited
  const L3 = g100[3].line + 2, st3 = [0]; for (let i = ta.value.indexOf('\n'); i >= 0; i = ta.value.indexOf('\n', i + 1)) st3.push(i + 1);
  ta.setSelectionRange(st3[L3 - 1], st3[L3 - 1]);
  type(ta.value); ta.setSelectionRange(st3[L3 - 1], st3[L3 - 1]);
  await sleep(900); await ready(); await settled();
  ok(S.hudLine === L3, `after the live update the sim sits on the edited line ${L3} (got ${S.hudLine})`);
  d.getElementById('codeCancel').click(); await sleep(200); await ready();

  console.log('errors:', errors.length ? errors : 'none');
  ok(errors.length === 0, 'no runtime errors');
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
