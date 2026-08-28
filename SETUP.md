# CV Downloader 5.0 — setup

Downloads Recruiter resumes into Google Drive. Built to be shared with the team:
everyone works off one record of who has already been downloaded, so nobody
re-downloads a CV a colleague already got.

5.0 is 4.0 plus one idea — **know when not to work**. 4.0 opened every job and
re-tried every dead end on every run. 5.0 doesn't.

## What changed from 4.0

| | 4.0 | 5.0 |
|---|---|---|
| Jobs with no new applicants | opened and scrolled in full | skipped without opening |
| Someone whose resume won't load | re-clicked every run, ~10s each, forever | two strikes, then never again |
| Those people | invisible, only a "failed" count | listed in a CSV in the CV folder |
| Scrolling a job you've done | full scroll every time | switches the list to newest-first, then stops early |
| Before-you-load checks | none | `node check.js` and `node smoke.js` |

Almost all the time saving is the first row. On this account the Jobs page shows
an applicant count per job; 5.0 records that number after a clean run and skips
the job next time if it hasn't moved. A paused or closed job that receives a new
application still shows a higher number, so it is **not** skipped — the count is
the signal, not the job's status.

## Install — READ THIS FIRST

5.0 reuses 4.0's pinned `key`, which means Chrome sees them as **the same
extension**. It will refuse to load both.

1. `chrome://extensions` → **Remove** CV Downloader 4.0
2. Developer mode → **Load unpacked** → this folder
3. Confirm the ID still reads `clmdjdlgdapjilpibeeepihfbcnlbbcn`. If it doesn't,
   the `key` line in manifest.json got lost — Drive upload will fail without it.
4. Click the icon on the Recruiter Jobs list → approve the Google sign-in once

Reusing the key is deliberate: it keeps the existing OAuth client working, so
nothing has to change in Google Cloud and no colleague has to be re-approved.

The folder can live at any path on any machine.

## Google setup — unchanged from 4.0

| Item | Value |
|---|---|
| Cloud project | GroundControl Drive (`groundcontrol-drive`) |
| OAuth client | "CV Downloader 4.0", type Chrome Extension |
| Extension ID | `clmdjdlgdapjilpibeeepihfbcnlbbcn` (pinned) |
| Client ID | `276076835083-gmpri2h90v67ac5r57n8r9m2g3qne5kp.apps.googleusercontent.com` |

The private key that generates this ID lives **outside** this folder at
`C:\dev\cv-downloader-v4-private-key.pem` — deliberately, so zipping this folder
for a colleague never ships the key. You only need it to package a `.crx`;
loading unpacked doesn't.

Each colleague must still be added as a **test user**:
`console.cloud.google.com` → Google Auth Platform → **Audience** → Test users →
Add users → their work email → Save. Without this their sign-in is refused
outright. Cap is 100 test users.

## The three files in the CV folder

All three sit beside the role folders in `CV Folder`.

**`_cv-downloader-ledger.json`** — who has already been downloaded, as
`{projectId}:{profileId}`. Shared by the whole team, read at the start of every
run, rewritten after each job re-reading first so a colleague's entries survive.
Its shape is deliberately **unchanged from 4.0**, so a colleague still on 4.0
keeps sharing this list rather than fighting over it. Delete the file to make
everyone start fresh.

**`_cv-downloader-state-linkedin.json`** — 5.0's own bookkeeping: the applicant
count banked per job, and the no-resume strikes. Kept separate because 4.0
rewrites the ledger from scratch and would silently erase extra fields; a file it
never touches cannot be clobbered. Delete it to force a full re-scan of every
job — no CVs are re-downloaded, the ledger still remembers those.

**`_no-resume-candidates-linkedin.csv`** — the recruiter-facing worklist. Name,
job, first seen, and a link straight to the LinkedIn profile. Rewritten in full
on every run. Opens directly in Drive as a table.

If two people run at the same time, the overlap can lose a few entries. That
costs a duplicate upload, which GroundControl's MD5 dedup then trashes.

## The two-strikes rule

Someone whose resume can't be captured gets a strike, not a retirement. Only on
the **second** consecutive miss are they retired: added to the CSV and never
clicked again. Two, not one, so a slow-loading page can never strand a real
candidate. If their CV does load on a later run, the strike is wiped.

Two ways to come up empty, treated the same:

- the viewer opened but never produced a PDF, or
- **the applicant attached nothing at all.** Their row has no Resume control,
  so up to now the scraper never even saw them — they were not downloaded, not
  counted, and never reached this list. That is why LinkedIn's no-resume CSV
  used to sit empty while Indeed's worked. The row itself is watched now, not
  just the Resume links on it.

That second check is read-only: it observes rows already on screen and cannot
change which CVs get taken. If a whole job renders with no Resume controls at
all, that is treated as a broken page rather than a job full of empty
applicants, and nobody is marked.

A job with anyone on strike one is never marked done, so it stays in the queue
and that person gets their second look. Retirement is per person, not per job.

To give a retired person another chance, delete their row from the state file's
`noResume` block.

## Stopping the scroll early

Before reading anyone, 5.0 switches the job's applicant list to **Newest first**.
That is what makes stopping early safe: on LinkedIn's default **Relevance** sort
a brand-new applicant can sit anywhere in the list, so there is no point at which
you can stop. Sorted newest-first, a long run of people you already have means
you have reached last run's territory.

Recruiter forgets the choice on every job, so this runs once per job. It takes
about two seconds, against a scroll it can save minutes of — and it is skipped
entirely on a job we have to read in full anyway.

**The shortcut needs the job's clean certificate.** A job only earns one by
finishing a pass with nothing left hanging: nobody on their first no-resume
strike, no CV that Drive refused. Without it the list is read in full, which is
also what repairs the gap. Otherwise somebody left unfinished further down would
sit forever behind pages of people we already have. `smoke.js` covers both
directions.

One quirk worth knowing: a plain scripted click opens the sort menu but is
ignored on the menu item itself — the widget watches for the whole mouse press,
not just the click at the end. So the code sends the whole press. Verified
against the live page; if LinkedIn changes that widget this is the first thing
to re-test.

If the switch doesn't take for any reason, `canStopEarly` stays false and the
full scroll runs as before. Slower, never wrong. The console line says which it
got: `Sort is "Newest first" — early stop on`.

Recruiters may notice a job's list sitting on "Newest first" after a run. It is
a per-job view setting, not saved to their account, and resets on its own.

## Waiting versus checking

Every fixed pause in the scraping loop was replaced with "check ten times a
second, give up at the same deadline as before". The old code slept a flat 1.2
seconds after each scroll, another 2.4 confirming the end of a batch, and up to
a second per page turn, whether or not the page had already finished.

Nothing about the logic changed and the worst case is the same. It just stops
being patient when there is nothing to be patient about, which on a list that
pages 25 at a time was most of a job's running time.

## Before you load a change

```
node check.js     # every chrome API used is declared, files exist, key intact
node smoke.js     # six full runs against a fake Chrome and a fake Drive
```

These exist because two bugs on the Indeed extension reached the user that
reading the code could not catch — a missing manifest permission, and a helper
used one line before it was declared. Both were valid JavaScript. `smoke.js`
also caught a real bug in 5.0 during the build: a retired person's strike
counter came back to life on the next merge.

## Folder matching

Job titles match Drive folder names ignoring case, spaces and punctuation.
Verified against the live folder:

| LinkedIn job | Drive folder | How |
|---|---|---|
| Sales Account Manager | Sales Account Manager | exact |
| Customer Success Manager | Customer Success Manager | exact |
| Software Engineer in Test | SDET | alias |
| UX Designer | UI/UX Designer | alias |
| Netsuite Administrator | Netsuite Admin | alias |

Files land in `<role>/LinkedIn/`, created if missing. For a new job whose folder
name differs, add a line to `ALIASES` at the top of `background.js`. If nothing
matches, those CVs go to `Downloads/<job title>/` rather than being lost, and the
summary names the job.

## What happens after upload (GroundControl)

CVs don't keep the name this extension gave them. GroundControl
(`C:\dev\GroundControl`) scans each role folder, extracts the candidate's real
name with AI, and **renames the file in place** to `Lastname_Firstname.pdf`,
usually within the hour — acting as
`drive-uploader@groundcontrol-drive.iam.gserviceaccount.com`.

Two consequences:

- A filename never tells you which tool uploaded a file. Use Drive's Activity
  tab, which still shows the original upload.
- GroundControl reads the `LinkedIn` / `Indeed` / `Others` subfolder name to set
  each candidate's **source**. That's why filing into `LinkedIn/` matters.

## Notes

- **The Jobs page hides closed jobs by default.** Recruiter applies a "Job
  status: Open" filter, so a closed job is invisible to the run even if it has
  new applicants. Clear that filter before running if you want closed jobs
  included.
- The toolbar icon is LinkedIn's own favicon
  (`static.licdn.com/aero-v1/sc/h/akt4ae504epesldzj74dzred8`), an SVG rendered to
  16/32/48/128 PNGs in `icons/`. Fine for an internal tool; it is LinkedIn's
  trademark, so swap it before any Chrome Web Store listing.
- Archived applicants aren't in the default list. Filter to Archived and run
  again on that job's applicants page.
- **Untested assumption inherited from 4.0:** that LinkedIn profile ids are
  identical across recruiter seats on your contract. If a colleague's first run
  re-downloads everything you already have, that's why — the fix is to key the
  ledger on candidate name instead.
- Not built: unattended nightly runs. They'd need a machine left on with Chrome
  open and LinkedIn logged in.
