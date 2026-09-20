# NC Floor Sim (American Precision Works)

A browser-based CNC simulator so shop-floor operators can watch **what a program will do** on the Chromebooks
ProShop already runs on, without a Fusion 360 license. One hosted page, opened from a ProShop link, shows the
tool and holder cutting a real stock model.

Read `docs/NOTES.md` for evidence, file formats, and the decision log. This file is the short version.

## Owner and how to work with him

- **John** owns and runs APW, a precision CNC shop (Philadelphia). Hands-on programmer/machinist. Uses Fusion 360 CAM,
  a Brother SPEEDIO machining center, and ProShop ERP. Not a full-time software developer.
- **His goal is fewer clicks.** Anything that adds a step for an operator or programmer is a bad trade. He already has a
  workflow: post from an NC Program in the Fusion browser tree with a **cascading post**; the NC goes to the cloud, the CSV
  goes to the cloud and feeds a live setup-info page. The simulator should ride that same workflow.
- **"Stop building" / "don't do anything yet" means discuss only.** Do not write code until he says go.
- Be plain about what is **tested vs untested**. He is the only person who can run Fusion or a real Chromebook, so anything
  Fusion-side is untested until he runs it. Make first runs log clearly so he can paste the output back.
- Never state a Fusion API name, parameter, or behaviour as fact without checking Autodesk docs or a real sample. Say
  "unverified" when it is. Several early guesses were wrong (see "Hard-won facts").
- One question at a time. Short answers. No jargon he has to decode.
- **Privacy:** `fixtures/` holds real customer job data (part SOL1-902195 Outlet Fitting, program O1228). Keep the repo
  private. Never bundle fixture files into the deployed page.

## Requirements (from John)

- Real **stock removal** simulation, not just toolpath lines. Fidelity close to Fusion's own simulation.
- Stock model comes from Fusion data. Show the **tool and its holder**.
- Colours: **blue = material still to be removed, green = surface at its final size**. (Implemented relative to the
  program's own final result, not the design model. See NOTES.)
- **No collision detection** needed.
- Must run on the shop Chromebooks. One link per job in ProShop.
- Show which tool/operation cut a given spot (implemented: click the stock).

## Status

| Area | State |
|---|---|
| Parser (Brother dialect), stock removal engine, viewer, HUD, playback, probe | Built, tested headless. John viewed the published prototype and said it looks great. |
| Real job O1228 (19,126 moves, 16 ops, 7 tools) | Loads, simulates in ~0.9 s here, placement checks pass |
| `fusion/FloorSimExport.py` (per-setup stock + workholding export) | v1 ran in real Fusion (produced 4 files; exposed an origin-unit bug). v2 fix is tested on fake data and by re-placing v1 output, **not re-run in Fusion** |
| `fusion/FloorSimJobExport/` add-in (button + one job file) | Tested only against a fake Fusion. **Never run in Fusion. Parked**: John prefers the post-based route |
| Cascading post writes the job JSON | `CSV_Cascade_Post_v2_6_7.cps` writes `<base>.floorsim.json` (stock box + setup name only, no G-code or tool list — see NOTES). **Run for real against O1228**: stock box matched the value already verified via the Python export route to the mm. The proven `CSV_Cascade_Post_v2_6_6.cps` is untouched |
| Chromebook performance | **Unmeasured.** All timings are desktop Node |
| Real-browser rendering tests | **None automated.** Tests use jsdom with a stubbed renderer |

## Layout

```
src/engine.js            Pure JS, no DOM. Parser, tool model, HeightSim, CSV/.tools readers, demo programs
src/app.js               Viewer (three r128), stock mesh, playback, HUD, tool cards, file handling, probe
src/style.css            UI (condensed sans, yellow accent, light/dark tokens)
src/index.template.html  Shell with /*CSS*/ /*ENGINE*/ /*APP*/ placeholders
scripts/build.js         Inlines everything into dist/nc-floor-sim.html (single file)
tests/                   run-all.js runs everything. jsdom UI tests, engine tests, Python tests for Fusion code
fusion/                  FloorSimExport.py (script), FloorSimJobExport/ (add-in), posts/ (John's cascading CSV post)
fixtures/                REAL job files (private). setups_original/ = files from the buggy v1 export, kept on purpose
docs/NOTES.md            Formats, evidence, decisions, algorithms
```

## Commands

```
npm install
npm run build      # -> dist/nc-floor-sim.html
npm test           # all suites; needs Node 18+ and Python 3 for the Fusion-side tests
```

`npm test` must pass before you claim anything works. If you change the engine, also run
`node tests/real.test.js` to eyeball the O1228 result.

## Architecture in brief

- **One file, no build tooling.** Output is a single HTML with inlined CSS/JS; only external dependency is three.js **r128**
  from cdnjs (UMD). Do not use `OrbitControls` or `CapsuleGeometry` (not in r128). Orbit controls are hand-written.
- **Units:** everything internal is **mm**, Z up, tool position = tool **tip**. Programs in inches are converted on parse.
- **Stock model:** z-dexel **height field** on a grid (default ~360 cells on the long side). Each feed move removes the exact
  swept envelope of the tool. Exact for vertical-axis tools with a convex, non-decreasing profile: flat, ball, bull-nose,
  drill point, chamfer/cone.
- **Playback:** the whole program is simulated once up front (progress bar), storing snapshots and the final surface;
  colours compare the live surface with the final one. Scrubbing restores the nearest snapshot then re-cuts forward.
- **Per-frame budget:** playback advances within ~9 ms of simulation per frame and shows a "sim-limited" chip if the device
  cannot keep up. Only changed grid rows are re-uploaded to the GPU.
- **Inputs the page accepts:** NC text, setup-sheet CSV, Fusion `.tools` (zip) or tool-library JSON, setup JSON
  (`floorsim-setup`), and the one-file job JSON (`floorsim-job`). Details in NOTES.

## Known limits (do not "fix" silently, they are design boundaries)

- No undercut tools (T-slot, dovetail, lollipop, woodruff...): detected by name (`UNDERCUT_RE` in engine.js) and flagged
  in the warnings; stock removal is skipped for that tool (toolpath still plays) rather than simulated wrong. A real
  multi-interval-dexel fix is a deliberately deferred, separate project — see NOTES.md.
- No overhang stock, no full continuous 5-axis motion (bare A/B/C rotary moves with no G68.2 are still ignored). 3+2
  (tilted work plane via G68.2/G53.1/G69) **is simulated and rendered**, one real HeightSim per plane, verified visually
  against a real job (see NOTES.md) — but the probe (click-to-see-what-cut-this) only works on the base plane, and a
  program with no real stock box supplied can render with the base block's auto-guessed size hiding the tilted meshes
  inside it (known, left alone for now — see NOTES.md).
  "Stock from previous setup" cannot be chained across a flip (only the bounding box is used).
- Cutter compensation G41/G42 is **not** applied: John confirmed his contours are tool-centre paths using wear comp.
- Peck cycles (G73/G83) are simulated as one plunge. Rapids never cut. No holder/fixture collision.
- Cycle-time estimate is rough (8.2 min vs the setup sheet's 11.4 for O1228). The post uses FEED_RATIO 0.85 and a 10 s tool
  change; copy those if the estimate matters.

## Hard-won facts (each cost a wrong guess once)

- The Brother post writes **no G20/G21**: units are inches by machine default. The page guesses and offers a Units setting.
- Tool change is **`G100 T## X Y G43 Z H## D## S## M03`**, not `M6`. `M494`/`M495` look like through-spindle coolant on/off
  (inferred from where they appear).
- **Fusion API geometry is in cm, but `Setup.workCoordinateSystem` origin came back in mm.** Proven by four real setups; the
  export code tries both and keeps the reading that puts the part inside the stock.
- Setup parameters `stockXLow ... stockZHigh` are the stock box in **WCS coordinates, cm**. Verified against the O1228
  toolpath to 0.04 mm. Use them instead of guessing stock.
- Fusion tool JSON: `holder.segments[]` has `height`, `lower-diameter`, `upper-diameter`, listed **from the tool end
  upward**. `geometry.LB` is the out-of-holder length (matches OOH in the NC comments).
- Setup-sheet CSV columns are **mislabelled** (gauge length sits under "Length control Dim", H# under "Gage Length").
  The parser reads by position.
- Shop tool comment format: `(T57 - NAME - HLDR=... - OOH=1.2 - PRODID=... -LC-72)`. `(FTL-xxxx)` comments are tool-life tags,
  not operation names. Only stand-alone comment lines name operations.

## Working rules

1. Ask before large or structural changes. Keep diffs small.
2. Add or update a test with every behaviour change. Prefer real fixtures over invented data.
3. Do not add features John did not ask for. Do not add operator or programmer clicks.
4. Treat everything that runs inside Fusion as unverified. Wrap it in try/except, log each step, and tell John exactly what to
   paste back.
5. UI style: avoid generic "AI dashboard" looks. Condensed sans (Barlow Semi Condensed), yellow accent `#f2b705`, blue `#3d7bff`
   for remaining stock, green `#35c463` for finished surface, large touch targets, light and dark themes via CSS variables.
6. Keep the deliverable a single HTML file that also works from GitHub Pages and from a `file://` open.

## Roadmap (John's order of preference)

1. **Verify rendering on a real browser.** Add Playwright + Chromium screenshot tests; use CPU throttling to approximate a
   Chromebook. Then have John time the demo and the stress test on a real Chromebook.
2. **Cascading post writes `<base>.floorsim.json`** next to the NC and CSV, so it rides the existing cloud sync with zero new
   steps. Unknowns to test first (tiny throwaway snippets): can `TextFile` read the posted NC back (needed to embed it), and
   which tool/holder properties the post engine exposes (Autodesk's dump post lists them).
3. **Cloud loading by program number:** ProShop link like `.../index.html?program=O1228` fetches the job file itself, no file
   dialog. Needs CORS and access control on whatever cloud service holds the files.
4. **Workholding without the post:** a small library of APW's standard vises and soft jaws inside the page, chosen from the
   `fixtureInfo` property John's script already sets. Holder shapes can use the same idea, keyed by holder name.
5. Host on GitHub Pages (John already does this for the tool tag generator). Vendor three.js locally so the page does not
   depend on a CDN on the shop network.

## Open questions for John

- How do the NC and CSV reach the cloud today (synced folder, upload script, Fusion cloud posting)? Which service?
- Is a vise-less job view acceptable at first, or must workholding be there from day one?
