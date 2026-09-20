/**
  Output CSV for ProShop (cascading)
  Writes a CSV next to the NC using the same base name.
  Designed to be used with the NC Program option “Use cascading post”.

  $Revision: 44191 10f6400eaf1c75a27c852ee82b57479e7a9134c0 $
  $Date: 2025-08-21 13:23:15 $


  FORKID {1C86B7F4-7D65-47d7-A19B-CA96ADD758EB}
*/

/*
V4.5 - Add more output for new Sheets based setupsheet 2-26-26
v2.6 - adding Cycle time
v2.6.1 - added NOTE output for DIM to be output in Diameter control
v2.6.2 - added stock size to outoput
v2.6.3 - 8/7/26 DWY Add fixture property WIP
v2.6.4 - 9/4/26 DWY Fix double O in NC PRG header comment
v2.6.5 - 9/4/26 DWY RTA # blank, add Tool Comment column, auto-align CSV columns
v2.6.6 - 9/4/26 DWY Add 21 cutting-condition columns (feeds, speeds, preset, stepover/down, time, distance)
*/

description = "Output CSV for ProShop v2.6.6";
vendor = "APW";
vendorUrl = "http://www.autodesk.com";
legal = "Copyright (C) 2012-2025 by APW";
certificationLevel = 2;
minimumRevision = 45948;
capabilities = CAPABILITY_INTERMEDIATE | CAPABILITY_CASCADING;
extension = "csv";

longDescription = "Outputs a CSV (sidecar) alongside the posted NC when used as a Cascading Post." + EOL +
                  "It does not generate NC itself; select your normal NC post and also check 'Use cascading post'.";


// DWY 
properties = {
  fixtureInfo: {
    title      : "Fixture Info (script-set, do not edit)",
    description: "Set automatically by the fixture-reading script.",
    group      : "preferences",
    type       : "string",
    value      : "",
    scope      : "post"
  }
};



// Formats (decimals match typical posts; adjust if you want)
var valueFormat = createFormat({decimals:(unit == MM ? 3 : 4)});
// OOH: always two digits after the decimal (e.g. 0.12, 1.00, 10.22) //GPT
var oohFormat = createFormat({
  decimals: 2,
  trim: false,
  forceDecimal: true
}); //GPT

// Tip formats (CR or included angle) //DWY
var tipAngleFormat = createFormat({decimals: 0});                      // taperAngle*2, no decimals
var tipCornerRadFormat = createFormat({decimals: (unit == MM ? 2 : 3)}); // CR: 2mm / 3in

//
var seqStart = 10;
var seqIncrement = 5;
// Cache setup names per section in call order //GPT
var setupNameByIndex = []; //GPT

// v2.6.6 DWY - per-section cutting-condition cache.
// getParameter("operation:...") is ONLY valid while the section is active,
// so we harvest in onSection() and read it back in onClose(). //DWY
var opParamsByIndex = []; // index aligns with getSection(i) //DWY v2.6.6
var feedFormat = createFormat({decimals:1});   // feed rates, in/min or mm/min //DWY v2.6.6
var rpmFormat2 = createFormat({decimals:0});   // spindle rpm / sfm //DWY v2.6.6
var chipFormat = createFormat({decimals:(unit == MM ? 4 : 5)}); // feed per tooth //DWY v2.6.6

// Stock size capture ADDED DWY v 2.6.2
var stockLowerX = 0; var stockUpperX = 0;
var stockLowerY = 0; var stockUpperY = 0;
var stockLowerZ = 0; var stockUpperZ = 0;


// ===================== Helpers ======================
// CSV escape: NO quotes; keep raw text //GPT
function csvEscape(s) { //GPT
  var t = (s == null) ? "" : String(s); //GPT
  t = t.replace(/[\r\n]+/g, " ");       // keep rows one-line //GPT
  return t;                             //GPT
}


//Cycle time start DWY

// ===== Cycle time tuning (advanced) ===== //GPT
var FEED_RATIO = 0.85;        // feed override (actual machine %) //GPT
var TOOL_CHANGE_TIME = 10.0;   // seconds per tool change //GPT

// Estimated portion of time spent cutting vs rapid
// 0.7 = 70% cutting, 30% rapid (typical milling)
// turning often ~0.85+
// adjust per your shop
var CUT_RATIO = 0.90;         //GPT

// Compute adjusted total cycle time (seconds) with cut/rapid separation //GPT
function getTotalCycleTime() { //GPT
  var total = 0;
  var toolChanges = 0;

  var prevTool = null;
  var n = getNumberOfSections();

  for (var i = 0; i < n; ++i) {
    var section = getSection(i);
    var tool = section.getTool();

    // --- base cycle time from Fusion ---
    var t = 0;
    try {
      t = section.getCycleTime();
    } catch (e) {}

    if (t) {
      // --- split into cutting vs rapid ---
      var cutTime = t * CUT_RATIO;
      var rapidTime = t * (1 - CUT_RATIO);

      // --- apply feed scaling ONLY to cutting ---
      var adjusted = (cutTime / FEED_RATIO) + rapidTime;

      total += adjusted;
    }

    // --- tool change detection (same logic as your N numbers) ---
    var toolNo = parseInt(tool.number, 10);
    if (isNaN(toolNo)) {
      toolNo = String(tool.number);
    }

    var forcedTC = isForcedToolChange(section);

    if (prevTool === null) {
      toolChanges += 1;
    } else if (forcedTC || toolNo !== prevTool) {
      toolChanges += 1;
    }

    prevTool = toolNo;
  }

  // --- add tool change time ---
  total += toolChanges * TOOL_CHANGE_TIME;

  return total;
}

// Format seconds → H:MM:SS //GPT
function formatCycleTime(sec) { //GPT
  if (!sec || sec <= 0) { return ""; }

  var s = Math.floor(sec % 60);
  var m = Math.floor((sec / 60) % 60);
  var h = Math.floor(sec / 3600);

  return h + ":" +
    String(m).padStart(2, "0") + ":" +
    String(s).padStart(2, "0");
}
//Cycle time end


// Remove commas from a field (keep everything else as-is) //GPT
function noComma(s) { //GPT
  if (s == null) { return ""; } //GPT
  return String(s).replace(/,/g, ""); //GPT
}

// v2.6.5 DWY - Single source of truth for CSV columns. //DWY
// Add/remove/reorder a column HERE ONLY - the header row and every data row
// pad themselves to match. No more hand-counting ,,,,,,,,,, strings. //DWY
var CSV_COLUMNS = [ //DWY v2.6.5
  "Seq#",
  "Sequence Description",
  "Tool #",
  "G-Code Tool #",
  "OOH",
  "Holder",
  "RTA #",
  "Length control Dim",
  "Diameter control dim",
  "Cut Diameter",
  "Gage Length",
  "Tip (CR or Angle)",
  "T-description",
  "LC",
  "Tool Comment",                    // v2.6.5 DWY - new, was being jammed into RTA #
  // ---- v2.6.6 DWY - speeds & feeds ----
  "Preset",
  "RPM",
  "SFM",
  "Chip Load",
  "Feed Cutting",
  "Feed Entry",
  "Feed Exit",
  "Feed Ramp",
  "Feed Plunge",
  "Feed Retract",
  "Feed Transition",
  "Finish Feed",
  "Coolant",
  // ---- v2.6.6 DWY - cutting conditions ----
  "Toolpath Type",
  "Stepover",
  "Stepdown",
  "Finish Stepover",
  "Stock To Leave",
  "Axial Stock",
  "Cut Time",
  "Cut Distance"
];

// v2.6.5 DWY - Build one CSV line from an array of fields.
// Short arrays are padded with blanks out to CSV_COLUMNS.length. //DWY
function csvRow(fields) { //DWY v2.6.5
  var out = [];
  var i;
  for (i = 0; i < CSV_COLUMNS.length; ++i) {
    var v = (fields && i < fields.length && fields[i] != null) ? String(fields[i]) : "";
    out.push(v);
  }
  return out.join(",");
}

// Detect per-section Force Tool Change flag //GPT
function isForcedToolChange(section) {
  // Newer API form
  try {
    if (typeof section.getForceToolChange === "function" && section.getForceToolChange()) {
      return true;
    }
  } catch (e) {}

  // Parameter forms seen in Autodesk posts
  var v = section.getParameter("operation:forceToolChange", undefined);
  if (v === undefined) {
    v = section.getParameter("force-tool-change", 0);
  }
  return !!v;
}



// Build "fake" header row description with file name + timestamp //GPT
function getHeaderDescription() {
  var now = new Date();
  var timestamp =
    (now.getMonth() + 1) + "-" +
    now.getDate() + "-" +
    now.getFullYear() + " " +
    now.getHours().toString().padStart(2, "0") + ":" +
    now.getMinutes().toString().padStart(2, "0");

  // Try to get file name (Fusion provides document-path) //GPT
  var path = hasGlobalParameter("document-path")
    ? getGlobalParameter("document-path")
    : "";
  var fileName = "";
  if (path) {
    var parts = String(path).split(/[\\/]/);
    fileName = parts[parts.length - 1].replace(/\.[^/.]+$/, ""); // strip extension //GPT
  }
    var totalTime = formatCycleTime(getTotalCycleTime()); //GPT. ADDED Cycle time DWY

    var header = "NC PRG: O" + getProgramNumberForHeader() +
       " | FILE NAME: " + fileName + 
       "  |  POSTED: " + timestamp +
       " | Est. Cycle Time: " + totalTime; //dwy added

  // Append machine info if available: " | Machine: <vendor> <model>"
  try {
    var v = machineConfiguration.getVendor();
    var m = machineConfiguration.getModel();
    var machineText = "";

    if (v) { machineText += String(v); }
    if (m) { machineText += (machineText ? " " : "") + String(m); }

    if (machineText) {
      header += " | Machine: " + machineText;
    }
  } catch (e) {
    // machineConfiguration not available in this context
  }

  // Append stock size DWY
  var stockX = stockUpperX - stockLowerX;
  var stockY = stockUpperY - stockLowerY;
  var stockZ = stockUpperZ - stockLowerZ;
  header += " | STOCK: X = " + stockX.toFixed(3) + " in | Y = " + stockY.toFixed(3) + " in | Z = " + stockZ.toFixed(3) + " in";

  return header;
}

// Get NC program number for O-number header //GPT
// v2.6.4 DWY - programName already contains the leading "O" (e.g. "O1232"),
// and line ~207 prepends another "O", producing "OO1232". Strip any leading O/o. //DWY
function getProgramNumberForHeader() {
  return String(programName).replace(/^[Oo]/, ""); // v2.6.4 DWY
}

// G-Code tool number must be Txx (T01..T09, T10+). //GPT
function getGCodeToolNumber(tool) { //GPT
  var n = parseInt(tool.number, 10); //GPT
  if (isNaN(n)) {                    //GPT
    return "T" + String(tool.number);//GPT
  }                                  //GPT
  return (n < 10 ? "T0" + n : "T" + n); //GPT
}



// Operation description only: prefer operation comment, else strategy //GPT
function getOpDescription(section) { //GPT
  var opComment = section.getParameter("operation-comment", "");
  if (opComment && String(opComment).trim().length > 0) {
    return String(opComment);
  }
  if (typeof section.strategy !== "undefined" && section.strategy) {
    return String(section.strategy);
  }
  return "";
}



// Get setup name per-section; include safe fallbacks and touch tool.description (like main post) //GPT
function getSetupNameFor(section, tool) { //GPT
  var name = "";

  // 1) Prefer section-scoped parameter (best for multiple setups) //GPT
  try { name = section.getParameter("job-description", ""); } catch (e) {}

  // 2) Alternate key seen in some Fusion builds //GPT
  if (!name || name.length === 0) {
    try { name = section.getParameter("setup-name", ""); } catch (e) {}
  }

  // 3) Fallbacks that mirror your main post behavior — these resolve correctly
  //    when Fusion's internal context is set (we 'touch' tool.description below). //GPT
  if (!name || name.length === 0) {
    try { if (typeof hasParameter === "function" && hasParameter("job-description")) {
      name = getParameter("job-description", "");
    }} catch (e) {}
  }
  if (!name || name.length === 0) {
    try { if (typeof hasGlobalParameter === "function" && hasGlobalParameter("job-description")) {
      name = getGlobalParameter("job-description");
    }} catch (e) {}
  }

  // Quirk: touching tool.description helps Fusion resolve the correct setup context,
  // matching your main post's pattern. We DO NOT print the tool description. //GPT
  try { if (tool && tool.description) { var _noop = tool.description.length; } } catch (e) {}

  return name ? String(name) : "";
}

// Return "Setup Folder | Operation Comment" (or just comment if no setup name) //GPT
function getSequenceDescription(section) { //GPT
  // Operation comment first (preferred), else strategy //GPT
  var opComment = section.getParameter("operation-comment", "");
  var desc = "";
  if (opComment && String(opComment).trim().length > 0) {
    desc = String(opComment);
  } else if (typeof section.strategy !== "undefined" && section.strategy) {
    desc = String(section.strategy);
  }

  // Setup folder name resolved per-section (handles multiple setups in one post) //GPT
  var setupName = getSetupNameFor(section, section.getTool()); //GPT
  if (setupName && setupName.length > 0) {
    return setupName + " | " + desc;
  }
  return desc;
}


// Extract first contiguous digit sequence from a string (e.g., "RTA-20" -> "20") //GPT
function extractFirstDigits(s) { //GPT
  if (!s) { return ""; }        //GPT
  var m = String(s).match(/[0-9]+/); // first group of digits //GPT
  return m ? m[0] : "";         //GPT
}




// Returns "H<nn>" or "" if not numeric //GPT
function formatLengthOffsetH(tool) { //GPT
  var n = parseInt(tool.lengthOffset, 10);
  return isNaN(n) ? "" : ("H" + String(n));
}

// Returns "D<nn>" only when the operation uses in-control (G41/G42) comp; else "" //GPT
function formatDiameterOffsetD(section, tool) { //GPT
  // Most reliable: Fusion operation flag(s). Try common ones used across posts. //GPT
  var v = section.getParameter("operation:useCutterCompensation", undefined);
  if (v !== undefined && v) {
    var dn = parseInt(tool.diameterOffset, 10);
    return isNaN(dn) ? "" : ("D" + String(dn));
  }
  var t = section.getParameter("operation:compensationType", ""); // "in control", "wear", "in computer" //GPT
  if (t) {
    t = String(t).toLowerCase();
    if (t.indexOf("control") >= 0 || t.indexOf("wear") >= 0) {
      var dn2 = parseInt(tool.diameterOffset, 10);
      return isNaN(dn2) ? "" : ("D" + String(dn2));
    }
  }
  // Some posts expose explicit radiusComp flags (0 none, 1 left=G41, 2 right=G42) //GPT
  var rc = section.getParameter("operation:radiusCompensation", undefined);
  if (rc !== undefined) {
    var rci = parseInt(rc, 10);
    if (rci === 1 || rci === 2) {
      var dn3 = parseInt(tool.diameterOffset, 10);
      return isNaN(dn3) ? "" : ("D" + String(dn3));
    }
  }
  return ""; // no in-control compensation for this section //GPT
}

//dwy add 4/6/26
// Extract DIM note from operation-comment (only if starts with "DIM") //GPT
function getDimNote(section) { //GPT
  var note = section.getParameter("notes", "");
  if (!note) { return ""; }

  note = String(note).trim();

  // Only allow notes that START with "DIM"
  if (/^DIM/i.test(note)) {
    return note;
  }

  return "";
}

// DWY
// Capture stock extents from Fusion parameters
function onParameter(name, value) {
  switch (name) {
    case "stock-lower-x": stockLowerX = value; break;
    case "stock-lower-y": stockLowerY = value; break;
    case "stock-lower-z": stockLowerZ = value; break;
    case "stock-upper-x": stockUpperX = value; break;
    case "stock-upper-y": stockUpperY = value; break;
    case "stock-upper-z": stockUpperZ = value; break;
  }
}


// v2.6.6 DWY ============ Cutting-condition harvesting ============

// Safe read of an operation parameter. Returns defaultValue if absent. //DWY v2.6.6
function getOpParam(name, defaultValue) { //DWY v2.6.6
  try {
    if (typeof hasParameter === "function" && hasParameter(name)) {
      return getParameter(name, defaultValue);
    }
  } catch (e) {}
  return defaultValue;
}

// Format a number, but return BLANK for null/undefined/NaN/0. //DWY v2.6.6
// Blank is intentional: 0 means "not used" for feeds, stepdowns, etc.
function numOrBlank(v, fmt) { //DWY v2.6.6
  if (v == null) { return ""; }
  var x = Number(v);
  if (isNaN(x) || x <= 0) { return ""; }
  return fmt ? fmt.format(x) : String(x);
}

// Seconds -> M:SS   //DWY v2.6.6
function formatCutTime(seconds) { //DWY v2.6.6
  var s = Number(seconds);
  if (isNaN(s) || s <= 0) { return ""; }
  s = Math.round(s);
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ":" + (r < 10 ? "0" + r : String(r));
}

// v2.6.6 DWY - Harvest every cutting-condition value for the ACTIVE section.
// Must be called from onSection() while the parameter context is live. //DWY
function captureOpParams() { //DWY v2.6.6
  var p = {};

  p.preset      = getOpParam("operation:tool_feed_speed_presetName", "");
  p.strategy    = getOpParam("operation-strategy", "");
  p.coolant     = getOpParam("operation:tool_coolant", "");

  p.rpm         = getOpParam("operation:tool_spindleSpeed", 0);
  p.sfm         = getOpParam("operation:tool_surfaceSpeed", 0);
  p.chipLoad    = getOpParam("operation:tool_feedPerTooth", 0);

  p.feedCutting    = getOpParam("operation:tool_feedCutting", 0);
  p.feedEntry      = getOpParam("operation:tool_feedEntry", 0);
  p.feedExit       = getOpParam("operation:tool_feedExit", 0);
  p.feedRamp       = getOpParam("operation:tool_feedRamp", 0);
  p.feedPlunge     = getOpParam("operation:tool_feedPlunge", 0);
  p.feedRetract    = getOpParam("operation:tool_feedRetract", 0);
  p.feedTransition = getOpParam("operation:tool_feedTransition", 0);

  // Stepover: 2D strategies report maximumStepover, 3D report stepover. //DWY
  // tool_stepover is only the TOOL LIBRARY default and often disagrees - not used.
  var so = getOpParam("operation:maximumStepover", 0);
  if (!so) { so = getOpParam("operation:stepover", 0); }
  p.stepover = so;

  // Stepdown: 0 means multiple depths is turned off -> blank. //DWY
  p.stepdown = getOpParam("operation:maximumStepdown", 0);

  // Finish pass values are STALE unless doMultipleFinishingPasses == 1.
  // Confirmed in dump O1215: an op with finishing OFF still reported
  // finishFeedrate = 12. Gate on the flag or you print a feed that never runs. //DWY
  var doFinish = getOpParam("operation:doMultipleFinishingPasses", 0);
  if (doFinish) {
    p.finishFeed     = getOpParam("operation:finishFeedrate", 0);
    p.finishStepover = getOpParam("operation:finishingStepover", 0);
  } else {
    p.finishFeed = 0;
    p.finishStepover = 0;
  }

  p.stockToLeave  = getOpParam("operation:stockToLeave", 0);
  p.axialStock    = getOpParam("operation:verticalStockToLeave", 0);

  return p;
}

// ===================== Cascading behavior ======================
// Capture per-section setup name while context is correct, then skip motion //GPT
function onSection() { //GPT
  var sectionSetup = "";
  // First try the active-context parameter (works reliably inside onSection) //GPT
  try {
    if (typeof hasParameter === "function" && hasParameter("job-description")) {
      sectionSetup = getParameter("job-description", "");
    }
  } catch (e) {}
  // Fallback to per-section keys //GPT
  if (!sectionSetup || sectionSetup.length === 0) {
    try { sectionSetup = section.getParameter("job-description", ""); } catch (e) {}
  }
  if (!sectionSetup || sectionSetup.length === 0) {
    try { sectionSetup = section.getParameter("setup-name", ""); } catch (e) {}
  }
  setupNameByIndex.push(sectionSetup ? String(sectionSetup) : ""); // index aligns with getSection(i) //GPT

  // v2.6.6 DWY - harvest cutting conditions NOW; the context is gone by onClose()
  opParamsByIndex.push(captureOpParams()); //DWY v2.6.6

  // Don’t emit anything; just harvest info after we’ve seen the whole program
  skipRemainingSection();

  
}

// Write the CSV at the end using TextFile, same pattern as your CIMCO example
function onClose() {
  
  // Build path next to the NC: replace extension of the cascading path
  var csvPath = FileSystem.replaceExtension(getCascadingPath(), "csv");

  // Open a text file for writing (this API is used in your CIMCO cascading post)
  var csv = new TextFile(csvPath, true, "utf-8");

  // Header exactly as requested
  csv.writeln(CSV_COLUMNS.join(",")); // v2.6.5 DWY - header now built from CSV_COLUMNS
  
  // Write fake Seq# 0 header row (timestamp + file info) //GPT
csv.writeln(csvRow([ // v2.6.5 DWY - auto-padded, no hardcoded commas
  "0",
  csvEscape(getHeaderDescription())
]));
  // Write fixture information as Seq# 0.5 //GPT dwy
  var fixtureInfo = "";
  try {
    if (getProperty("fixtureInfo")) {
      fixtureInfo = "FIXTURE = " + getProperty("fixtureInfo");
    }
  } catch (e) {}

  if (fixtureInfo) {
    csv.writeln(csvRow([ // v2.6.5 DWY - auto-padded, no hardcoded commas
      "0.5",
      csvEscape(fixtureInfo)
    ]));
  }

  // Seq# emulation state //GPT
var nValue = seqStart;         // current base N //GPT
var prevToolNo = null;         // last tool number seen //GPT
var decimalCounter = 0;        // .1, .2, ... while same tool repeats //GPT

var n = getNumberOfSections();
for (var i = 0; i < n; ++i) {
  var section = getSection(i);
  var tool = section.getTool();

  // --- Seq# (N-number) logic with Force Tool Change --- //GPT
  var seqLabel; // string written into CSV //GPT
  var toolNo = parseInt(tool.number, 10);
  if (isNaN(toolNo)) {
    toolNo = String(tool.number);
  }
  var forcedTC = isForcedToolChange(section); //GPT

  if (prevToolNo === null) {
    // first section gets starting N //GPT
    seqLabel = String(nValue);
  } else if (forcedTC || toolNo !== prevToolNo) {
    // Force tool change OR different tool -> bump N, reset decimal //GPT
    nValue += seqIncrement;
    decimalCounter = 0;
    seqLabel = String(nValue);
  } else {
    // same tool without forced change -> .1, .2, ... //GPT
    decimalCounter += 1;
    seqLabel = String(nValue) + "." + String(decimalCounter);
  }
  prevToolNo = toolNo;



    // Build "Setup | Operation" using the name captured in onSection() //GPT
    var opDesc = getOpDescription(section); // no setup prefix //GPT
    var setupPrefix = (i < setupNameByIndex.length) ? setupNameByIndex[i] : "";
    var seqDesc = setupPrefix ? (setupPrefix + " | " + opDesc) : opDesc; //GPT

    // Tool # = product ID; fallback tool.number
    var camToolNum = (typeof tool.productId !== "undefined" && tool.productId != null && String(tool.productId).length > 0)
      ? String(tool.productId)
      : String(tool.number);

    // G-Code Tool # = Txx (T01..T09, T10+)
    var gcodeToolNum = getGCodeToolNumber(tool);

    // OOH = tool.bodyLength
    var ooh = (typeof tool.bodyLength !== "undefined" && tool.bodyLength != null)
      ? (typeof oohFormat !== "undefined" && oohFormat ? oohFormat.format(tool.bodyLength) : valueFormat.format(tool.bodyLength))
      : "";

    // Holder = holder description
    var holder = (typeof tool.holderDescription !== "undefined" && tool.holderDescription)
      ? String(tool.holderDescription)
      : "";

     // v2.6.5 DWY - RTA # is now intentionally BLANK.
     // It used to hold digits pulled out of tool.comment; the full comment
     // now goes to its own "Tool Comment" column at the end. //DWY
     var rta = ""; // v2.6.5 DWY

     // v2.6.5 DWY - full tool comment, last column
     var toolComment = (typeof tool.comment !== "undefined" && tool.comment)
       ? String(tool.comment)
       : ""; // v2.6.5 DWY
         

     // Length control Dim (H#) and Diameter control dim (D# only if comp used) //GPT
    var hDim = formatLengthOffsetH(tool); // e.g., H12 //GPT
    //var dDim = formatDiameterOffsetD(section, tool); // e.g., D12 or "" //GPT - OLD UPDATED
    var dVal = formatDiameterOffsetD(section, tool); // existing D logic //GPT
    var dimNote = getDimNote(section);               // extract DIM note //GPT

    var dDim = "";
    if (dVal && dimNote) {
        dDim = dVal + " = " + dimNote;
      } else if (dVal) {
        dDim = dVal;
      } else if (dimNote) {
        dDim = dimNote;
      }

    // Cut Diameter output
     var dia = (typeof tool.diameter !== "undefined" && tool.diameter)
       ? valueFormat.format(tool.diameter)
       : ""; //DWY  
    
    // Gage Length = bodyLength + (holderLength - 0.07874)
    // Only output if BOTH values exist AND are > 0. DWY with ChatGPT
    var gaugeLength = "";

    if (typeof tool.bodyLength !== "undefined" && tool.bodyLength != null &&
        typeof tool.holderLength !== "undefined" && tool.holderLength != null) {

      var bodyLen = Number(tool.bodyLength);
      var holderLen = Number(tool.holderLength);

      if (!isNaN(bodyLen) && !isNaN(holderLen) &&
          bodyLen > 0 && holderLen > 0) {

        var adjustedHolder = holderLen - 0.07874;
        var totalGauge = bodyLen + adjustedHolder;

        if (!isNaN(totalGauge) && totalGauge > 0) {
          gaugeLength = (Math.round(totalGauge * 100) / 100).toFixed(2); //GPT DWY 4/6/26
        }
      }
    }

    // Tip (CR or Angle): prefer tipAngle (drills), else taperAngle, else cornerRadius
    // Angles in Fusion posts are often in radians -> convert to degrees. Add "°".
    // - tipAngle in this post context is coming through doubled -> ALWAYS halve after converting to degrees
    // - taperAngle is a half-angle -> output included angle (x2)
    var tip = "";

    // Helper: convert to degrees if it looks like radians
    function toDegrees(a) {
      var x = Number(a);
      if (isNaN(x) || x <= 0) { return 0; }

      // If value is small (typical radians range), treat as radians; otherwise already degrees.
      if (x <= (2 * Math.PI + 1e-6)) {
        return x * 180 / Math.PI;
      }
      return x; // already degrees
    }

    var taper  = (typeof tool.taperAngle   !== "undefined" && tool.taperAngle   != null) ? Number(tool.taperAngle)   : 0;
    var tipAng = (typeof tool.tipAngle     !== "undefined" && tool.tipAngle     != null) ? Number(tool.tipAngle)     : 0;
    var cr     = (typeof tool.cornerRadius !== "undefined" && tool.cornerRadius != null) ? Number(tool.cornerRadius) : 0;

    // Treat 0 as blank.
    if (!isNaN(tipAng) && tipAng > 0) {
      // tipAngle sometimes comes through as 2x or 4x the real included angle.
      // Convert to degrees, then keep halving until it's <= 180°.
      var tipDeg = toDegrees(tipAng);

      while (!isNaN(tipDeg) && tipDeg > 180) {
        tipDeg = tipDeg / 2;
      }

      if (!isNaN(tipDeg) && tipDeg > 0) {
        tip = tipAngleFormat.format(tipDeg) + "°";
      }

    } else if (!isNaN(taper) && taper > 0) {
      // taperAngle in THIS post context is already the included angle (or comes through doubled sometimes)
      // Convert to degrees, then normalize by halving until it's <= 180°.
      var taperDeg = toDegrees(taper);

      while (!isNaN(taperDeg) && taperDeg > 180) {
        taperDeg = taperDeg / 2;
      }

    if (!isNaN(taperDeg) && taperDeg > 0) {
      tip = tipAngleFormat.format(taperDeg) + "°";
    }

    } else if (!isNaN(cr) && cr > 0) {
      tip = tipCornerRadFormat.format(cr);
    }
            
    // Tool description and vendor strings
    var tDesc = (typeof tool.description !== "undefined" && tool.description) ? String(tool.description) : "";
    var lcVendor = (typeof tool.vendor !== "undefined" && tool.vendor) ? String(tool.vendor) : "";

    // Assemble CSV row: NO quotes anywhere
    // v2.6.6 DWY - cached cutting conditions for this section (harvested in onSection)
    var op = opParamsByIndex[i] ? opParamsByIndex[i] : {}; //DWY v2.6.6

    // v2.6.6 DWY - these are SECTION methods, valid here in onClose, no caching needed
    var cutTime = 0;
    var cutDistance = 0;
    try { cutTime = section.getCycleTime(); } catch (e) {}
    try { cutDistance = section.getCuttingDistance(); } catch (e) {}

    // v2.6.6 DWY - built through csvRow() so column count self-manages
    var line = csvRow([
      csvEscape(seqLabel),
      csvEscape(noComma(seqDesc)),      //GPT strip commas
      csvEscape(camToolNum),
      csvEscape(gcodeToolNum),
      csvEscape(ooh),
      csvEscape(noComma(holder)),       //GPT strip commas
      csvEscape(noComma(rta)),          // RTA # - blank as of v2.6.5 DWY
      csvEscape(gaugeLength),           // Gage Length DWY // moved with Length
      csvEscape(dDim),                  // Diameter control dim //GPT
      csvEscape(dia),                   // Cut Diameter DWY
      csvEscape(hDim),                  // Length control Dim //GPT // DWY SWITCHed with gagelength to trick it
      csvEscape(tip),                   // Tip (CR or Angle) DWY
      csvEscape(tDesc),                 // Tool Description DWY
      csvEscape(lcVendor),              // LC Vendor DWY
      csvEscape(noComma(toolComment)),  // Tool Comment - v2.6.5 DWY
      // ---- v2.6.6 DWY - speeds & feeds (cached from onSection) ----
      csvEscape(noComma(op.preset)),
      numOrBlank(op.rpm, rpmFormat2),
      numOrBlank(op.sfm, rpmFormat2),
      numOrBlank(op.chipLoad, chipFormat),
      numOrBlank(op.feedCutting, feedFormat),
      numOrBlank(op.feedEntry, feedFormat),
      numOrBlank(op.feedExit, feedFormat),
      numOrBlank(op.feedRamp, feedFormat),
      numOrBlank(op.feedPlunge, feedFormat),
      numOrBlank(op.feedRetract, feedFormat),
      numOrBlank(op.feedTransition, feedFormat),
      numOrBlank(op.finishFeed, feedFormat),      // blank unless finishing passes ON
      csvEscape(noComma(op.coolant)),
      // ---- v2.6.6 DWY - cutting conditions ----
      csvEscape(noComma(op.strategy)),
      numOrBlank(op.stepover, valueFormat),
      numOrBlank(op.stepdown, valueFormat),       // blank when multiple depths OFF
      numOrBlank(op.finishStepover, valueFormat), // blank unless finishing passes ON
      numOrBlank(op.stockToLeave, valueFormat),
      numOrBlank(op.axialStock, valueFormat),
      formatCutTime(cutTime),
      numOrBlank(cutDistance, valueFormat)
    ]);

    csv.writeln(line);
  }
  csv.close();

  // Nice message in the NC console/log
  writeln(localize("Cascading CSV written: " + csvPath));


}

