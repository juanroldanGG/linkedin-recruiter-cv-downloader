// End-to-end smoke test. Run before packaging:  node smoke.js
//
// Loads the real background.js with Chrome and Drive stubbed out, then drives
// three consecutive runs. Exists because two bugs reached the user on the
// Indeed extension that reading the code could not catch: a missing manifest
// permission, and a helper used one line before it was declared. Both were
// valid JavaScript. Only running it fails.
//
// The page-world scraper is stubbed rather than executed — there is no DOM
// here. What this proves is the part around it: which jobs get opened, who gets
// clicked, when a strike becomes a retirement, and what reaches Drive.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

// Real timers would make this take a minute of pure waiting.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => realSetTimeout(fn, ms > 1 ? 1 : ms);

// --- the world the service worker thinks it lives in ------------------------
const state = {
  clickHandler: null,
  driveFiles: {},        // name -> string contents
  idToName: {},          // drive id -> name
  pdfUploads: 0,
  navigated: [],
  alerts: [],
  logs: [],
  downloads: [],
  skipKeysSeen: [],      // what scrapeResumes was told to skip, per call
  vouchedSeen: [],       // whether the job was vouched clean, per call
  attachments: {},       // profile id -> PDF url on their Attachments page
  windowState: "normal",
  awake: null,
  tabListener: null,
  tabUrl: "https://www.linkedin.com/talent/jobs"
};

const QUIET = { jobId: "1789374132", title: "Customer Success Manager", applicants: 129 };
const BUSY  = { jobId: "1793245236", title: "Netsuite Administrator", applicants: 25 };

const jobRow = j => ({
  title: j.title,
  href: `https://www.linkedin.com/talent/hire/${j.jobId}/discover/applicants`,
  jobId: j.jobId,
  applicants: j.applicants,
  poster: j.poster,
  posted: j.posted
});

const KEY = id => `${BUSY.jobId}:${id}`;

// What the page returns. Run 1 and 2 miss the same person; run 3 is clean.
let scrapeResult = null;

const chrome = {
  action: { onClicked: { addListener: h => { state.clickHandler = h; } } },
  contextMenus: { create: () => {}, onClicked: { addListener: h => { state.contextMenuHandler = h; } } },
  power: {
    requestKeepAwake: level => { state.awake = level; },
    releaseKeepAwake: () => { state.awake = null; }
  },
  windows: {
    get: async () => ({ state: state.windowState }),
    update: async (id, props) => { state.windowState = props.state || state.windowState; }
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    getPlatformInfo: cb => cb({}),
    getManifest: () => require("./manifest.json")
  },
  storage: {
    local: {
      get: async () => ({ doneKeys: [], laptopKeys: state.laptopKeys || [] }),
      set: async o => { if (o.laptopKeys) state.laptopKeys = o.laptopKeys; }
    }
  },
  identity: {
    getAuthToken: (opts, cb) => cb("fake-token"),
    removeCachedAuthToken: (o, cb) => cb()
  },
  downloads: { download: o => state.downloads.push(o.filename) },
  tabs: {
    update: (id, { url, active }) => {
      if (active) state.activated = (state.activated || 0) + 1;
      if (!url) return Promise.resolve();
      state.navigated.push(url);
      state.tabUrl = url;
      setTimeout(() => state.tabListener && state.tabListener(id, { status: "complete" }), 0);
    },
    onUpdated: {
      addListener: h => { state.tabListener = h; },
      removeListener: () => { state.tabListener = null; }
    },
    get: async () => ({ url: state.tabUrl })
  },
  scripting: {
    executeScript: async ({ func, args = [] }) => {
      if (func.name === "scrapeJobList") return [{ result: [jobRow(QUIET), jobRow(BUSY)] }];
      if (func.name === "getPageTitle") return [{ result: BUSY.title }];
      if (func.name === "findAttachmentPdf") {
        const id = (state.tabUrl.match(/\/profile\/([^/?]+)\/attachments/) || [])[1];
        return [{ result: state.attachments[id] || null }];
      }
      if (func.name === "scrapeResumes") {
        state.skipKeysSeen.push(args[0] || []);
        state.vouchedSeen.push(args[2]);
        state.applicantsHintSeen = args[3];
        (state.firstIdsSeen = state.firstIdsSeen || []).push(args[4]);
        // A queue lets one job hand back several pages, as a stuck Next does.
        const next = state.scrapeQueue && state.scrapeQueue.length
          ? state.scrapeQueue.shift() : scrapeResult;
        return [{ result: next }];
      }
      func(...args);                       // the inline alert(...) arrows
      return [{ result: null }];
    }
  }
};

global.alert = msg => state.alerts.push(String(msg));

// Per-job detail moved out of the popup and into the console, so the tests that
// check it have to watch the console too.
const realLog = console.log;
console.log = (...args) => {
  state.logs.push(args.map(String).join(" "));
  realLog(...args);
};

// --- Drive, faked -----------------------------------------------------------
const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => "" });

// Pull the payload out of a multipart/related body: everything after the last
// header block, minus the closing boundary line.
function multipartPayload(body) {
  const parts = String(body).split("\r\n\r\n");
  return parts[parts.length - 1].replace(/\r\n--[^\r\n]*--\r\n?$/, "");
}

global.fetch = async (url, opts = {}) => {
  // The signed resume PDF.
  if (url.startsWith("https://media.example/")) {
    return { ok: true, status: 200, blob: async () => new Blob(["%PDF-1.4 fake"]) };
  }

  if (url.includes("/upload/drive/v3/files")) {
    if (typeof opts.body !== "string") { state.pdfUploads++; return ok({ id: "pdf" }); }
    const idMatch = url.match(/\/files\/([^?]+)/);
    if (idMatch) {                                   // PATCH, overwriting
      state.driveFiles[state.idToName[idMatch[1]]] = opts.body;
      return ok({ id: idMatch[1] });
    }
    const name = (String(opts.body).match(/"name":"([^"]+)"/) || [])[1]; // POST, creating
    const id = "id-" + name;
    state.idToName[id] = name;
    state.driveFiles[name] = multipartPayload(opts.body);
    return ok({ id });
  }

  if (url.includes("alt=media")) {
    const id = (url.match(/\/files\/([^?]+)/) || [])[1];
    const raw = state.driveFiles[state.idToName[id]] || "";
    // Parsed only when asked: the run log is plain text and would throw here.
    return { ok: true, status: 200, json: async () => JSON.parse(raw || "{}"), text: async () => raw };
  }

  if (url.includes("/drive/v3/files?q=")) {
    const q = decodeURIComponent(url);
    if (q.includes("mimeType='application/vnd.google-apps.folder'") && !q.includes("name='")) {
      return ok({ files: [{ id: "role-csm", name: "Customer Success Manager" },
                          { id: "role-nsa", name: "Netsuite Admin" }] });
    }
    const name = (q.match(/name='([^']+)'/) || [])[1];
    if (name === SOURCE_SUB) return ok({ files: [{ id: "sub-linkedin" }] });
    if (name && state.driveFiles[name] !== undefined) {
      const id = "id-" + name;
      state.idToName[id] = name;
      return ok({ files: [{ id }] });
    }
    return ok({ files: [] });
  }
  return ok({});
};
const SOURCE_SUB = "LinkedIn";

// --- the page world can only see itself -------------------------------------
// Functions injected into LinkedIn's page run there, where nothing from this
// file exists. Naming one of its constants is valid JavaScript that throws only
// at the other end, where it surfaces as "page did not respond" — a whole run
// lost to a name that reads perfectly well here.
{
  const backgroundOnly = (src.match(/^const ([A-Z][A-Z0-9_]+)\s*=/gm) || [])
    .map(line => line.replace(/^const /, "").replace(/\s*=$/, ""));
  const injected = ["scrapeResumes", "findAttachmentPdf", "scrapeJobList", "getPageTitle"];

  for (const name of injected) {
    const start = src.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `${name} should exist`);
    let depth = 0, end = start;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i; break; }
    }
    const body = src.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");     // a comment may name it; only code can throw
    for (const konst of backgroundOnly) {
      assert.ok(!new RegExp(`\\b${konst}\\b`).test(body),
        `${name} runs in LinkedIn's page and cannot see ${konst} — inline the value instead`);
    }
  }
  console.log("ok    nothing injected into the page reaches for an extension-only name");
}

// --- which folder a job lands in --------------------------------------------
// Checked against the real role folders in Drive on 2026-09-21, hard ones
// included: a typo'd folder, old "CVs ..." duplicates of current roles, and
// two roles that share two of their three words. A wrong folder is worse than
// none, so every "none" below matters as much as every match.
{
  const { resolveFolder } = new Function("chrome", "fetch", "alert",
    src + "\nreturn { resolveFolder };")(chrome, global.fetch, global.alert);
  const folders = [
    "CVs Netsuite System Administrator", "CVs IT Support Specialist Tier 2",
    "CVs Sr Full Stack Engineer 20260223", "CVs Soft Dev Eng in Test", "CVs Sales Account Manager",
    "CVs Marketing Operations Manager v2.0",
    "CVs Weshape_Closer_Growth Account Executive (High-Ticket Closer)", "CVs Recruiter",
    "CVs Technical Product Manager", "CVs Product Manager", "CVs Project Manager",
    "CVs Salesforce Admin Tier 3", "CVs Marketing Operations Manager", "CVs Sr Full Stack Engineer",
    "CVs Platform Engineer", "CVs Woocommerce Wordpress", "Web Operation Specialist",
    "Sales Develpment Representative.", "Sales Operations Specialist", "test role",
    "Account Executive / Account Manager", "UI/UX Designer", "SDR - HRS",
    "Talent Acquisition Specialist", "HR Assistant", "SDET", "Project Coordinator",
    "Sales Account Manager", "Customer Success Manager", "Netsuite Admin", "IT Support Specialist",
    "CVs Accounts Payable Specialist", "CVs Customer Success Manager", "CVs Graphic Designer",
    "CVs Closer - Sales", "CVs HR Assistant/Virtual Assistant"
  ].map(name => [name, name]);
  const asTheExtensionHasThem = new Map(folders);   // what run() really passes in

  const cases = [
    ["Web Operations Specialist", "Web Operation Specialist"],          // plural
    ["Sales Development Representative", "Sales Develpment Representative."], // typo + full stop
    ["Custmer Success Manager", "Customer Success Manager"],          // a slipped letter
    ["Project Cordinator", "Project Coordinator"],
    ["Specialist, IT Support", "IT Support Specialist"],              // word order
    ["IT Support Specialists", "IT Support Specialist"],
    ["Sales Operation Specialist", "Sales Operations Specialist"],
    ["Customer Success Manager", "Customer Success Manager"],         // not the old "CVs" copy
    ["Sales Account Manager", "Sales Account Manager"],
    ["HR Assistant", "HR Assistant"],
    ["Netsuite Administrator", "Netsuite Admin"],                     // abbreviation
    ["Sales Development Rep", "Sales Develpment Representative."],
    ["Customer Success Mgr", "Customer Success Manager"],
    ["UX Designer", "UI/UX Designer"],                                // alias table
    ["Software Engineer in Test", "SDET"],
    ["Customer Success Specialist", "Customer Success Manager"],
    ["TI Support Specialist", "IT Support Specialist"],               // Spanish/Portuguese IT
    ["RH Assistant", "HR Assistant"],                                 // and HR
    ["Human Resources Assistant", "HR Assistant"],
    ["Sales Ops Specialist", "Sales Operations Specialist"],
    ["Web Ops Specialist", "Web Operation Specialist"],
    ["SDR", "Sales Develpment Representative."],
    ["Sales Development Representative (SDR)", "Sales Develpment Representative."], // acronym repeated
    ["Sales Development Representative(s)", "Sales Develpment Representative."],
    ["Sales Development Representative - HRS", "SDR - HRS"],          // the client's own SDR role
    ["Customer Success Manager - Remote, LATAM", "Customer Success Manager"],
    ["Software Development Engineer in Test", "SDET"],
    ["Costumer Success Manager", "Customer Success Manager"],
    ["IT Support Specialist I", "IT Support Specialist"],
    // Each of these once landed in the wrong folder when attacked. They stay none.
    ["Customer Success Manager - CVS", null],          // a client called CVS, not the old "CVs" folder
    ["Recruiter - CVS", null],
    ["SDR - HR", null],                                // HRS is a client, not the plural of HR
    ["Sales - Managed Accounts", null],                // managed is not a typo of manager
    ["Product Coordinator", null],                     // two letters from Project
    ["IT Support Specialist 2", null],
    ["Sales Operations Manager", null],
    ["Operations Specialist", null],                   // Web or Sales? Not guessing.
    ["Marketing Operations Specialist", null],         // shares two of three words with Sales Ops
    ["Web Specialist", null],
    ["PR Assistant", null],                            // one letter from HR — a different job
    ["Sales Manager", null],
    ["Account Manager", null],
    ["IT Support Specialist Tier 2", null],            // a different role from Tier 1
    ["Senior Customer Success Manager", null],         // seniority is part of the role
    ["Customer Success Manager Assistant", null],
    ["Graphic Designer", null]                         // only an old pre-GroundControl folder
  ];
  for (const [title, want] of cases) {
    assert.strictEqual(resolveFolder(title, asTheExtensionHasThem), want,
      `"${title}" should go to ${want ? `"${want}"` : "no folder"}`);
  }
  // Two folders that fit equally well: pick neither.
  assert.strictEqual(resolveFolder("Customer Success Manager",
    new Map([["Customer Success Manager", "a"], ["Customer Success Managers", "b"]])), null,
    "two folders that are the same name: no guess");
  assert.strictEqual(resolveFolder("Project Coordinatr",
    new Map([["Project Coordinator", "a"], ["Project Coordinater", "b"]])), null,
    "a title one letter from two folders: no guess");
  assert.strictEqual(resolveFolder("Diseñador Gráfico", new Map([["Disenador Grafico", "a"]])), "a",
    "accents don't count");
  assert.strictEqual(resolveFolder("CEO Assistant", new Map([["SEO Assistant", "a"]])), null,
    "no typo allowance in short words: CEO and SEO are different jobs");
  console.log(`ok    job titles find their own folder and never someone else's (${cases.length} cases)`);
}

// --- load and run -----------------------------------------------------------
new Function("chrome", "fetch", "alert", src)(chrome, global.fetch, global.alert);
assert.ok(state.clickHandler, "background.js never registered the toolbar click handler");

const run = () => {
  state.navigated = [];
  state.alerts = [];
  state.logs = [];
  state.skipKeysSeen = [];
  state.vouchedSeen = [];
  state.tabUrl = "https://www.linkedin.com/talent/jobs";
  // findFileId caches ids for the life of the worker, which is what we want.
  return state.clickHandler({ id: 1, windowId: 1, url: "https://www.linkedin.com/talent/jobs" });
};

const readState = () => JSON.parse(state.driveFiles["_cv-downloader-state-linkedin.json"] || "{}");
const readLedger = () => JSON.parse(state.driveFiles["_cv-downloader-ledger.json"] || "{}");

const withMiss = () => ({
  urls: [{ name: "María Muñoz", url: "https://media.example/a.pdf", key: KEY("new1") }],
  skipped: 1,
  failedItems: [{ name: "No Resume Person", key: KEY("none1"),
                  href: "https://www.linkedin.com/talent/profile/none1" }],
  stoppedEarly: false
});

(async () => {
  // The quiet job is already banked at its current count, so it must be skipped.
  state.driveFiles["_cv-downloader-state-linkedin.json"] =
    JSON.stringify({ noResume: {}, misses: {}, jobCounts: { [QUIET.jobId]: QUIET.applicants } });
  state.idToName["id-_cv-downloader-state-linkedin.json"] = "_cv-downloader-state-linkedin.json";
  state.driveFiles["_cv-downloader-ledger.json"] = JSON.stringify({ keys: [KEY("old1")] });
  state.idToName["id-_cv-downloader-ledger.json"] = "_cv-downloader-ledger.json";

  // ---- run 1: one new CV, one miss -----------------------------------------
  scrapeResult = withMiss();
  await run();

  const finish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(finish, "run 1 never reached the finish popup:\n" + state.alerts.join("\n---\n"));

  assert.ok(!state.navigated.some(u => u.includes(QUIET.jobId)),
    "a job whose applicant count has not moved must never be opened");
  assert.ok(state.navigated.some(u => u.includes(BUSY.jobId)),
    "the job that gained applicants must be opened");
  assert.ok(finish.includes(`No new applicants: ${QUIET.title}.`),
    "the popup should name the job it skipped:\n" + finish);
  console.log("ok    a job with an unchanged applicant count is skipped entirely");

  assert.strictEqual(state.pdfUploads, 1, "the one new CV should have reached Drive");
  assert.ok(readLedger().keys.includes(KEY("new1")), "the new person should be remembered");
  console.log("ok    a new applicant's CV is uploaded and remembered");

  let s = readState();
  assert.strictEqual(s.misses[KEY("none1")], 1,
    "a first miss is one strike, got: " + JSON.stringify(s.misses));
  assert.ok(!s.noResume[KEY("none1")], "nobody is retired on a single miss");
  console.log("ok    a first miss records one strike, not a retirement");

  assert.strictEqual(s.jobCounts[BUSY.jobId], undefined,
    "a job with an outstanding strike must not be marked done");
  assert.strictEqual(s.jobCounts[QUIET.jobId], QUIET.applicants, "existing marks survive");
  console.log("ok    a job with an outstanding strike stays in the queue");

  // ---- run 2: the same person misses again and is retired -------------------
  scrapeResult = withMiss();
  await run();

  s = readState();
  assert.ok(s.noResume[KEY("none1")], "a second miss should retire them");
  assert.strictEqual(s.noResume[KEY("none1")].name, "No Resume Person");
  assert.strictEqual(s.noResume[KEY("none1")].job, BUSY.title);
  assert.strictEqual(s.misses[KEY("none1")], undefined, "the strike is cleared on retirement");
  console.log("ok    a second miss retires them and clears the strike");

  // The popup's count is the whole list, not this run's — and says so, since
  // "21 people have no resume" under a 20-CV run read as half the run failing.
  const retireFinish = state.alerts.find(a => a.includes("Done —")) || "";
  assert.ok(/No resume: 1 applicant in total since [A-Z][a-z]{2} \d{1,2}, 1 new in this run/.test(retireFinish),
    "the no-resume line gives the total, since when, and how many are new:\n" + retireFinish);
  console.log("ok    the no-resume count says it's a running total, and how many this run added");

  const csv = state.driveFiles["_no-resume-candidates-linkedin.csv"];
  assert.ok(csv !== undefined, "the no-resume worklist should be written to Drive");
  assert.ok(csv.startsWith("﻿"), "needs a BOM so Excel renders accented names");
  assert.ok(csv.includes("Name,Job,First seen,Open in LinkedIn"), "needs its header row");
  assert.ok(csv.includes('"No Resume Person"'), "the retired person should be listed:\n" + csv);
  console.log("ok    the retired person appears in the recruiter worklist");

  // ---- run 3: clean pass, so the job finally banks --------------------------
  scrapeResult = { urls: [], skipped: 3, failedItems: [], stoppedEarly: false };
  await run();

  const skipped = state.skipKeysSeen[0] || [];
  assert.ok(skipped.includes(KEY("none1")),
    "the retired person must be handed to the page as skip-me, so they are never clicked again");
  assert.ok(skipped.includes(KEY("new1")), "already-downloaded people are skipped too");
  console.log("ok    retired and downloaded people are never clicked again");
  assert.ok((state.alerts.find(a => a.includes("Done —")) || "").includes("1 applicant in total since"),
    "the next run still shows the total");
  assert.ok((state.alerts.find(a => a.includes("Done —")) || "").includes("none new in this run"),
    "but says nobody new was added");

  assert.strictEqual(state.vouchedSeen[0], false,
    "a job that has never finished clean must not be allowed to stop early");
  console.log("ok    an unvouched job is told to read the list in full");

  s = readState();
  assert.strictEqual(s.jobCounts[BUSY.jobId], BUSY.applicants,
    "a clean pass banks the count so the next run can skip the job");
  console.log("ok    a clean pass banks the count for next time");

  // ---- run 4: someone new applies to a job that finished clean -------------
  // The everyday case, and the only one where stopping early is allowed.
  BUSY.applicants += 1;
  scrapeResult = { urls: [], skipped: 4, failedItems: [], stoppedEarly: true };
  await run();

  assert.ok(state.vouchedSeen[0],
    "a job that finished clean last time may stop early once it has caught up");
  assert.ok(state.logs.some(l => l.includes("stopped early")),
    "and the run detail logged to the console should say so:\n" + state.logs.join("\n"));
  console.log("ok    a clean job that gained an applicant is allowed to stop early");

  // ---- runs 5 and 6: applicants who attached no CV at all ------------------
  // These never had a Resume control, so before this they were invisible:
  // not downloaded, not counted, and never reviewable by a recruiter.
  BUSY.applicants += 1;
  scrapeResult = {
    urls: [], skipped: 2, failedItems: [], stoppedEarly: false,
    noCvItems: [
      { name: "Ghost One", key: KEY("ghost1"), href: "https://www.linkedin.com/talent/profile/ghost1" },
      { name: "Ghost Two", key: KEY("ghost2"), href: "https://www.linkedin.com/talent/profile/ghost2" }
    ]
  };
  await run();

  s = readState();
  assert.strictEqual(s.misses[KEY("ghost1")], 1, "an empty row is a strike, not a retirement");
  assert.ok(!s.noResume[KEY("ghost1")], "and not retired on the first sighting");
  console.log("ok    an applicant with no CV attached is now seen and given a strike");

  // Ghost Two turns out to have a CV after all — a slow-loading row, not an
  // empty one. Their strike must be wiped, or they'd retire by accident.
  scrapeResult = {
    urls: [{ name: "Ghost Two", url: "https://media.example/g2.pdf", key: KEY("ghost2") }],
    skipped: 2, failedItems: [], stoppedEarly: false,
    noCvItems: [
      { name: "Ghost One", key: KEY("ghost1"), href: "https://www.linkedin.com/talent/profile/ghost1" }
    ]
  };
  await run();

  s = readState();
  assert.ok(s.noResume[KEY("ghost1")], "a second empty sighting retires them");
  assert.strictEqual(s.misses[KEY("ghost2")], undefined,
    "a CV that finally loaded must wipe the earlier strike");
  assert.ok(!s.noResume[KEY("ghost2")], "so they are never retired by mistake");
  console.log("ok    a slow row that later yields a CV loses its strike");

  const finalCsv = state.driveFiles["_no-resume-candidates-linkedin.csv"];
  assert.ok(finalCsv.includes('"Ghost One"'), "the no-CV applicant reaches the recruiter list");
  assert.ok(!finalCsv.includes("Ghost Two"), "and the one who did have a CV does not");
  console.log("ok    the recruiter list names them, with a link to their profile");

  // ---- run 8: the list hides a Resume link, but the profile has the CV ------
  // Recruiter leaves the link off rows whose applicant did attach one. The
  // Attachments page is the real record, so that person must be downloaded,
  // not struck.
  BUSY.applicants += 1;
  state.attachments.hidden1 = "https://media.example/hidden1.pdf";
  const uploadsBefore = state.pdfUploads;
  scrapeResult = {
    urls: [], skipped: 3, failedItems: [], stoppedEarly: false,
    noCvItems: [
      { name: "Hidden Link", key: KEY("hidden1"), href: "https://www.linkedin.com/talent/profile/hidden1" }
    ]
  };
  await run();

  s = readState();
  assert.strictEqual(state.pdfUploads, uploadsBefore + 1, "the CV found on the profile should reach Drive");
  assert.ok(readLedger().keys.includes(KEY("hidden1")), "and they should be remembered as downloaded");
  assert.strictEqual(s.misses[KEY("hidden1")], undefined, "a CV on the profile is never a strike");
  assert.ok(state.navigated.some(u => u.includes("/profile/hidden1/attachments")),
    "the profile's Attachments page should have been checked");
  console.log("ok    a row missing its Resume link is rescued from the profile's attachments");

  // ---- run 9: full rescan un-retires someone who had a CV all along ---------
  // Ghost One was retired in run 6. A full rescan skips nobody, finds the CV on
  // their profile, and must take them off the no-resume list for good.
  state.attachments.ghost1 = "https://media.example/ghost1.pdf";
  scrapeResult = {
    urls: [], skipped: 0, failedItems: [], stoppedEarly: false,
    noCvItems: [
      { name: "Ghost One", key: KEY("ghost1"), href: "https://www.linkedin.com/talent/profile/ghost1" }
    ]
  };
  state.navigated = []; state.alerts = []; state.logs = []; state.skipKeysSeen = [];
  state.tabUrl = "https://www.linkedin.com/talent/jobs";
  await state.contextMenuHandler({ menuItemId: "full-rescan" },
    { id: 1, windowId: 1, url: "https://www.linkedin.com/talent/jobs" });

  assert.deepStrictEqual(state.skipKeysSeen[0], [], "a full rescan must skip nobody");
  assert.ok(state.navigated.some(u => u.includes(QUIET.jobId)),
    "a full rescan must open even a job whose count has not moved");
  s = readState();
  assert.ok(!s.noResume[KEY("ghost1")], "someone whose CV turned up must leave the no-resume list");
  assert.ok(!state.driveFiles["_no-resume-candidates-linkedin.csv"].includes("Ghost One"),
    "and the recruiter worklist");
  console.log("ok    a full rescan skips nobody and un-retires anyone whose CV turns up");

  // ---- run 10: the read comes up short of the list's own total --------------
  // The Customer Success Manager case: 189 read of 261, marked done anyway, and
  // then skipped forever because a closed job's count never moves. A short read
  // must never bank, must revoke an old bank, and must say so.
  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], QUIET.applicants, "precondition: the quiet job is banked");
  state.windowState = "minimized";
  scrapeResult = {
    urls: [{ name: "Read One", url: "https://media.example/r1.pdf", key: KEY("read1") }],
    skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
    expected: 261, read: 189, reason: "", slots: 0, shown: 261
  };
  state.navigated = []; state.alerts = []; state.logs = []; state.skipKeysSeen = []; state.activated = 0;
  state.tabUrl = "https://www.linkedin.com/talent/jobs";
  await state.contextMenuHandler({ menuItemId: "full-rescan" },
    { id: 1, windowId: 1, url: "https://www.linkedin.com/talent/jobs" });

  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], undefined,
    "a short read must revoke the job's earlier done mark, or a closed job is skipped forever");
  assert.strictEqual(s.jobCounts[BUSY.jobId], undefined, "and must never bank a new one");
  const shortFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(shortFinish.includes("Couldn't read every applicant"), "the popup must say so:\n" + shortFinish);
  assert.ok(state.logs.some(l => l.includes("read only 189 of 261")), "and the console must give the numbers");
  console.log("ok    a read short of the list's total is never marked done, and says so");

  assert.ok(state.activated >= 2, "the tab is brought to the front before each job");
  assert.strictEqual(state.windowState, "normal", "and a minimized window is restored");
  assert.strictEqual(state.awake, null, "the screen is allowed to sleep again once the run ends");
  console.log("ok    the tab is kept in front and the screen awake only while running");

  // A normal run afterwards must open the revoked job again instead of skipping it.
  scrapeResult = { urls: [], skipped: 5, failedItems: [], noCvItems: [], stoppedEarly: false,
                   expected: 5, read: 5, reason: "", slots: 5, shown: 5 };
  await run();
  assert.ok(state.navigated.some(u => u.includes(QUIET.jobId)),
    "a job whose done mark was revoked must be read again on the next normal run");
  console.log("ok    the next normal run goes back to the job that was cut short");

  // ---- run 11: a Next button that won't take ------------------------------
  // The page is reloaded straight at the next batch and reading carries on,
  // instead of the job ending 25 applicants in and being called complete.
  const before11 = state.pdfUploads;
  BUSY.applicants += 1; QUIET.applicants += 1;   // so both jobs are worth visiting again
  state.scrapeQueue = [
    { urls: [{ name: "Page One", url: "https://media.example/p1.pdf", key: KEY("p1") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 50, read: 25, reason: "", slots: 25, shown: 50 },
    { urls: [{ name: "Page Two", url: "https://media.example/p2.pdf", key: KEY("p2") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 50, read: 25, reason: "", slots: 25, shown: 50 }
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.ok(state.navigated.some(u => /\/discover\/applicants\?start=25$/.test(u)),
    "it should reload at the next batch:\n" + state.navigated.join("\n"));
  assert.strictEqual(state.pdfUploads, before11 + 2, "both batches' CVs should reach Drive");
  assert.ok(!state.navigated.some(u => /\?start=50$/.test(u)),
    "and with 50 of 50 read it stops, instead of asking for a batch that isn't there:\n" +
    state.navigated.join("\n"));
  const finish11 = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(!finish11.includes("Couldn't read every applicant"),
    "and with 50 of 50 read the job is complete:\n" + finish11);
  console.log("ok    a stuck Next button is reloaded past, not treated as the end of the list");

  assert.strictEqual(state.applicantsHintSeen, BUSY.applicants,
    "the job's own applicant count is passed in, to catch a bogus list total");
  console.log("ok    the page is told the job's applicant count as a sanity check");

  // Recruiter leaves the old 25 people on screen while the next page loads, so
  // each page is told who was first on the page before it and must not match.
  const before12 = state.pdfUploads;
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.firstIdsSeen = [];
  state.scrapeQueue = [
    { urls: [{ name: "A", url: "https://media.example/a.pdf", key: KEY("a") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false, expected: 50, read: 25,
      reason: "", slots: 25, shown: 50, firstId: "person-page-1" },
    { urls: [{ name: "B", url: "https://media.example/b.pdf", key: KEY("b") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false, expected: 50, read: 25,
      reason: "", slots: 25, shown: 50, firstId: "person-page-2" }
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.deepStrictEqual(state.firstIdsSeen.slice(0, 2), [undefined, "person-page-1"],
    "page two must be told page one's first person, so it can wait for the list to change");
  assert.strictEqual(state.pdfUploads, before12 + 2, "and both pages' CVs are taken");
  console.log("ok    each page waits for the people to change, not just the address");

  // What a page that never arrived hands back. Nothing to merge, and the reason
  // is the one string the caller keys off, so it is spelled once here.
  const stalled = () => ({ urls: [], skipped: 0, failedItems: [], noCvItems: [],
    stoppedEarly: false, expected: null, read: 0, reason: "the next page never loaded",
    slots: 0, shown: null, firstId: "person-page-1" });
  const cleanPage = () => ({ urls: [], skipped: 5, failedItems: [], noCvItems: [],
    stoppedEarly: false, expected: 5, read: 5, reason: "", slots: 5, shown: 5 });

  // ---- run 13: a batch that doesn't arrive is waited out, not given up on ---
  // Recruiter stops answering after a long stretch of page-turning. That is not
  // the end of the list and it passes on its own, so the same 25 are asked for
  // again after a rest — which is the difference between finishing a job and
  // abandoning it at 375 of 426 on every single run.
  BUSY.applicants += 1; QUIET.applicants += 1;
  const before13 = state.pdfUploads;
  state.scrapeQueue = [
    { urls: [], skipped: 25, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 50, read: 25, reason: "", slots: 25, shown: 50, firstId: "person-page-1" },
    stalled(),
    { urls: [{ name: "Second Wind", url: "https://media.example/s.pdf", key: KEY("wind") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 50, read: 25, reason: "", slots: 25, shown: 50, firstId: "person-page-2" },
    cleanPage()
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.strictEqual(state.navigated.filter(u => /\?start=25$/.test(u)).length, 2,
    "the same batch is asked for a second time, not skipped:\n" + state.navigated.join("\n"));
  assert.strictEqual(state.pdfUploads, before13 + 1, "and the CV it was hiding is taken");
  const stallFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(!stallFinish.includes("Couldn't read every applicant"),
    "a job that recovered is not reported as short:\n" + stallFinish);
  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], QUIET.applicants,
    "and it banks, so it isn't re-read from scratch next time");
  console.log("ok    a batch that never arrives is waited out and asked for again");

  // ---- run 13b: still nothing after the rests, deep into a long list -------
  // This once counted as "LinkedIn's 400 limit" and the job was marked done —
  // after which nothing past the stall was ever read again, because the next
  // run stops early at the top. There is no such limit (a 770-applicant job
  // read 740 of 740), so a stall that outlasts the rests is a short read like
  // any other: said out loud, and never marked done.
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [
    { urls: [], skipped: 400, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 612, read: 400, reason: "", slots: 25, shown: 612,
      firstId: "person-page-1" },
    stalled(), stalled(), stalled(),    // the first ask and both rests
    cleanPage()
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  // The offset is wherever the walk had reached; what matters is that the same
  // one is asked for three times before the stall is believed.
  assert.strictEqual(state.navigated.filter(u => /\?start=25$/.test(u)).length, 3,
    "it gives the stall two more chances before believing it:\n" + state.navigated.join("\n"));
  const deepFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(deepFinish.includes("Couldn't read every applicant"),
    "a stall deep in the list is still a short read:\n" + deepFinish);
  assert.ok(!deepFinish.includes("first 400"), "and no talk of a limit that doesn't exist:\n" + deepFinish);
  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], undefined,
    "and the job is not marked done, or its unread tail is never visited again");
  console.log("ok    a stall past the 400th applicant is a short read, never marked done");

  // ---- run 14: an empty shell of a list ------------------------------------
  // Recruiter hands back a page with no applicant rows on it. Reading nobody on
  // a job that has applicants is a failure; before this it was a silent one —
  // no popup line, nothing. Try again first, then say so.
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [
    { urls: [], skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: null, read: 0, reason: "the list never appeared", slots: 0, shown: null },
    // Second look, same job: this time the list is there.
    { urls: [{ name: "Late Riser", url: "https://media.example/l.pdf", key: KEY("late") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: 1, read: 1, reason: "", slots: 1, shown: 1 }
  ];
  const before14 = state.pdfUploads;
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.strictEqual(state.pdfUploads, before14 + 1,
    "an empty list is opened a second time, and the CV on it is taken");
  console.log("ok    a list that came back empty gets a second look");

  // Still empty the second time: that has to reach the popup.
  BUSY.applicants += 1; QUIET.applicants += 1;
  const empty = () => ({ urls: [], skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false,
                         expected: null, read: 0, reason: "", slots: 0, shown: null });
  // Two jobs, and each gets a first look plus two more after a rest.
  state.scrapeQueue = [empty(), empty(), empty(), empty(), empty(), empty()];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  const emptyFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(emptyFinish.includes("Couldn't read every applicant"),
    "a job that read nobody must be reported, not passed over in silence:\n" + emptyFinish);
  assert.ok(emptyFinish.includes("the list never appeared"), "with the reason:\n" + emptyFinish);
  s = readState();
  assert.strictEqual(s.jobCounts[BUSY.jobId], undefined,
    "and it must not be banked as done, or it is skipped forever");
  console.log("ok    a job that read nobody is reported and kept in the queue");

  // The job after a bad one used to start against a Recruiter that was still
  // refusing, and read nobody for that reason alone. It waits now.
  assert.ok((state.driveFiles["_cv-downloader-last-run-linkedin.log"] || "")
    .includes("last job came up short; resting"),
    "the next job should wait rather than walk into the same wall:\n" +
    state.driveFiles["_cv-downloader-last-run-linkedin.log"]);
  console.log("ok    a job that follows a bad one waits before starting");

  // ---- run 15: a list whose own total is bigger than the job's count -------
  // Recruiter shows some jobs a count far bigger than the applicants being
  // walked, so the total can't be trusted to say where the list ends. The last
  // page can: it comes back short. Without that, the walk asks for a page past
  // the end, waits out two rests for a batch that was never coming, and reports
  // a job that read every one of its 388 applicants as a failure — every run.
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [
    { urls: [], skipped: 25, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: null, read: 25, reason: "", slots: 25, shown: 388, firstId: "p1" },
    { urls: [], skipped: 13, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: null, read: 13, reason: "", slots: 13, shown: 388, firstId: "p2" },
    cleanPage()
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.ok(!state.navigated.some(u => /\?start=38$/.test(u)),
    "a short page is the last page — nothing should be asked for after it:\n" +
    state.navigated.join("\n"));
  const shortPageFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(!shortPageFinish.includes("Couldn't read every applicant"),
    "and the job is finished, not failed:\n" + shortPageFinish);
  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], QUIET.applicants, "so it banks");
  console.log("ok    a short page ends the list even when its total can't be trusted");

  // ---- run 16: everything read, and then one batch too many ---------------
  // Same situation, but the list happens to end on a full page, so the walk
  // can't tell until it asks. The batch never comes — because there was nothing
  // to send. Waiting that one out twice would be waiting for nothing.
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [
    { urls: [], skipped: 388, failedItems: [], noCvItems: [], stoppedEarly: false,
      expected: null, read: 388, reason: "", slots: 25, shown: 388, firstId: "p1" },
    stalled(),
    cleanPage()
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.strictEqual(state.navigated.filter(u => /\?start=25$/.test(u)).length, 1,
    "a batch past the end is not waited out and asked for again:\n" + state.navigated.join("\n"));
  const pastEndFinish = state.alerts.find(a => a.startsWith("Done —")) || "";
  assert.ok(!pastEndFinish.includes("Couldn't read every applicant"),
    "and reaching the end is not a failure:\n" + pastEndFinish);
  s = readState();
  assert.strictEqual(s.jobCounts[QUIET.jobId], QUIET.applicants, "so it banks");
  console.log("ok    a batch asked for past the end of the list is the end, not a failure");

  const log = state.driveFiles["_cv-downloader-last-run-linkedin.log"];
  assert.ok(log, "every run should leave a log in Drive to diagnose a short read");
  assert.ok(/=== .* \(job \d+/.test(log), "with a section per job: " + log);
  assert.ok(log.includes("result: read"), "and each job's result line: " + log);
  console.log("ok    every run writes a page-by-page log to Drive");

  // ---- a job title that differs from its folder only by a plural ---------
  // LinkedIn's "Web Operations Specialist" against GroundControl's "Web
  // Operation Specialist": nothing matched, and six CVs went to a Downloads
  // folder instead of Drive — marked done, so no later run would send them on.
  const realTitle = QUIET.title;
  QUIET.title = "Customer Success Managers";
  BUSY.applicants += 1; QUIET.applicants += 1;
  const downloadsBefore = state.downloads.length, uploadsBeforePlural = state.pdfUploads;
  state.scrapeQueue = [
    { urls: [{ name: "Plural Person", url: "https://media.example/plural.pdf", key: KEY("plural") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false, expected: 1, read: 1,
      reason: "", slots: 1, shown: 1 },
    cleanPage()
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();
  QUIET.title = realTitle;

  assert.strictEqual(state.downloads.length, downloadsBefore,
    "nothing should land in Downloads: " + state.downloads.slice(downloadsBefore).join(", "));
  assert.strictEqual(state.pdfUploads, uploadsBeforePlural + 1, "the CV reaches its Drive folder");
  console.log("ok    a job title that differs from its folder by a plural still finds it");

  // ---- two open jobs with the same title ---------------------------------
  // Four "Customer Success Manager" jobs were open at once, and the popup's
  // "No new applicants: Customer Success Manager, Customer Success Manager, ..."
  // said nothing about which. Where a title repeats, who posted it and when.
  const realBusyTitle = BUSY.title;
  Object.assign(QUIET, { poster: "Katya Aresti Tejada", posted: "9/21/2026" });
  Object.assign(BUSY, { title: QUIET.title, poster: "Tanya Alfaro", posted: "9/16/2026" });
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [
    cleanPage(),
    { urls: [{ name: "Twin Person", url: "https://media.example/twin.pdf", key: KEY("twin") }],
      skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false, expected: 1, read: 1,
      reason: "", slots: 1, shown: 1 }
  ];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();
  const twinFinish = state.alerts.find(a => a.includes("Done —")) || "";
  assert.ok(twinFinish.includes("Customer Success Manager (Tanya, Sep 16): 1"),
    "a repeated title says whose and when:\n" + twinFinish);
  assert.ok((state.driveFiles["_cv-downloader-last-run-linkedin.log"] || "")
    .includes("=== Customer Success Manager (Katya, Sep 21) (job"), "and so does the run log");
  BUSY.title = realBusyTitle;
  delete QUIET.poster; delete QUIET.posted; delete BUSY.poster; delete BUSY.posted;
  console.log("ok    jobs that share a title are told apart by who posted them and when");

  // ---- a job with no folder at all ---------------------------------------
  // Its CVs go to this computer's Downloads and the popup opens with a warning
  // in capitals. What they no longer are is marked done: that stranded six CVs
  // on a laptop where no later run would ever send them on. The first run
  // after the folder exists uploads them; the runs before it don't download
  // them again.
  QUIET.title = "Graphic Designer";
  BUSY.applicants += 1; QUIET.applicants += 1;
  const laptopPage = () => ({
    urls: [{ name: "Laptop Person", url: "https://media.example/laptop.pdf", key: KEY("laptop") }],
    skipped: 0, failedItems: [], noCvItems: [], stoppedEarly: false, expected: 1, read: 1,
    reason: "", slots: 1, shown: 1 });
  const downloadsBeforeNone = state.downloads.length, uploadsBeforeNone = state.pdfUploads;
  state.scrapeQueue = [laptopPage(), cleanPage()];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  assert.deepStrictEqual(state.downloads.slice(downloadsBeforeNone), ["Graphic Designer/Laptop Person.pdf"],
    "its CV is saved to this computer");
  assert.strictEqual(state.pdfUploads, uploadsBeforeNone, "not to Drive — there's no folder to put it in");
  const noneFinish = state.alerts.find(a => a.includes("Done —")) || "";
  assert.ok(noneFinish.startsWith("⚠️ NO DRIVE FOLDER FOR GRAPHIC DESIGNER — CVS SAVED TO DOWNLOADS"),
    "the popup opens with the warning, in capitals:\n" + noneFinish);
  assert.ok(!(readLedger().keys || []).includes(KEY("laptop")), "the CV is not marked done");
  assert.notStrictEqual(readState().jobCounts[QUIET.jobId], QUIET.applicants, "nor is the job");

  // Still no folder: what's already on this computer isn't fetched again.
  state.scrapeQueue = [cleanPage(), cleanPage()];
  state.navigated = []; state.alerts = []; state.logs = []; state.skipKeysSeen = [];
  await run();
  assert.ok(state.skipKeysSeen[0].includes(KEY("laptop")), "the laptop copy is skipped, not downloaded twice");

  // The folder "appears": the same CV now goes to Drive, and only now counts as done.
  QUIET.title = realTitle;
  const uploadsBeforeFolder = state.pdfUploads;
  state.scrapeQueue = [laptopPage(), cleanPage()];
  state.navigated = []; state.alerts = []; state.logs = []; state.skipKeysSeen = [];
  await run();
  assert.ok(!state.skipKeysSeen[0].includes(KEY("laptop")), "with a folder, the laptop copy is no longer skipped");
  assert.strictEqual(state.pdfUploads, uploadsBeforeFolder + 1, "so it reaches Drive");
  assert.ok(readLedger().keys.includes(KEY("laptop")), "and only then is it marked done");
  console.log("ok    no folder: saved to this computer, warned first, sent to Drive once the folder exists");

  // ---- the log keeps a history, newest on top, capped --------------------
  // When it held only the latest run, "how far did last night's get?" had no
  // answer by morning. It keeps the last 30 now, and must never grow past that.
  const LOG = "_cv-downloader-last-run-linkedin.log";
  const SEP = "\n\n" + "=".repeat(72) + "\n\n";
  state.driveFiles[LOG] = Array.from({ length: 30 }, (_, i) => `old run ${i + 1}\n`).join(SEP);
  BUSY.applicants += 1; QUIET.applicants += 1;
  state.scrapeQueue = [cleanPage(), cleanPage()];
  state.navigated = []; state.alerts = []; state.logs = [];
  await run();

  const runs = state.driveFiles[LOG].split(SEP);
  assert.ok(runs[0].includes("run finished"), "the newest run is on top:\n" + runs[0]);
  assert.strictEqual((runs[1] || "").trim(), "old run 1", "the one before it comes next");
  assert.strictEqual(runs.length, 30, "30 runs kept, got " + runs.length);
  assert.ok(!runs.some(r => r.includes("old run 30")), "and the oldest drops off");
  console.log("ok    the log keeps the last 30 runs, newest first");

  console.log("\nsmoke test passed — six runs end to end");
  process.exit(0);
})().catch(err => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});
