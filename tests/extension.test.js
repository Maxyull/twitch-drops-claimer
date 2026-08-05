// Package integrity checks: what catches the regressions a logic test cannot see
// (a renamed file, an inline script the CSP forbids, a forgotten permission, a
// missing i18n key, a resource exposed too widely).
// These checks mirror the greps in docs/SECURITY-AUDIT.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
const LOCALES = ["fr", "en"];
const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`_locales/${l}/messages.json`))]),
);

function walk(dir, ext) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs)) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel, ext));
    else if (entry.endsWith(ext)) out.push(rel);
  }
  return out;
}

const SRC_JS = walk("src", ".js");
const ALL_JS = [...SRC_JS, ...walk("tests", ".js"), ...walk("dev", ".js")];
const HTML_FILES = walk("src", ".html");

// --- passe 1 : manifeste & surface d'attaque ------------------------------

test("coherent MV3 manifest, no MV2 leftovers", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.background.type, "module", "without type module, the service worker's imports break");
  assert.equal("browser_action" in manifest, false);
  assert.equal("background" in manifest && "scripts" in manifest.background, false);
  assert.equal(manifest.default_locale, "fr");
});

test("every file the manifest names exists", () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
  ];
  for (const ref of refs) assert.ok(existsSync(path.join(ROOT, ref)), `missing file: ${ref}`);
});

test("all four icon sizes are provided", () => {
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "32", "48"]);
});

test("network and injection scope as narrow as possible", () => {
  // `spade` and `ttvnw` are there to OBSERVE only (webRequest), never to send:
  // the next test checks no fetch ever targets them.
  assert.deepEqual(manifest.host_permissions, [
    "https://www.twitch.tv/*",
    "https://gql.twitch.tv/*",
    "https://spade.twitch.tv/*",
    "https://*.ttvnw.net/*",
  ]);
  assert.equal(JSON.stringify(manifest).includes("<all_urls>"), false);
  assert.equal(JSON.stringify(manifest).includes("*://*"), false);
  assert.equal("externally_connectable" in manifest, false);
  assert.equal("content_security_policy" in manifest, false, "aucune CSP affaiblie");

  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, ["https://www.twitch.tv/*"], "explicit domain, no TLD wildcard");
    assert.equal(cs.all_frames, false);
  }
});

test("the content script starts before the player (run_at justified)", () => {
  // document_start: quality and volume are written to localStorage BEFORE the
  // Twitch player initialises. Argued in docs/SECURITY-AUDIT.md.
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
});

test("web_accessible_resources: strictly what the content script needs", () => {
  const entry = manifest.web_accessible_resources[0];
  assert.deepEqual(entry.matches, ["https://www.twitch.tv/*"]);
  assert.equal(entry.use_dynamic_url, true, "URL tournante : moins de surface de fingerprinting");

  const bootstrap = manifest.content_scripts[0].js[0];
  const imported = read(bootstrap).match(/getURL\("([^"]+)"\)/)?.[1];
  assert.ok(imported, "l'amorce doit charger son module par chrome.runtime.getURL");

  // What the module imports must be exposed, and nothing else.
  const needed = new Set([imported]);
  for (const m of read(imported).matchAll(/from\s+"([^"]+)"/g)) {
    needed.add(path.posix.normalize(path.posix.join(path.posix.dirname(imported), m[1])));
  }
  assert.deepEqual([...entry.resources].sort(), [...needed].sort());
});

test("no remote code and no dynamic evaluation", () => {
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(/\beval\s*\(|new Function\s*\(/.test(code), false, `${file} evaluates code`);
    assert.equal(/setTimeout\(\s*"/.test(code), false, `${file} passes a string to setTimeout`);
  }
  for (const file of HTML_FILES) {
    assert.equal(/<script[^>]+src="https?:/.test(read(file)), false, `${file} charge un script distant`);
  }
});

test("no inline script and no inline handler (extension CSP)", () => {
  for (const file of HTML_FILES) {
    const html = read(file);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
      (m) => m[1].trim().length > 0,
    );
    assert.equal(inline.length, 0, `${file} contient un script inline`);
    assert.equal(/\son\w+\s*=\s*"/.test(html), false, `${file} contient un gestionnaire inline`);
  }
});

test("no raw HTML injection in the shipped code", () => {
  const usage = /\.(inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/;
  for (const file of SRC_JS) {
    assert.equal(usage.test(read(file)), false, `${file} injecte du HTML`);
  }
});

// --- pass 2: permissions, messages, network -----------------------------------

test("the chrome APIs used are covered by the permissions", () => {
  // These namespaces are usable with no declared permission.
  // `tabs` is one of them, as long as we read neither a tab's URL nor its title.
  const SANS_PERMISSION = new Set(["runtime", "action", "i18n", "windows", "extension", "tabs"]);
  const declarees = new Set(manifest.permissions);

  const utilisees = new Set();
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/chrome\.(\w+)\./g)) utilisees.add(m[1]);
  }
  for (const api of utilisees) {
    if (SANS_PERMISSION.has(api)) continue;
    assert.ok(declarees.has(api), `chrome.${api} used without the matching permission`);
  }

  // Every declared permission must be used: otherwise it goes.
  for (const perm of declarees) {
    assert.ok(utilisees.has(perm), `permission ${perm} declared but never used`);
  }
});

test("REGRESSION: nothing that would require the \"tabs\" permission", () => {
  assert.equal(manifest.permissions.includes("tabs"), false);
  const hotes = manifest.host_permissions;

  for (const file of SRC_JS) {
    const code = read(file);

    // `tabs.query` is allowed without the "tabs" permission in two cases:
    // filtered by a URL covered by `host_permissions`, which grants access to the
    // result; or restricted to the active tab, of which only the id is read.
    for (const m of code.matchAll(/chrome\.tabs\.query\(\s*\{([^}]*)\}/g)) {
      const filtre = m[1];
      if (/active:/.test(filtre)) continue;

      assert.match(filtre, /url:/, `${file} queries tabs with no filter`);
      // The constant is resolved when the filter is one, otherwise the test would
      // check nothing at all as soon as the pattern moved into a variable.
      const motif = filtre.match(/url:\s*([A-Za-z_$][\w$]*|"[^"]+")/)?.[1] ?? "";
      const litteral = motif.startsWith('"')
        ? motif.slice(1, -1)
        : (code.match(new RegExp(`${motif}\\s*=\\s*"([^"]+)"`))?.[1] ?? null);

      assert.ok(litteral, `${file} filters tabs on a pattern that cannot be found`);
      assert.ok(hotes.includes(litteral), `${file} filters on ${litteral}, outside host_permissions`);
    }

    // The title and the favicon, on the other hand, would stay out of reach
    // without the permission.
    assert.equal(/\btab\.(title|favIconUrl)\b/.test(code), false, `${file} reads a tab's title`);
  }
});

test("REGRESSION: a tab cannot be opened without going through farm.js", () => {
  // Each of farm.js's paths first checks a tab does not already exist. Exporting
  // the opening would reopen the door to an unchecked call, and that is exactly
  // how the duplicate tabs and windows were born.
  const farm = read("src/background/farm.js");
  assert.match(farm, /async function openBackgroundTab/, "the opening must live in farm.js");
  assert.equal(
    /export\s+(async\s+)?function openBackgroundTab|export\s*\{[^}]*openBackgroundTab/.test(farm),
    false,
    "openBackgroundTab must not be exported",
  );

  // Elsewhere, a tab only opens in response to a user gesture, and is therefore
  // visible (`active: true`). A background tab outside farm.js would escape the
  // check.
  for (const file of SRC_JS) {
    if (file.endsWith("farm.js")) continue;
    for (const m of read(file).matchAll(/chrome\.tabs\.create\(\s*\{([^}]*)\}/g)) {
      assert.match(m[1], /active:\s*true/, `${file} opens a background tab`);
    }
  }
});

test("all outgoing network stays on Twitch, over HTTPS", () => {
  // `*.ttvnw.net` is Twitch's video CDN: we observe it, we never contact it.
  const OBSERVED_ONLY = /ttvnw\.net$/;
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(/http:\/\/(?!localhost)/.test(code), false, `${file} contains a cleartext URL`);
    for (const m of code.matchAll(/https:\/\/\*?\.?([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      assert.ok(
        host.endsWith("twitch.tv") || OBSERVED_ONLY.test(host),
        `${file} contacte ${host}`,
      );
    }
  }
});

test("REGRESSION: a single network exit point, Twitch's GraphQL API", () => {
  // The observed domains must never become destinations.
  //
  // `chrome.runtime.getURL` does not leave the machine: it reads a file from the
  // package, like the translation catalogue. It is named explicitly here so that
  // any OTHER form of fetch stays refused.
  const AUTORISES = new Set(["GQL_URL", "chrome.runtime.getURL"]);

  for (const file of SRC_JS) {
    const code = read(file);
    for (const m of code.matchAll(/fetch\(\s*([A-Za-z_$][\w$.]*|"[^"]+")/g)) {
      assert.ok(AUTORISES.has(m[1]), `${file} calls fetch on ${m[1]}, which is not allowed`);
    }
    // A read from the package must never target anything but `_locales`.
    for (const m of code.matchAll(/chrome\.runtime\.getURL\(\s*`([^`]*)`/g)) {
      assert.match(m[1], /^_locales\//, `${file} lit ${m[1]} hors de _locales`);
    }
  }
});

test("REGRESSION: a single socket, Twitch's, and encrypted", () => {
  // The previous test only covers `fetch`. A socket is just as much a network
  // exit, and it carries the session token in its very first frame: it must be
  // able to target Twitch and nothing else, and never in cleartext.
  const dur = new Set();
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/new WebSocket\(\s*([A-Za-z_$][\w$]*|"[^"]+")/g)) {
      assert.equal(m[1], "PUBSUB_URL", `${file} opens a socket on ${m[1]}`);
    }
    for (const m of read(file).matchAll(/"(wss?:\/\/[^"]+)"/g)) dur.add(m[1]);
  }

  assert.deepEqual([...dur], ["wss://pubsub-edge.twitch.tv/v1"]);
});

test("no secret and no token written in the code", () => {
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(
      /(api[_-]?key|secret|password|mot de passe)\s*[:=]\s*["'][^"']{8,}/i.test(code),
      false,
      `${file} contains a hardcoded secret`,
    );
  }
});

test("storage is versioned and migratable", () => {
  const storage = read("src/lib/storage.js");
  assert.match(storage, /STORAGE_VERSION/);
  assert.match(storage, /export async function migrate/);
  assert.match(read("src/background/service-worker.js"), /store\.migrate\(\)/);
});

test("the message guard is not exposed to the page", () => {
  const exposed = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.equal(exposed.includes("src/lib/message-guard.js"), false);
  assert.match(read("src/background/service-worker.js"), /validateMessage\(msg, sender, chrome\.runtime\.id\)/);
});

// --- i18n -----------------------------------------------------------------

test("fr and en declare exactly the same keys", () => {
  const [fr, en] = LOCALES.map((l) => Object.keys(messages[l]).sort());
  assert.deepEqual(fr, en);
  for (const key of ["ext_name", "ext_description"]) assert.ok(messages.fr[key], `${key} missing`);
});

test("every i18n key used exists in both languages", () => {
  const used = new Set();

  for (const file of HTML_FILES) {
    for (const m of read(file).matchAll(/data-i18n(?:-label|-title|-ph)?="([^"]+)"/g)) used.add(m[1]);
  }
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/(?:getMessage|\bt)\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
  }
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);

  assert.ok(used.size > 20, "key extraction is broken");
  for (const key of used) {
    for (const locale of LOCALES) {
      assert.ok(messages[locale][key], `key ${key} missing from _locales/${locale}`);
    }
  }
});

test("no dead i18n key", () => {
  const sources = [...HTML_FILES.map(read), ...SRC_JS.map(read)];
  const haystack = [...sources, JSON.stringify(manifest)].join("\n");

  // Families built dynamically, of the form t(`status_${code}`).
  const dynamic = new Set();
  for (const m of haystack.matchAll(/`([a-z0-9_]+_)\$\{/g)) dynamic.add(m[1]);

  for (const key of Object.keys(messages.fr)) {
    if ([...dynamic].some((prefix) => key.startsWith(prefix))) continue;
    assert.ok(haystack.includes(key), `key ${key} defined but never used`);
  }
});

// --- miscellaneous --------------------------------------------------------------

test("every JS file is syntactically valid", () => {
  for (const file of ALL_JS) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, file)], { stdio: "pipe" });
    } catch (err) {
      assert.fail(`${file} does not compile:\n${err.stderr?.toString() ?? err.message}`);
    }
  }
});

test("the local resources of the HTML pages exist", () => {
  for (const file of HTML_FILES) {
    const dir = path.dirname(file);
    for (const m of read(file).matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|data:|#|mailto:)/.test(m[1])) continue;
      assert.ok(existsSync(path.join(ROOT, dir, m[1])), `${file} references ${m[1]}, which is missing`);
    }
  }
});

test("no magic message-type string outside messaging.js", () => {
  const literals = /sendMessage\(\s*\{\s*type:\s*"/;
  for (const file of SRC_JS) {
    assert.equal(literals.test(read(file)), false, `${file} uses a literal message type`);
  }
});

// The defect in #76: every function below ends up in the popup, and each one used
// to be handed a French sentence built where the failure happened. The i18n
// coverage test could not see it, because a hardcoded string never asks the
// catalogue for anything. This one looks at the call sites instead.
test("REGRESSION: no literal sentence is handed to a function that displays it", () => {
  const displays = /\b(setLastError|showError|renderError)\(\s*(["'`]|\{\s*message:\s*["'`])/;
  for (const file of SRC_JS) {
    const m = read(file).match(displays);
    assert.equal(
      m,
      null,
      `${file} passes a literal to ${m?.[1]}: use a descriptor from src/lib/errors.js`,
    );
  }
});

// A key that exists in errors.js but in neither catalogue would render raw in the
// popup, which is the failure this whole change is meant to remove. The dead-key
// test above covers the other direction.
test("every ERROR key is defined in both catalogues", () => {
  const keys = [...read("src/lib/errors.js").matchAll(/"(error_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 15, "ERROR keys are no longer being found in errors.js");

  for (const key of new Set(keys)) {
    for (const locale of LOCALES) {
      assert.ok(messages[locale][key], `${key} missing from _locales/${locale}`);
    }
  }
});
