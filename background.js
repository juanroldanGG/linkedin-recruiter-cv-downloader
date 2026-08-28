// CV Downloader 5.0 — Recruiter resumes straight into Google Drive, shared
// across the team.
//
// Same scraping engine as 4.0. What 5.0 adds is knowing when NOT to work:
//
//   1. Jobs whose applicant count has not moved since the last clean run are
//      skipped without ever being opened. This is where nearly all the time
//      saving comes from.
//   2. People whose resume cannot be captured twice in a row are retired and
//      never clicked again, and their names are written to a CSV in Drive so a
//      recruiter can look at them by hand. 4.0 re-tried them, at roughly ten
//      seconds each, on every single run, forever.
//   3. Each job's applicant list is switched to "Newest first" before it is
//      read, so scrolling can stop once it has passed a long run of people we
//      already have. On LinkedIn's default relevance sort a new applicant can
//      be anywhere in the list, so if the switch doesn't take we scroll it all.
//
// The extension id is pinned by the "key" in manifest.json, so the same Drive
// folder works on every machine without breaking the OAuth client. That key is
// the same one 4.0 used, which means 4.0 must be removed before 5.0 is loaded.

// ===========================================================================
// CONFIG — the only two things you edit
// ===========================================================================

// The Drive folder that holds one subfolder per role.
// Get it from the URL: drive.google.com/drive/folders/<THIS PART>
const CV_FOLDER_ID = "1RbBTJlBdS5TTRFgXic8XZImlu9tl9qHj";

// LinkedIn job title -> Drive folder name, for the ones that don't match by
// name. Comparison ignores case, spaces and punctuation, so "UI/UX Designer"
// already matches "UI UX designer" without an entry here.
// Verified against the live CV Folder on 2026-08-14. "Sales Account Manager"
// and "Customer Success Manager" match their folders exactly, so they need no
// entry here.
const ALIASES = {
  "Software Engineer in Test": "SDET",
  "UX Designer": "UI/UX Designer",
  "Netsuite Administrator": "Netsuite Admin"
};

// Files go into <role>/LinkedIn/, not <role>/ — each role folder keeps one
// subfolder per source (LinkedIn, Indeed, Others). Created if missing.
const SOURCE_SUBFOLDER = "LinkedIn";

// The record of who has already been downloaded lives in Drive, not on this
// machine, so every colleague running the extension shares one list and nobody
// re-downloads what someone else already got. Created on first run.
//
// This stays exactly as 4.0 wrote it — same filename, same {keys:[...]} shape —
// so a colleague still on 4.0 keeps sharing the list with 5.0 rather than
// fighting over it.
const LEDGER_FILE = "_cv-downloader-ledger.json";

// 5.0's own bookkeeping (per-job counts, no-resume strikes) lives in a separate
// file. 4.0 rewrites the ledger from scratch on every save and would silently
// erase any extra fields we added to it; a second file it never touches cannot
// be clobbered.
const STATE_FILE = "_cv-downloader-state-linkedin.json";

// The worklist of people who have no downloadable resume, for recruiters.
const NO_RESUME_FILE = "_no-resume-candidates-linkedin.csv";

// Misses before someone is retired. Two, not one, so a slow-loading page can
// never strand a real candidate.
const NO_RESUME_STRIKES = 2;

// When the list is sorted newest-first, stop scrolling after this many people
// in a row that we already have. Ignored on a relevance sort.
const KNOWN_STREAK_STOP = 25;

// ===========================================================================

const APPLICANTS_RE = /\/talent\/hire\/(\d+)\/discover\/applicants/;
const HIRE_RE = /\/talent\/hire\/(\d+)/;
const DRIVE_ARGS = "supportsAllDrives=true&includeItemsFromAllDrives=true";

chrome.action.onClicked.addListener(async (tab) => {
  const onJobsList = tab.url.includes("/talent/jobs");
  const onApplicants = APPLICANTS_RE.test(tab.url);

  if (!onJobsList && !onApplicants) {
    inject(tab.id, () => alert(
      "Open one of these first:\n\n" +
      "• the Recruiter Jobs list (Jobs tab) — every job\n" +
      "• a job's Applicants page — just that job"
    ));
    return;
  }

  // MV3 kills the service worker after ~30s idle; a 7-job run takes minutes.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const startUrl = tab.url;
  clearedMisses.clear();   // the worker outlives a run; this must not

  try {
    const token = await getToken(true);
    if (!token) {
      await inject(tab.id, () => alert("Google sign-in was cancelled — nothing was uploaded."));
      return;
    }

    const folders = await listSubfolders(CV_FOLDER_ID);
    if (folders === null) {
      await inject(tab.id, (id) => alert(
        `Could not read the Drive folder.\n\nCheck CV_FOLDER_ID in background.js:\n${id}`
      ), [CV_FOLDER_ID]);
      return;
    }
    console.log("Drive folders:", Array.from(folders.keys()));

    // Shared record first; the local copy is a fallback for when Drive is
    // unreachable, and seeds the ledger with this machine's history on the
    // first run after an upgrade.
    const { doneKeys = [] } = await chrome.storage.local.get("doneKeys");
    const done = new Set([...(await readLedger()), ...doneKeys]);
    const state = await readState();

    const allJobs = onJobsList
      ? await inject(tab.id, scrapeJobList)
      : [{
          title: await inject(tab.id, getPageTitle),
          href: tab.url,
          jobId: (tab.url.match(HIRE_RE) || [])[1] || null,
          applicants: null   // single-job mode has no count to compare
        }];

    if (!allJobs || allJobs.length === 0) {
      await inject(tab.id, () => alert("No jobs found on this page."));
      return;
    }

    // A job is skippable only when we have a count now, and it is the same
    // count we recorded after a clean run. A missing or zero count always
    // scans — an unreadable page must never look like "nothing changed".
    const unchanged = j =>
      j.jobId && j.applicants > 0 && state.jobCounts[j.jobId] === j.applicants;

    const jobs = allJobs.filter(j => !unchanged(j));
    const skippedJobs = allJobs.filter(unchanged).map(j => j.title);

    await inject(tab.id, (n, skipped, prior, folderCount, retired) => alert(
      `CV Downloader 5.0 starting.\n\n` +
      `Jobs to visit: ${n}\n` +
      (skipped ? `Jobs unchanged since last run: ${skipped} (skipped entirely)\n` : "") +
      `Drive folders found: ${folderCount}\n` +
      `Already downloaded by the team: ${prior}\n` +
      (retired ? `Known to have no resume: ${retired} (not re-tried)\n` : "") +
      `\nThis tab will move between pages on its own. Please don't touch it.`
    ), [jobs.length, skippedJobs.length, done.size, folders.size, Object.keys(state.noResume).length]);

    if (jobs.length === 0) {
      await inject(tab.id, () => alert(
        "Nothing to do — no job has had a new applicant since the last run."
      ));
      return;
    }

    const report = [];
    const unmatched = [];

    for (const job of jobs) {
      const label = job.title || "Unknown job";
      const roleId = resolveFolder(label, folders);
      const folderId = roleId ? await getOrCreateChild(roleId, SOURCE_SUBFOLDER) : null;
      if (!folderId) unmatched.push(label);

      const url = await goToApplicants(tab.id, job.href);
      if (!url) {
        report.push(`${label}: could not open`);
        continue;
      }

      // Retired people are skipped inside the page, so they are never clicked
      // and never cost the ten seconds it takes to fail.
      const skipKeys = Array.from(done).concat(Object.keys(state.noResume));

      // A banked count is this job's certificate that last time finished clean.
      // Without one, somebody further down the list may still be unfinished,
      // and stopping early would walk straight past them. So: full read, which
      // is also what repairs the gap.
      const vouchedClean = job.jobId && state.jobCounts[job.jobId] !== undefined;
      const res = await inject(tab.id, scrapeResumes, [skipKeys, KNOWN_STREAK_STOP, vouchedClean]);
      if (!res) { report.push(`${label}: page did not respond`); continue; }

      let uploaded = 0, saved = 0, uploadFailed = 0;
      for (const item of res.urls) {
        const filename = `${safeName(item.name) || "resume"}.pdf`;
        const ok = folderId && await uploadToDrive(item.url, filename, folderId);
        if (ok) {
          uploaded++;
        } else {
          // Drive unavailable or no matching folder — keep the file locally
          // rather than losing it.
          chrome.downloads.download({
            url: item.url,
            filename: `${safeName(label)}/${filename}`,
            saveAs: false
          });
          saved++;
          // A folder existed and Drive still refused. They stay unrecorded and
          // must be retried, so this job doesn't earn its clean certificate.
          if (folderId) uploadFailed++;
        }
        // Only remember it when it reached its final home. A Drive upload that
        // failed while a folder existed is a hiccup worth retrying next run;
        // recording it would strand the CV in Downloads forever.
        if (item.key && (ok || !folderId)) done.add(item.key);
        await sleep(400);
      }

      // Two ways to come up empty, treated the same: we opened the viewer and
      // got nothing, or the row never had a Resume control at all. The second
      // kind used to be invisible — never downloaded, never counted, never
      // reviewable.
      const emptyHanded = (res.failedItems || []).concat(res.noCvItems || []);

      // A success wipes any earlier strike. A slow page shouldn't accumulate
      // them across runs and eventually retire somebody who does have a CV.
      for (const item of res.urls) {
        if (item.key && done.has(item.key)) {
          delete state.misses[item.key];
          clearedMisses.add(item.key);
        }
      }

      const retired = [];
      for (const miss of emptyHanded) {
        const strikes = (state.misses[miss.key] || 0) + 1;
        if (strikes >= NO_RESUME_STRIKES) {
          state.noResume[miss.key] = {
            name: miss.name,
            job: label,
            href: miss.href || "",
            at: new Date().toISOString()
          };
          delete state.misses[miss.key];
          retired.push(miss.name);
        } else {
          state.misses[miss.key] = strikes;
          clearedMisses.delete(miss.key);   // a fresh strike outranks an old clear
        }
      }

      // Bank the count only after a pass that left nothing hanging. Someone on
      // strike one still needs a second look, so the job stays in the queue.
      const sawSomething = res.urls.length + res.skipped > 0;
      if (sawSomething && emptyHanded.length === 0 && uploadFailed === 0 &&
          job.jobId && job.applicants > 0) {
        state.jobCounts[job.jobId] = job.applicants;
      }

      // Save after every job, not just at the end — a crash on job 5 must not
      // throw away jobs 1-4 and re-upload them next run. Publishing per job
      // also lets a colleague starting mid-run pick up what's already done.
      for (const k of await writeLedger(done)) done.add(k);
      await writeState(state);
      await chrome.storage.local.set({ doneKeys: Array.from(done) });

      console.log(`[${label}] uploaded ${uploaded}, local ${saved}, skipped ${res.skipped}, no resume ${emptyHanded.length}`);
      report.push(`${label}: ${uploaded} to Drive` +
        (saved ? `, ${saved} to Downloads` : "") +
        (res.skipped ? `, ${res.skipped} already had` : "") +
        (emptyHanded.length ? `, ${emptyHanded.length} no resume` : "") +
        (retired.length ? ` (${retired.length} retired)` : "") +
        (res.stoppedEarly ? " [stopped early — rest already had]" : ""));
    }

    await writeNoResumeList(state);
    await navigate(tab.id, startUrl);
    await inject(tab.id, (lines, total, missing, skipped, retiredTotal, listFile) => alert(
      `CV Downloader 5.0 complete.\n\n${lines.join("\n")}\n\n` +
      (skipped.length
        ? `Skipped ${skipped.length} job(s) with no new applicants: ${skipped.join(", ")}\n\n`
        : "") +
      (missing.length
        ? `No Drive folder matched: ${missing.join(", ")}\nThose went to Downloads. Add them to ALIASES in background.js.\n\n`
        : "") +
      `Remembered ${total} people in total.\n` +
      (retiredTotal
        ? `${retiredTotal} people have no resume — see ${listFile} in the CV folder.`
        : "")
    ), [report, done.size, unmatched, skippedJobs, Object.keys(state.noResume).length, NO_RESUME_FILE]);
  } catch (err) {
    console.error("Run failed:", err);
  } finally {
    clearInterval(keepAlive);
  }
});

// --- Google Drive -----------------------------------------------------------

function getToken(interactive) {
  return new Promise(resolve => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        console.error("Auth failed:", chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(token);
      }
    });
  });
}

// Tokens expire mid-run on a long scrape, so a 401 drops the cached one and
// retries once with a fresh token.
async function driveFetch(url, options = {}, retry = true) {
  const token = await getToken(false);
  if (!token) return null;
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (res.status === 401 && retry) {
    await new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r));
    return driveFetch(url, options, false);
  }
  return res;
}

// name -> folderId for every subfolder of the CV folder. null on failure.
async function listSubfolders(parentId) {
  const map = new Map();
  let pageToken = "";
  do {
    const q = encodeURIComponent(
      `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)` +
      `&pageSize=200&${DRIVE_ARGS}` + (pageToken ? `&pageToken=${pageToken}` : "");
    const res = await driveFetch(url);
    if (!res || !res.ok) {
      console.error("Drive list failed:", res && res.status, res && await res.text());
      return null;
    }
    const data = await res.json();
    for (const f of data.files || []) map.set(f.name, f.id);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return map;
}

// --- files in the CV folder --------------------------------------------------
//
// Three of them: the shared ledger of who has been downloaded, 5.0's own state,
// and the recruiter-facing CSV. Same find/read/write plumbing for all three.

const fileIds = {};   // name -> id, so we look each one up once per run

async function findFileId(name) {
  if (fileIds[name]) return fileIds[name];
  const q = encodeURIComponent(
    `'${CV_FOLDER_ID}' in parents and name='${name}' and trashed=false`
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&${DRIVE_ARGS}`
  );
  if (!res || !res.ok) return null;
  const data = await res.json();
  fileIds[name] = data.files && data.files.length ? data.files[0].id : null;
  return fileIds[name];
}

// Parsed contents, or null if the file is missing or unreadable. Unreadable is
// deliberately not fatal: a corrupt state file costs one slow run, not a crash.
async function readJsonFile(name) {
  const id = await findFileId(name);
  if (!id) return null;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&${DRIVE_ARGS}`
  );
  if (!res || !res.ok) {
    console.error(`Could not read ${name} — treating it as empty.`);
    return null;
  }
  try {
    return await res.json();
  } catch {
    console.error(`${name} is not valid JSON — treating it as empty.`);
    return null;
  }
}

// Creates the file on first write, overwrites it after that.
async function upsertFile(name, mimeType, body) {
  const id = await findFileId(name);
  const boundary = "cvdlfile";
  const res = id
    ? await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&${DRIVE_ARGS}`,
        { method: "PATCH", headers: { "Content-Type": mimeType }, body }
      )
    : await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${DRIVE_ARGS}`,
        {
          method: "POST",
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body:
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({ name, parents: [CV_FOLDER_ID] }) + `\r\n` +
            `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${body}\r\n` +
            `--${boundary}--\r\n`
        }
      );

  if (!res || !res.ok) {
    console.error(`Saving ${name} failed — this run's progress stays local only.`);
    return false;
  }
  if (!id) fileIds[name] = (await res.json()).id;
  return true;
}

// --- the shared ledger (4.0-compatible) --------------------------------------
//
// Holds every "{projectId}:{profileId}" already downloaded, by anyone. Reads
// merge, writes re-read first, so two people running at once lose at most the
// keys written in the seconds between. A lost key costs one duplicate upload,
// which GroundControl's MD5 dedup then trashes.
//
// The shape is left exactly as 4.0 writes it. Nothing else goes in here.

async function readLedger() {
  const data = await readJsonFile(LEDGER_FILE);
  return new Set(data && Array.isArray(data.keys) ? data.keys : []);
}

// Merges `keys` into whatever is in Drive right now and saves. Returns the
// merged set so the caller stays in step with the shared state.
async function writeLedger(keys) {
  const merged = new Set([...(await readLedger()), ...keys]);
  await upsertFile(LEDGER_FILE, "application/json",
    JSON.stringify({ keys: Array.from(merged), updated: new Date().toISOString() }));
  return merged;
}

// --- 5.0 state ---------------------------------------------------------------

const emptyState = () => ({ noResume: {}, misses: {}, jobCounts: {} });

// Strikes wiped during this run, because the person's CV finally loaded.
// Saving re-reads the other side and merges, which would bring the strike
// straight back — exactly how a retired person's strike used to return. Reset
// at the start of every run, and dropped again the moment a new strike is
// earned, so this can never suppress a real one.
const clearedMisses = new Set();

async function readState() {
  const raw = await readJsonFile(STATE_FILE);
  const s = emptyState();
  if (!raw || typeof raw !== "object") return s;
  if (raw.noResume && typeof raw.noResume === "object") s.noResume = raw.noResume;
  if (raw.misses && typeof raw.misses === "object") s.misses = raw.misses;
  if (raw.jobCounts && typeof raw.jobCounts === "object") s.jobCounts = raw.jobCounts;
  return s;
}

// Same merge-then-save discipline as the ledger, so two people running at once
// keep each other's job marks instead of overwriting them. Mine wins on a
// genuine conflict, because mine is the run that just finished looking.
async function writeState(state) {
  const theirs = await readState();
  const merged = {
    noResume: { ...theirs.noResume, ...state.noResume },
    misses: { ...theirs.misses, ...state.misses },
    jobCounts: { ...theirs.jobCounts, ...state.jobCounts },
    updated: new Date().toISOString()
  };
  // Merging brings back anything the other side still has, which would undo a
  // retirement's cleanup and leave dead strike counters piling up forever.
  // Retired beats counting: once someone is on the no-resume list, their strike
  // is meaningless.
  for (const k of Object.keys(merged.noResume)) delete merged.misses[k];
  for (const k of clearedMisses) delete merged.misses[k];

  await upsertFile(STATE_FILE, "application/json", JSON.stringify(merged));
  state.noResume = merged.noResume;
  state.misses = merged.misses;
  state.jobCounts = merged.jobCounts;
  return state;
}

// The recruiter-facing list. Rewritten in full on every run so it never drifts
// out of step with the state file. UTF-8 BOM so Excel renders accented names,
// and quoted fields so a comma in a name doesn't split the row.
async function writeNoResumeList(state) {
  const rows = Object.entries(state.noResume)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const csv = "﻿" + ["Name,Job,First seen,Open in LinkedIn"]
    .concat(rows.map(r => [
      esc(r.name || "(unknown)"),
      esc(r.job || ""),
      esc(String(r.at || "").slice(0, 10)),
      esc(r.href || "")
    ].join(",")))
    .join("\r\n");

  return upsertFile(NO_RESUME_FILE, "text/csv", csv);
}

// Returns the id of the named child folder, creating it if it doesn't exist.
async function getOrCreateChild(parentId, name) {
  const q = encodeURIComponent(
    `'${parentId}' in parents and name='${name}' and ` +
    `mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&${DRIVE_ARGS}`
  );
  if (res && res.ok) {
    const data = await res.json();
    if (data.files && data.files.length) return data.files[0].id;
  }

  const created = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?${DRIVE_ARGS}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      })
    }
  );
  if (!created || !created.ok) {
    console.error(`Could not create "${name}" under ${parentId}`);
    return null;
  }
  console.log(`Created missing "${name}" folder under ${parentId}`);
  return (await created.json()).id;
}

// Fetches the signed LinkedIn PDF and multipart-uploads it into the folder.
async function uploadToDrive(pdfUrl, filename, folderId) {
  try {
    let res = await fetch(pdfUrl);
    if (!res.ok) res = await fetch(pdfUrl, { credentials: "include" });
    if (!res.ok) { console.error(`Fetch failed (${res.status}) for ${filename}`); return false; }
    const blob = await res.blob();

    const boundary = "cvdl" + folderId.slice(0, 8) + filename.length;
    const meta = JSON.stringify({ name: filename, parents: [folderId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
      blob,
      `\r\n--${boundary}--\r\n`
    ]);

    const up = await driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&${DRIVE_ARGS}`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
    if (!up || !up.ok) {
      console.error(`Upload failed (${up && up.status}) for ${filename}`, up && await up.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Upload threw for ${filename}:`, err);
    return false;
  }
}

// Job title -> Drive folder id. Exact-ish match first, then the alias table.
function resolveFolder(jobTitle, folders) {
  const key = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const byKey = new Map();
  for (const [name, id] of folders) byKey.set(key(name), id);

  const direct = byKey.get(key(jobTitle));
  if (direct) return direct;

  for (const [job, folderName] of Object.entries(ALIASES)) {
    if (key(job) === key(jobTitle)) {
      const id = byKey.get(key(folderName));
      if (id) return id;
      console.warn(`Alias "${jobTitle}" -> "${folderName}" but no such Drive folder.`);
    }
  }
  return null;
}

// --- helpers (service worker side) -----------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
}

// Returns null instead of throwing. The tab navigates between jobs, so an
// injection can land on a frame that just went away ("Frame with ID 0 was
// removed"). That must not abort the whole run.
async function inject(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN", // page world, so we can intercept LinkedIn's window.open
      args,
      func
    });
    return results && results[0] ? results[0].result : null;
  } catch (err) {
    console.warn("inject failed:", err.message);
    return null;
  }
}

function navigate(tabId, url) {
  return new Promise(resolve => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // scrapeResumes waits for the list itself, so this is only a short
        // breath for the shell — not the old flat 2.5s per job.
        setTimeout(resolve, 800);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
    // Safety net: never hang forever if "complete" never fires.
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 30000);
  });
}

// A job row's link may point straight at the applicants view, or at the job,
// which redirects into /talent/hire/{projectId}/... — handle both.
async function goToApplicants(tabId, href) {
  await navigate(tabId, href);
  let current = (await chrome.tabs.get(tabId)).url || "";
  if (APPLICANTS_RE.test(current)) return current;

  const id = (current.match(HIRE_RE) || [])[1];
  if (!id) return null;
  await navigate(tabId, `https://www.linkedin.com/talent/hire/${id}/discover/applicants`);
  current = (await chrome.tabs.get(tabId)).url || "";
  return APPLICANTS_RE.test(current) ? current : null;
}

// --- page-world functions ---------------------------------------------------

// Reads the job title shown in the Recruiter header (single-job mode).
function getPageTitle() {
  const h = document.querySelector("h1, [data-test-project-name]");
  return (h && h.innerText.trim().split("\n")[0]) || document.title.split("|")[0].trim();
}

// Pulls { title, href, jobId, applicants } for every job row on the Jobs list.
//
// The applicant count is what makes a job skippable. Recruiter renders it as
// "Applicants: 84" inside the row, so we walk up from the job link until we
// find it. A row without one yields null, which always scans — better a slow
// run than a silently skipped job.
function scrapeJobList() {
  const jobs = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll("a[href*='/talent/']"))
    .filter(a => /\/talent\/(hire|jobs)\/\d+/.test(a.getAttribute("href") || a.href));

  for (const a of links) {
    const href = a.href;
    const id = (href.match(/\/talent\/(?:hire|jobs)\/(\d+)/) || [])[1];
    if (!id || seen.has(id)) continue;

    // The job title is the link's own text when the title itself is the link;
    // otherwise walk up to the row and take its first non-empty line.
    let title = (a.innerText || "").trim().split("\n")[0];
    let applicants = null;
    let row = a;
    for (let i = 0; i < 10 && row; i++) {
      const text = row.innerText || "";
      if (applicants === null) {
        const m = text.match(/Applicants:\s*([\d,]+)/i);
        if (m) applicants = parseInt(m[1].replace(/,/g, ""), 10);
      }
      if (!title || title.length < 3) {
        const t = text.trim().split("\n").filter(Boolean)[0];
        if (t && t.length >= 3) title = t;
      }
      if (applicants !== null && title && title.length >= 3) break;
      row = row.parentElement;
    }
    if (!title) continue;

    seen.add(id);
    jobs.push({ title, href, jobId: id, applicants });
  }
  console.log("Jobs found:", jobs.map(j => `${j.title} (${j.applicants})`));
  return jobs;
}

// Scrapes one applicants page.
// Returns { urls: [{name,url,key}], skipped, failedItems: [{name,key,href}], stoppedEarly }.
async function scrapeResumes(skipKeys, knownStreakStop, vouchedClean) {
  const skip = new Set(skipKeys || []);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PDF_RE = /\/ambry\/|\/dms|document\/media|pdf-analyzed|\.pdf/;
  const projectId = (location.pathname.match(/\/talent\/hire\/(\d+)/) || [])[1] || "job";

  // Stopping early is only safe when the newest people are at the top. On
  // LinkedIn's default relevance sort a brand-new applicant can sit anywhere in
  // the list, so we switch the list to "Newest first" ourselves before reading
  // anything. Recruiter forgets the choice on every job, so this runs per job.
  //
  // If the switch doesn't take, canStopEarly stays false and we fall back to the
  // full scroll. Slower, never wrong.
  let canStopEarly = false;

  // Everything below used to sleep a fixed amount and hope. waitFor keeps the
  // same worst case but returns the moment the page is actually ready, which is
  // usually a fraction of it. On a list that pages 25 at a time, those fixed
  // waits were most of a job's running time.
  const waitFor = async (cond, timeout, step = 150) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (cond()) return true;
      await sleep(step);
    }
    return false;
  };

  const readSort = () =>
    ((document.body.innerText.match(/Sort profiles by:\s*([^\n]+)/i) || [])[1] || "").trim();
  const isNewest = s => /recent|date|applied|newest/i.test(s);

  // A plain .click() opens the sort menu but is ignored on the menu item
  // itself — the widget watches for the whole press, not the click event at the
  // end of it. So we send the whole press. Verified against the live page.
  function pressLikeAMouse(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const sequence = ["pointerover", "pointerenter", "pointermove", "mouseover", "mousemove",
                      "pointerdown", "mousedown", "focus", "pointerup", "mouseup", "click"];
    for (const type of sequence) {
      if (type === "focus") { el.dispatchEvent(new FocusEvent("focus", { bubbles: true })); continue; }
      const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, o));
    }
  }

  async function chooseNewestFirst() {
    if (isNewest(readSort())) return true;

    const btn = Array.from(document.querySelectorAll("button"))
      .find(e => /^Sort by:/i.test((e.innerText || "").trim()));
    if (!btn) return false;

    const menuItem = () => Array.from(document.querySelectorAll("li[role=menuitem], [role=option]"))
      .find(e => /^newest/i.test((e.innerText || "").trim()));

    if (btn.getAttribute("aria-expanded") !== "true") {
      btn.click();
      await waitFor(() => !!menuItem(), 3000);
    }

    const item = menuItem();
    if (!item) {
      btn.click();   // put the menu back the way we found it
      return false;
    }

    pressLikeAMouse(item.firstElementChild || item);
    return waitFor(() => isNewest(readSort()), 14000);
  }

  function getResumeLinks() {
    return Array.from(document.querySelectorAll("a, button"))
      .filter(el => (el.innerText || "").trim().toLowerCase() === "resume");
  }

  function getName(el, fallback) {
    let row = el;
    for (let i = 0; i < 12 && row; i++) {
      const nameLink = row.querySelector && row.querySelector("a[href*='/talent/profile/'], a[href*='/in/']");
      if (nameLink) {
        const t = (nameLink.innerText || "").split("\n")[0].replace(/\s*·.*$/, "").trim();
        if (t) return t;
      }
      row = row.parentElement;
    }
    return fallback;
  }

  function getProfileHref(el) {
    let row = el;
    for (let i = 0; i < 12 && row; i++) {
      const a = row.querySelector && row.querySelector("a[href*='/talent/profile/']");
      if (a) return a.href;
      row = row.parentElement;
    }
    return "";
  }

  function getRowId(el) {
    let row = el;
    for (let i = 0; i < 12 && row; i++) {
      const a = row.querySelector && row.querySelector("a[href*='/talent/profile/']");
      if (a) {
        const m = a.getAttribute("href").match(/\/talent\/profile\/([^/?#]+)/);
        if (m) return m[1];
      }
      row = row.parentElement;
    }
    return null;
  }

  function findScrollableAncestor(el) {
    let current = el.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  // The resume PDF surfaces three ways: the link's own href, a window.open from
  // a Download control, or an iframe/embed inside the viewer modal.
  let captured = null;
  const origOpen = window.open;
  window.open = function (u) {
    if (u && PDF_RE.test(String(u))) { captured = String(u); return null; }
    return origOpen.apply(window, arguments);
  };

  const findEmbeddedPdf = () =>
    Array.from(document.querySelectorAll("iframe, embed, object"))
      .map(e => e.src || e.data)
      .find(src => src && PDF_RE.test(src)) || null;

  const findDownloadControl = () =>
    Array.from(document.querySelectorAll("a, button")).find(el => {
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
      return t === "download" || t.startsWith("download ");
    }) || null;

  function getNextPageButton() {
    let btn = document.querySelector(
      'button[aria-label="Next"], button[aria-label="Next page"], a[aria-label="Next"]'
    );
    if (!btn) {
      btn = Array.from(document.querySelectorAll("button, a")).find(el => {
        const t = (el.innerText || "").trim().toLowerCase();
        return t === "next" || t === "next ›" || t === "next >";
      });
    }
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
    return btn;
  }

  const pageSignature = () => getResumeLinks().map(getRowId).filter(Boolean).join(",");

  // Everything above walks the "Resume" controls, so an applicant who attached
  // nothing has no control, is never walked, and was invisible: not downloaded,
  // not counted, not reviewable. This watches the rows themselves instead, and
  // is deliberately read-only — it observes what is already on screen and can't
  // affect which CVs get taken.
  const rowsSeen = new Map();      // rowId -> {name, href}
  const rowsWithResume = new Set();

  function noteRows() {
    for (const a of document.querySelectorAll("a[href*='/talent/profile/']")) {
      const id = ((a.getAttribute("href") || "").match(/\/talent\/profile\/([^/?#]+)/) || [])[1];
      if (!id) continue;
      const row = a.closest("li");
      if (!row) continue;   // one <li> per candidate; anything else isn't a row
      if (!rowsSeen.has(id)) {
        rowsSeen.set(id, {
          name: (a.innerText || "").split("\n")[0].replace(/\s*·.*$/, "").trim() || "(unknown)",
          href: a.href
        });
      }
      if (row.querySelector("[data-test-decoration-resume-download-link]") ||
          Array.from(row.querySelectorAll("a, button"))
               .some(e => (e.innerText || "").trim().toLowerCase() === "resume")) {
        rowsWithResume.add(id);
      }
    }
  }

  // The list renders after the shell does — wait for it rather than bailing.
  await waitFor(() => getResumeLinks().length > 0, 20000);
  if (getResumeLinks().length === 0) {
    window.open = origOpen;
    return { urls: [], skipped: 0, failedItems: [], stoppedEarly: false };
  }

  // Re-sort before reading anyone, so the order we walk is the order we trust.
  // Only worth the two seconds when we're allowed to stop early anyway — on an
  // unvouched job we're reading the whole list regardless.
  canStopEarly = vouchedClean ? await chooseNewestFirst() : false;
  if (canStopEarly) {
    // The list is rebuilt from scratch after a re-sort — wait for it, and go
    // back to the top, or we'd start reading from wherever we happened to be.
    await waitFor(() => getResumeLinks().length > 0, 20000);
    window.scrollTo(0, 0);
    await waitFor(() => document.scrollingElement.scrollTop < 5, 1500);
  }
  console.log(`Sort is "${readSort()}" — early stop ${canStopEarly ? "on" : "off"}`);

  const urls = [];
  const failedItems = [];
  const seen = new Set();
  let skipped = 0, anon = 0, knownStreak = 0, stoppedEarly = false;
  const MAX_PAGES = 40;

  for (let page = 1; page <= MAX_PAGES && !stoppedEarly; page++) {
    const first = getResumeLinks()[0];
    // Recruiter scrolls the window, not an inner pane, on most layouts.
    const scroller = (first && findScrollableAncestor(first)) || document.scrollingElement || document.documentElement;
    let idleScrolls = 0;

    for (let guard = 0; guard < 3000; guard++) {
      // Rows are virtualized: take whatever unhandled row is live right now.
      const link = getResumeLinks().find(el => {
        const id = getRowId(el);
        return id && !seen.has(id);
      });

      noteRows();

      if (!link) {
        const before = scroller.scrollTop;
        scroller.scrollTop = Math.min(before + scroller.clientHeight * 0.8, scroller.scrollHeight);
        // Move on as soon as the next rows mount. Same 1.5s ceiling as the old
        // flat wait, but a list that responds in 150ms now costs 150ms.
        await waitFor(() => getResumeLinks().some(el => {
          const id = getRowId(el);
          return id && !seen.has(id);
        }), 1500);
        if (scroller.scrollTop <= before + 2) {
          if (++idleScrolls >= 2) break;
        } else {
          idleScrolls = 0;
        }
        continue;
      }
      idleScrolls = 0;

      const id = getRowId(link);
      seen.add(id);
      const key = `${projectId}:${id}`;
      const name = getName(link, `Applicant ${++anon}`);

      if (skip.has(key)) {
        skipped++;
        // A long unbroken run of people we already have means we have reached
        // the part of the list we did last time. Only trustworthy newest-first.
        if (canStopEarly && ++knownStreak >= knownStreakStop) {
          console.log(`Stopping early — ${knownStreak} in a row already downloaded.`);
          stoppedEarly = true;
          break;
        }
        continue;
      }
      knownStreak = 0;
      console.log(`[page ${page}] ${name}`);

      const directHref = link.href && PDF_RE.test(link.href) ? link.href : null;
      if (directHref) { urls.push({ name, url: directHref, key }); continue; }

      // Rare path. Almost every row's Resume control is already a direct link,
      // handled above without opening anything. This is for the ones that
      // aren't: open the viewer and watch for the PDF to surface.
      link.scrollIntoView({ block: "center" });
      captured = null;
      link.click();

      let found = null;
      for (let attempt = 0; attempt < 6 && !found; attempt++) {
        await waitFor(() => !!(captured || findEmbeddedPdf()), 900, 100);
        found = captured || findEmbeddedPdf();
        if (!found) {
          const dl = findDownloadControl();
          if (dl) {
            dl.click();
            await waitFor(() => !!(captured || findEmbeddedPdf()), 900, 100);
            found = captured || findEmbeddedPdf();
          }
        }
      }

      if (found) {
        urls.push({ name, url: found, key });
      } else {
        console.log(`Failed to capture PDF for ${name}`);
        failedItems.push({ name, key, href: getProfileHref(link) });
      }

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      await waitFor(() => !findEmbeddedPdf(), 600, 100);
    }

    noteRows();
    if (stoppedEarly) break;
    const next = getNextPageButton();
    if (!next) break;
    const before = pageSignature();
    next.scrollIntoView({ block: "center" });
    next.click();
    const changed = await waitFor(() => {
      const now = pageSignature();
      return !!now && now !== before;
    }, 12000);
    if (!changed) break;
  }

  noteRows();
  window.open = origOpen;

  // If not one row on the whole job had a resume control, the page didn't
  // render properly. Blame the page, not the candidates.
  const noCvItems = rowsWithResume.size === 0 ? [] :
    Array.from(rowsSeen.entries())
      .filter(([id]) => !rowsWithResume.has(id))
      .map(([id, v]) => ({ name: v.name, key: `${projectId}:${id}`, href: v.href }))
      .filter(item => !skip.has(item.key));

  if (noCvItems.length) console.log(`${noCvItems.length} applicant(s) with no resume attached.`);
  return { urls, skipped, failedItems, noCvItems, stoppedEarly };
}
