# NC Floor Sim: notes, formats, evidence, decisions

Companion to `CLAUDE.md`. Everything here was learned building the prototype against one real job (program O1228, OP50,
part SOL1-902195 Outlet Fitting). "Verified" means checked against a real file or a running system. "Unverified" means read from
docs or inferred.

## 1. Decisions and why

| Decision | Why | Cost |
|---|---|---|
| Post-processed **G-code** is the source of truth, not CIMCO's `.CimcoSimData` | The CIMCO file is proprietary, compressed, undocumented, and CIMCO Verify is Windows-only. G-code is what the machine runs | Need our own parser |
| **Height field** (z-dexel, one interval per column), not multi-interval dexels or voxels | Exact for vertical-axis tools, cheap enough for Chromebooks, smooth mesh with cheap normals | No undercuts or overhangs (see limits) |
| **Exact swept-tool cutting** per cell, not stamping tool positions | ~40x fewer operations and no scalloping. Stamping was the likely reason an earlier height-map attempt looked wrong | Convexity assumption on the tool profile |
| **Pre-pass the whole program**, keep snapshots + final surface | Needed to colour "still to remove" vs "final"; also gives instant scrubbing | Up-front wait (about a second here) |
| Colour relative to **the program's own final surface** | No design model needed. Matches John's blue/green rule | Cannot show under-cutting vs design. A part STL could be added later |
| **Single HTML file**, three.js r128 from cdnjs | Easy to host and to open from a link | Depends on the CDN unless vendored |
| **Wear compensation assumed** (path = tool centre) | John confirmed. The lead-in arc (R 0.056 in) is smaller than the tool radius (0.1875 in), which would alarm under full comp | Full in-control comp is not implemented |
| **Cascading post preferred over the add-in** | John's workflow already syncs NC and CSV to the cloud from a cascading post; a third file rides along with no extra click | Post cannot see fixture geometry |
| Add-in (`FloorSimJobExport`) kept but **parked** | It works on paper but adds a button and a habit change | Untested in real Fusion |

## 2. Simulation engine (`src/engine.js`)

### Stock model
`HeightSim(box, target)`: grid over the stock box (`nx, ny` chosen so the long side has about `target` cells), `h[]` = current
top height per cell (Float32), `op[]` = last operation that cut the cell (Uint16, 0 = untouched, else opIndex+1). Dirty rectangle
tracking (`di0..dj1`) drives partial GPU uploads.

### Cutting a segment
For a move A to B and a cell centre C, with tool radius R and profile `prof(d)` (height of tool surface above the tip at
horizontal distance d):

- `d(t)` is the distance from C to the tool axis at parameter t. Solve `d(t) <= R` (a quadratic) to get the covered t-range.
- New height = `min over t of z(t) + prof(d(t))`.
- Flat tool: closed form (endpoints). Planar move: closed form at the closest approach. Short ramp: 4 samples. Long ramp:
  ternary search (valid because z(t) is linear and `prof(d(t))` is convex).
- Early-outs: cell already below the segment's lowest tip; lower bound above current height.
- Partial moves (`cutMove(..., f0, f1)`) cut a fraction of a segment; playback uses this every frame.

Tool kinds: 0 flat, 1 ball, 2 bull-nose, 3 cone (drill point and chamfer; `slope = 1/tan(halfAngle)`, `r0` = flat tip radius).
Drill tip angle is the **included** angle (118, 140). Fusion's chamfer `TA` is the **half** angle (45 means a 90-degree tool).

### Parser (`parseProgram(text, {units})`)
Handles G0/G1/G2/G3 in **G17/G18/G19**, G20/G21, G90/G91, G98/G99, canned cycles G73/G81-G89 (one plunge), G28/G30/G53/G92/G4/G10
skipped, **G100 tool change**, M3/M4/M5, M7/M8/M9, M88/M89, M494/M495, R-word arcs, helical arcs, block delete. Arcs are tessellated
to 0.004 mm chord error. Output is struct-of-arrays: `X,Y,Z` end points, `K` (0 rapid, 1 feed), `F,S,TL,CO,OP,LN`, plus `ops`, `tools`,
`cumT` (cumulative seconds; rapids at 24000 mm/min), `bounds` (of feed moves), `notes`, `warnings`.

Unit rule: `opts.units` if given, else the first G20/G21, else a heuristic (`guessInch`: max |XY| under 40 and median feed under 250 means
inches). A note is shown when the heuristic is used.

Operation naming: only **stand-alone comment lines** become labels; the last one before the first move wins; `(FTL-...)` is ignored;
a tool change forces a new operation.

### Tool sizes, in priority order
1. Fusion tool library (`applyLibrary`): `.tools` zip or JSON, matched by `post-process.number`.
2. Setup-sheet CSV (`applyCsvTools`): cut diameter, OOH, holder name, tip (angle with a degree sign, or corner radius).
3. Tool name in the NC comment (`guessFromName`): `3/8`, `.1575 4MM DRILL 140 DEG`, `BULL .025R`.

`completeTool` fills defaults: flute = max(2.5 D, 8), stick = flute + 10, holder 32 mm x 55 mm.

## 3. Page (`src/app.js`)

- `S` is the single state object. `loadText()` parses and applies inputs; `rebuild()` creates the sim, runs `prepass()` (yielding to the UI
  every ~30 ms), builds meshes. `advance(target, budgetMs)` moves playback; `goTo(tau)` restores a snapshot then advances.
- Stock mesh: vertices at cell **corners** (heights averaged from the 4 neighbouring cells), normals from height gradients, vertex
  colours: progress mode blends green to blue over 0.06 mm of remaining stock; tool mode uses a per-tool palette. Side skirt and underside
  are separate small meshes. Only changed rows are re-uploaded (`updateRange`, r128).
- Tool: `LatheGeometry` of the cutter profile + shank + holder segments, rotated so Z is the axis.
- Probe: click the stock, ray-march the height field, report `op` (live) or `finalOp` ("will be machined by").
- `checkSetup()` cross-checks a setup or job file against the program: fraction of cutting moves inside the stock box, how deep any workholding
  sinks into the stock (over 5 mm is flagged; pins a few mm deep are normal), how far the nearest workholding is from the stock (over 5 mm
  flagged), and the export script's own self-test result.

## 4. File formats

### Job file `*.floorsim.json` (`format: "floorsim-job"`, version 1). Written by the add-in; a cascading post should write the same shape
```
{ format, version, units:"mm",
  program:"O1228", ncFile:"O1228.NC",
  gcode:"<the exact posted NC text>",
  ops:[{label, tool}],                       // Fusion operation names in posting order, tool = tool number
  toolLibrary:{data:[<Fusion tool JSON>], version:1},   // only tools this program uses
  setup:"OP50", stockMode:6,
  stock:{xmin,xmax,ymin,ymax,zmin,zmax},     // mm, in the WCS the program uses
  fixtures:[{name, positions:[x,y,z,...], indices:[...]}],   // mm, WCS, triangle mesh
  check:{status:"ok|mismatch|unknown", partBox:[...]},
  wcs:{origin_raw:[..], originUnit:"mm|cm", x:[..], y:[..], z:[..]},
  exported:"2026-09-19T14:02:00", document, ncProgram, ncFileModified }
```
The page uses `ops` only when its length and tool sequence match the NC's operations; otherwise it says the file may be out of date.
Legacy: `floorsim-setup` (same without gcode/tools/ops), an older bundle with a `gcode` field, and loose files (NC + CSV + `.tools`).

### Fusion `.tools` / tool library JSON (verified on a real export)
Zip containing `tools.json`. `data[]` entries: `type` ("flat end mill", "bull nose end mill", "drill", "chamfer mill", "probe"...), `unit`
("inches"/"millimeters"), `description`, `post-process.number`, `geometry` with `DC` (diameter), `RE` (corner radius), `LB` (length below
holder = OOH), `LCF` (flute length), `OAL`, `SIG` (drill point angle), `TA` (taper half-angle), `tip-diameter`, `assemblyGaugeLength`.
`holder.segments[]`: `height`, `lower-diameter`, `upper-diameter`, listed from the tool end upward; `holder.gaugeLength`; `holder.unit`.
`assemblyGaugeLength` = holder gauge length + `LB`.

### Setup-sheet CSV (from the cascading post; verified)
Header `Seq#,Sequence Description,Tool #,G-Code Tool #,OOH,Holder,RTA #,Length control Dim,Diameter control dim,Cut Diameter,Gage Length,Tip (CR or Angle),T-description,LC,...`
**Columns are mislabelled** in practice: col 7 holds the gauge length, col 8 the D offset, col 10 the H offset. Row `0` carries
`STOCK: X = 1.250 in | Y = 1.250 in | Z = 1.130 in` (size only, no position) and `Est. Cycle Time: 0:11:24`. Operation rows are
`OP50 | <name>`; tool in `G-Code Tool #` as `T57`. Tip: `140°` (drill, included), `45°` (chamfer, half-angle), `0.025` (corner radius).

### The Brother NC dialect seen in O1228.NC
Inches, no G20/G21. `G100 T57 X.. Y.. G43 Z.. H57 D57 S3056 M03` changes tool and positions in one block. `G00 A0. C0.` only (no rotary motion).
`G41`/`G42` with `D`. Vertical lead-in arcs use `G19`/`G18` then `G17`. Cycles `G81/G83/G86`. Comments: `(OP50 - NAME)`, then the operation
name, `(FTL-EC1F8B)`, tool list `(T57 - 3/8 7FL ROUGHING EM - HLDR=NBT30-SK13C-90 85MM - OOH=1.2 - PRODID=A-61 -LC-72)`.

## 5. Fusion facts and evidence

| Fact | Status |
|---|---|
| API lengths are centimetres | Verified (mesh coordinates) |
| `Setup.workCoordinateSystem.getAsCoordinateSystem()` origin is **millimetres** | **Verified on 4 real setups.** Under the cm reading all four failed the part-in-stock test; under mm all pass, fixtures come out symmetric with round numbers, and the Op49 part equals its stock exactly |
| Setup params `stockXLow/XHigh/YLow/YHigh/ZLow/ZHigh` are the stock box in WCS, cm | Verified vs the O1228 toolpath (0.04 mm in XY) |
| `stockMode` seen: 6 (OP50, Op49, Probe test), 7 (Op 60) | Inferred as "from solid" and "from previous setup". Docs list Fixed box, Relative box, Solid, Previous setup; numeric values not confirmed. The page treats 0 and 1 as boxes and anything else as "bounding box only" |
| `Setup.fixtures` lists fixture models; `Setup.models` lists part models | From docs samples; worked in the real run |
| `BRepBody.meshManager.createMeshCalculator()` gives `nodeCoordinatesAsDouble` and `nodeIndices` | Worked in the real run |
| STL export of an occurrence ignores its placement | From a forum answer, not tested (we avoid STL export) |
| `NCProgram` parameters `nc_program_output_folder`, `nc_program_filename`, `nc_program_nc_extension`, `nc_program_openInEditor`; `filteredOperations`; `postProcess(options)` | From docs samples. **Not verified in real Fusion** |
| `Operation.tool.toJson()` returns the tool with `holder.segments`; `CAM.documentToolLibrary.toJson()` returns all document tools | From docs and forum samples. **Not verified in real Fusion** |
| `tool.parameters.itemByName('holder_segments')` returns nothing | Reported on a forum. Use `toJson()` instead |
| Add-in toolbar: workspace id `CAMEnvironment`, `toolbarPanels.add(id, name)` | From docs. Not run |

### Exported setup files from John's real run (`fixtures/setups_original/` are the buggy v1 output)
OP50 (solid stock, stock X -26.988..4.762, Y +-15.875, Z 90.092..118.794 mm), Op49 Soft Jaw build (solid, stock 127 x 106 x 37.6 mm, part = stock),
Op 60 (previous-setup stock, flipped WCS: x axis (-1,0,0), z axis (0,0,-1)), Probe test. `fixtures/setups/` holds the same files re-placed with the
mm-origin fix. In OP50 the workholding is 45 bodies (about 34k triangles, about 1.1 MB); the soft-jaw top sits exactly at the stock bottom; pins
under the jaws enter the stock box by about 2.7 mm (real CAD overlap, not an error).

## 6. The cascading post (`fusion/posts/CSV_Cascade_Post_v2_6_6.cps`)

Facts from reading it: `capabilities = CAPABILITY_INTERMEDIATE | CAPABILITY_CASCADING`; the NC path comes from `getCascadingPath()`; the CSV is
written with `new TextFile(FileSystem.replaceExtension(getCascadingPath(), "csv"), true, "utf-8")` in `onClose()`; it does `skipRemainingSection()`
in `onSection()` and harvests parameters there because section parameters are only valid while a section is active. It already captures the stock
box via `onParameter("stock-lower-x" ... "stock-upper-z")`, per-section tool properties (`number`, `productId`, `diameter`, `bodyLength`, `holderDescription`,
`holderLength`, `taperAngle`, `tipAngle`, `cornerRadius`, `comment`), `operation-comment`, `job-description`, cycle time, and a script-set property
`fixtureInfo` (text). CSV stock is printed as inches by string, so values are in the post's unit (`unit == MM` decides).

What is **unknown** and worth a throwaway test before designing further:
1. Can `TextFile` open the posted NC for reading (`new TextFile(path, false, ...)`), and is the NC complete when the cascade runs? Needed to embed the program.
2. Which tool and holder properties does the post engine expose beyond the ones above (holder segments?). Autodesk's `dump.cps` prints every parameter.
3. Fixture geometry almost certainly is not exposed (workholding is CAD bodies).

## 7. Performance (desktop Node, not a Chromebook)

| Case | Moves | Grid | Time |
|---|---|---|---|
| Demo program | 702 | 360x252 | about 60-80 ms |
| Stress test (ball nose, 3D surface) | 38,011 | 240 / 360 / 520 square | 0.2 / 0.43 / 0.88 s |
| O1228 | 19,126 | 360x360 (0.088 mm cells) | about 0.9 s |

Playback keeps to roughly 9 ms of simulation per frame. Chromebook numbers are the top open item.

## 8. Testing

`npm test` runs, in order: build, engine tests (parser + cutting + timing), Python tests of the Fusion export math, the add-in against a fake Fusion driven
by the real job data, the page in jsdom with a **stubbed WebGL renderer** (load, play, scrub, probe, tool edits, setup files, warnings), the real OP50 files,
and the job file loaded into the page. jsdom cannot render pixels, so **appearance is untested by machine**. Also note jsdom lacks `DecompressionStream`,
so the in-page `.tools` unzip is covered by an engine (Node) test only.

## 9. Ideas sketched but not built

- **Cloud loading by program number:** `?program=O1228` fetches `<base>/O1228.floorsim.json`. Needs CORS and access control; keep the file dialog as a fallback.
- **Workholding library:** vises and soft jaws stored once in the page, keyed by the post's `fixtureInfo` text, placed by a stored offset from the WCS.
- **Holder library:** profiles keyed by `holderDescription`, filled once from the tool library, so the post only needs to emit the name.
- **Chain setups:** simulate OP50, then use its result as the stock for the next setup (only feasible without a flip, or with a full solid model).
- **Cycle time:** reuse the post's FEED_RATIO and tool-change constants.
- **Part STL** for true deviation colouring (needs the WCS transform, which the export code already solves).
