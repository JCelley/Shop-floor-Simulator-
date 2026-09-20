/**
  THROWAWAY DIAGNOSTIC — not a real post. Answers two questions before FloorSim JSON
  export gets added to CSV_Cascade_Post_v2_6_6.cps:

    1. Can this cascading post read the posted NC file back with TextFile (needed to
       embed the G-code in the job JSON)?
    2. What tool/holder properties does the post engine actually expose (specifically:
       is there anything holder-shape-related beyond holderDescription/holderLength)?

  It does NOT write a CSV and does NOT touch CSV_Cascade_Post_v2_6_6.cps or its output.
  It writes one plain-text log file next to the NC, named "<base>.floorsimtest.txt".

  HOW TO RUN IT:
    1. On the NC Program, temporarily change "Use cascading post" to point at THIS file
       instead of CSV_Cascade_Post_v2_6_6.cps. Leave the main post unchanged.
    2. Post (or re-post) any program.
    3. Open "<base>.floorsimtest.txt" next to the NC and paste its full contents back.
    4. Switch "Use cascading post" back to CSV_Cascade_Post_v2_6_6.cps afterward — only
       one cascading post runs at a time, so the CSV will NOT be produced during this
       one test run. That's expected.

  Delete this file once the two questions above are answered.
*/

description = "FloorSim unknowns test (throwaway, not for real jobs)";
vendor = "APW";
vendorUrl = "http://www.autodesk.com";
legal = "Copyright (C) 2012-2026 by APW";
certificationLevel = 2;
minimumRevision = 45948;
capabilities = CAPABILITY_INTERMEDIATE | CAPABILITY_CASCADING;
extension = "txt";

longDescription = "Diagnostic only. Writes a text log next to the NC answering two questions " +
                   "about what this post engine can do. Does not write a CSV.";

var lines = []; // collected log text, written all at once in onClose()
function log(s) { lines.push(String(s)); }

// Don't try to emit any motion; we only want tool/section objects to inspect. //
function onSection() {
  skipRemainingSection();
}

// Dump an object's own enumerable properties (one level deep) without assuming
// JSON is available in this engine. //
function dumpObject(obj, indent) {
  indent = indent || "  ";
  if (obj == null) { log(indent + "(null)"); return; }
  var k;
  for (k in obj) {
    var v;
    try { v = obj[k]; } catch (e) { log(indent + k + ": <error reading: " + e + ">"); continue; }
    if (typeof v === "function") {
      log(indent + k + ": [function]");
    } else if (v != null && typeof v === "object") {
      if (typeof v.length === "number") {
        log(indent + k + ": [array/collection], length=" + v.length);
        if (v.length > 0) {
          try { log(indent + "  [0]: " + describeScalar(v[0])); } catch (e) {}
        }
      } else {
        log(indent + k + ": {object} ->");
        var k2;
        for (k2 in v) {
          var v2;
          try { v2 = v[k2]; } catch (e) { log(indent + "    " + k2 + ": <error: " + e + ">"); continue; }
          log(indent + "    " + k2 + ": " + describeScalar(v2));
        }
      }
    } else {
      log(indent + k + ": " + describeScalar(v));
    }
  }
}

function describeScalar(v) {
  if (v === undefined) { return "undefined"; }
  if (v === null) { return "null"; }
  var t = typeof v;
  if (t === "function") { return "[function]"; }
  var s;
  try { s = String(v); } catch (e) { return "<unstringifiable " + t + ">"; }
  if (s.length > 120) { s = s.slice(0, 120) + "...(truncated)"; }
  return t + " = " + s;
}

function onClose() {
  log("=== FloorSim unknowns test ===");
  log("Posted: " + (new Date()).toString());
  log("");

  // ---------------------------------------------------------------
  // Question 1: can we read the posted NC back with TextFile?
  // ---------------------------------------------------------------
  log("---- Q1: reading the posted NC back ----");
  var ncPath = "";
  try {
    ncPath = getCascadingPath();
    log("getCascadingPath() = " + ncPath);
  } catch (e) {
    log("getCascadingPath() FAILED: " + e);
  }

  if (ncPath) {
    // Attempt A: TextFile(path, false, "utf-8") with readln() loop
    try {
      var fA = new TextFile(ncPath, false, "utf-8");
      var lineCount = 0, firstLines = [], lastLines = [], totalChars = 0;
      var ln;
      while ((ln = fA.readln()) !== undefined) {
        lineCount++;
        totalChars += ln.length;
        if (firstLines.length < 3) { firstLines.push(ln); }
        lastLines.push(ln);
        if (lastLines.length > 3) { lastLines.shift(); }
      }
      fA.close();
      log("Attempt A: new TextFile(path,false,'utf-8') + readln() loop: SUCCESS");
      log("  lines=" + lineCount + " totalChars=" + totalChars);
      log("  first lines: " + JSON_or_join(firstLines));
      log("  last lines:  " + JSON_or_join(lastLines));
    } catch (eA) {
      log("Attempt A FAILED: " + eA);

      // Attempt B: no encoding arg
      try {
        var fB = new TextFile(ncPath, false);
        var lineCountB = 0;
        var lnB;
        while ((lnB = fB.readln()) !== undefined) { lineCountB++; }
        fB.close();
        log("Attempt B: new TextFile(path,false) + readln(): SUCCESS, lines=" + lineCountB);
      } catch (eB) {
        log("Attempt B FAILED: " + eB);
      }
    }
  } else {
    log("Skipped read attempts: no path from getCascadingPath().");
  }
  log("");

  // ---------------------------------------------------------------
  // Question 2: what does the post engine expose on tool / holder?
  // ---------------------------------------------------------------
  log("---- Q2: tool/holder properties (first section's tool, one level deep) ----");
  try {
    var n = getNumberOfSections();
    log("getNumberOfSections() = " + n);
    if (n > 0) {
      var section0 = getSection(0);
      var tool0 = section0.getTool();
      log("Dumping section(0).getTool():");
      dumpObject(tool0, "  ");

      log("");
      log("Explicit checks:");
      log("  typeof tool.holder = " + typeof tool0.holder);
      log("  typeof tool.toJson = " + typeof tool0.toJson);
      log("  typeof tool.toJSON = " + typeof tool0.toJSON);

      if (typeof tool0.toJson === "function") {
        try {
          var tj = tool0.toJson();
          log("  tool.toJson() result:");
          dumpObject(tj, "    ");
        } catch (eTJ) {
          log("  tool.toJson() FAILED: " + eTJ);
        }
      }
      if (tool0.holder != null) {
        log("  tool.holder contents:");
        dumpObject(tool0.holder, "    ");
      }
    }
  } catch (eQ2) {
    log("Q2 dump FAILED: " + eQ2);
  }

  log("");
  log("=== end ===");

  // Write the log next to the NC.
  try {
    var logPath = FileSystem.replaceExtension(getCascadingPath(), "floorsimtest.txt");
    var out = new TextFile(logPath, true, "utf-8");
    for (var i = 0; i < lines.length; ++i) { out.writeln(lines[i]); }
    out.close();
    writeln(localize("FloorSim unknowns test log written: " + logPath));
  } catch (eW) {
    writeln(localize("FloorSim unknowns test FAILED to write log: " + eW));
  }
}

// Join an array of strings for a single log line; avoid depending on JSON.stringify
// existing in this engine (unverified), but use it if present since it's tidier.
function JSON_or_join(arr) {
  try {
    if (typeof JSON !== "undefined" && JSON && typeof JSON.stringify === "function") {
      return JSON.stringify(arr);
    }
  } catch (e) {}
  return "[" + arr.join(" | ") + "]";
}
