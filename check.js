// Pre-flight check. Run before packaging:  node check.js
//
// Exists because a missing "contextMenus" permission once made
// chrome.contextMenus undefined, which threw while the service worker was
// loading and took the entire extension down — "Service worker registration
// failed. Status code: 15". Syntax was fine; the manifest was not.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const source = fs.readFileSync(path.join(dir, "background.js"), "utf8");

// chrome.* namespaces that need no permission entry
const FREE = new Set(["action", "runtime", "i18n", "extension"]);

const used = [...new Set((source.match(/chrome\.([a-zA-Z]+)/g) || [])
  .map(m => m.split(".")[1]))].filter(ns => !FREE.has(ns));

const declared = new Set(manifest.permissions || []);
const missing = used.filter(ns => !declared.has(ns));
const unused = [...declared].filter(p => !used.includes(p) && p !== "activeTab");

let bad = false;

if (missing.length) {
  console.error("FAIL  used without a permission:", missing.join(", "));
  bad = true;
} else {
  console.log("ok    every chrome API used is declared:", used.join(", "));
}

if (unused.length) console.log("note  declared but unused:", unused.join(", "));

// Files the manifest points at must exist.
const refs = [
  manifest.background && manifest.background.service_worker,
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action || {}).default_icon || {})
].filter(Boolean);

for (const rel of [...new Set(refs)]) {
  if (!fs.existsSync(path.join(dir, rel))) {
    console.error("FAIL  manifest points at a missing file:", rel);
    bad = true;
  }
}
if (!bad) console.log("ok    all files referenced by the manifest exist");

// The pinned key and OAuth client must both survive edits, or Drive sign-in
// breaks for everyone.
if (!manifest.key) { console.error("FAIL  manifest.key missing — extension id would change"); bad = true; }
else console.log("ok    pinned extension key present");

const cid = manifest.oauth2 && manifest.oauth2.client_id;
if (!cid || cid.includes("PASTE")) { console.error("FAIL  OAuth client_id not set"); bad = true; }
else console.log("ok    OAuth client id set");

process.exit(bad ? 1 : 0);
