// Contrôles d'intégrité du paquet : ce qui attrape les régressions qu'un test de
// logique ne voit pas (fichier renommé, script inline interdit par la CSP,
// permission oubliée, clé i18n manquante, ressource trop largement exposée).
// Ces contrôles reprennent les greps de docs/AUDIT-SECU.md.

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

test("manifeste MV3 cohérent, aucun résidu MV2", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.background.type, "module", "sans type module, les import du SW cassent");
  assert.equal("browser_action" in manifest, false);
  assert.equal("background" in manifest && "scripts" in manifest.background, false);
  assert.equal(manifest.default_locale, "fr");
});

test("tous les fichiers cités par le manifeste existent", () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
  ];
  for (const ref of refs) assert.ok(existsSync(path.join(ROOT, ref)), `fichier manquant : ${ref}`);
});

test("les quatre tailles d'icône sont fournies", () => {
  assert.deepEqual(Object.keys(manifest.icons).sort(), ["128", "16", "32", "48"]);
});

test("périmètre réseau et injection les plus étroits possibles", () => {
  // `spade` et `ttvnw` ne sont là que pour OBSERVER (webRequest), jamais pour
  // émettre : le test suivant vérifie qu'aucun fetch ne les vise.
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
    assert.deepEqual(cs.matches, ["https://www.twitch.tv/*"], "domaine explicite, pas de wildcard TLD");
    assert.equal(cs.all_frames, false);
  }
});

test("le script de contenu démarre avant le lecteur (run_at justifié)", () => {
  // document_start : la qualité et le volume se posent dans localStorage AVANT
  // l'initialisation du lecteur Twitch. Justifié dans docs/AUDIT-SECU.md.
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
});

test("web_accessible_resources : strictement ce dont le script de contenu a besoin", () => {
  const entry = manifest.web_accessible_resources[0];
  assert.deepEqual(entry.matches, ["https://www.twitch.tv/*"]);
  assert.equal(entry.use_dynamic_url, true, "URL tournante : moins de surface de fingerprinting");

  const bootstrap = manifest.content_scripts[0].js[0];
  const imported = read(bootstrap).match(/getURL\("([^"]+)"\)/)?.[1];
  assert.ok(imported, "l'amorce doit charger son module par chrome.runtime.getURL");

  // Ce que le module importe doit être exposé, et rien d'autre.
  const needed = new Set([imported]);
  for (const m of read(imported).matchAll(/from\s+"([^"]+)"/g)) {
    needed.add(path.posix.normalize(path.posix.join(path.posix.dirname(imported), m[1])));
  }
  assert.deepEqual([...entry.resources].sort(), [...needed].sort());
});

test("aucun code distant ni évaluation dynamique", () => {
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(/\beval\s*\(|new Function\s*\(/.test(code), false, `${file} évalue du code`);
    assert.equal(/setTimeout\(\s*"/.test(code), false, `${file} passe une chaîne à setTimeout`);
  }
  for (const file of HTML_FILES) {
    assert.equal(/<script[^>]+src="https?:/.test(read(file)), false, `${file} charge un script distant`);
  }
});

test("aucun script ni gestionnaire inline (CSP des extensions)", () => {
  for (const file of HTML_FILES) {
    const html = read(file);
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
      (m) => m[1].trim().length > 0,
    );
    assert.equal(inline.length, 0, `${file} contient un script inline`);
    assert.equal(/\son\w+\s*=\s*"/.test(html), false, `${file} contient un gestionnaire inline`);
  }
});

test("aucune injection de HTML brut dans le code livré", () => {
  const usage = /\.(inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/;
  for (const file of SRC_JS) {
    assert.equal(usage.test(read(file)), false, `${file} injecte du HTML`);
  }
});

// --- passe 2 : permissions, messages, réseau ------------------------------

test("les API chrome utilisées sont couvertes par les permissions", () => {
  // Ces espaces de noms sont utilisables sans permission déclarée.
  // `tabs` en fait partie tant qu'on ne lit ni l'URL ni le titre des onglets.
  const SANS_PERMISSION = new Set(["runtime", "action", "i18n", "windows", "extension", "tabs"]);
  const declarees = new Set(manifest.permissions);

  const utilisees = new Set();
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/chrome\.(\w+)\./g)) utilisees.add(m[1]);
  }
  for (const api of utilisees) {
    if (SANS_PERMISSION.has(api)) continue;
    assert.ok(declarees.has(api), `chrome.${api} utilisé sans la permission correspondante`);
  }

  // Chaque permission déclarée doit servir : sinon elle saute.
  for (const perm of declarees) {
    assert.ok(utilisees.has(perm), `permission ${perm} déclarée mais jamais utilisée`);
  }
});

test("RÉGRESSION : rien qui exigerait la permission « tabs »", () => {
  assert.equal(manifest.permissions.includes("tabs"), false);
  const hotes = manifest.host_permissions;

  for (const file of SRC_JS) {
    const code = read(file);

    // `tabs.query` est permis sans la permission « tabs » dans deux cas :
    // filtré par une URL couverte par `host_permissions`, ce qui donne accès au
    // resultat ; ou restreint à l'onglet actif, dont on ne lit que l'identifiant.
    for (const m of code.matchAll(/chrome\.tabs\.query\(\s*\{([^}]*)\}/g)) {
      const filtre = m[1];
      if (/active:/.test(filtre)) continue;

      assert.match(filtre, /url:/, `${file} interroge les onglets sans filtre`);
      // On résout la constante quand le filtre en est une, sinon le test ne
      // vérifierait plus rien dès qu'on sort le motif dans une variable.
      const motif = filtre.match(/url:\s*([A-Za-z_$][\w$]*|"[^"]+")/)?.[1] ?? "";
      const litteral = motif.startsWith('"')
        ? motif.slice(1, -1)
        : (code.match(new RegExp(`${motif}\\s*=\\s*"([^"]+)"`))?.[1] ?? null);

      assert.ok(litteral, `${file} filtre les onglets sur un motif introuvable`);
      assert.ok(hotes.includes(litteral), `${file} filtre sur ${litteral}, hors host_permissions`);
    }

    // Le titre et le favicon, eux, resteraient hors de portée sans la permission.
    assert.equal(/\btab\.(title|favIconUrl)\b/.test(code), false, `${file} lit le titre d'un onglet`);
  }
});

test("RÉGRESSION : on ne peut pas ouvrir un onglet sans passer par farm.js", () => {
  // Chacun des chemins de farm.js vérifie d'abord qu'un onglet n'existe pas
  // déjà. Exporter l'ouverture rouvrirait la porte à un appel sans contrôle,
  // et c'est comme ça que naissaient les onglets et les fenêtres en double.
  const farm = read("src/background/farm.js");
  assert.match(farm, /async function openBackgroundTab/, "l'ouverture doit vivre dans farm.js");
  assert.equal(
    /export\s+(async\s+)?function openBackgroundTab|export\s*\{[^}]*openBackgroundTab/.test(farm),
    false,
    "openBackgroundTab ne doit pas être exportée",
  );

  // Ailleurs, un onglet ne s'ouvre qu'en réponse à un geste de l'utilisateur,
  // donc visible (`active: true`). Un onglet d'arrière-plan hors de farm.js
  // échapperait au contrôle.
  for (const file of SRC_JS) {
    if (file.endsWith("farm.js")) continue;
    for (const m of read(file).matchAll(/chrome\.tabs\.create\(\s*\{([^}]*)\}/g)) {
      assert.match(m[1], /active:\s*true/, `${file} ouvre un onglet d'arrière-plan`);
    }
  }
});

test("tout le réseau sortant reste sur Twitch, en HTTPS", () => {
  // `*.ttvnw.net` est le CDN vidéo de Twitch : on l'observe, on ne le contacte jamais.
  const OBSERVED_ONLY = /ttvnw\.net$/;
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(/http:\/\/(?!localhost)/.test(code), false, `${file} contient une URL en clair`);
    for (const m of code.matchAll(/https:\/\/\*?\.?([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      assert.ok(
        host.endsWith("twitch.tv") || OBSERVED_ONLY.test(host),
        `${file} contacte ${host}`,
      );
    }
  }
});

test("RÉGRESSION : un seul point de sortie réseau, l'API GraphQL de Twitch", () => {
  // Les domaines observés ne doivent jamais devenir des destinations.
  //
  // `chrome.runtime.getURL` ne sort pas de la machine : c'est une lecture d'un
  // fichier du paquet, comme le catalogue de traductions. Elle est nommée ici
  // explicitement pour que toute AUTRE forme de fetch reste refusée.
  const AUTORISES = new Set(["GQL_URL", "chrome.runtime.getURL"]);

  for (const file of SRC_JS) {
    const code = read(file);
    for (const m of code.matchAll(/fetch\(\s*([A-Za-z_$][\w$.]*|"[^"]+")/g)) {
      assert.ok(AUTORISES.has(m[1]), `${file} appelle fetch sur ${m[1]}, non autorisé`);
    }
    // Une lecture du paquet ne doit jamais viser autre chose que `_locales`.
    for (const m of code.matchAll(/chrome\.runtime\.getURL\(\s*`([^`]*)`/g)) {
      assert.match(m[1], /^_locales\//, `${file} lit ${m[1]} hors de _locales`);
    }
  }
});

test("RÉGRESSION : une seule socket, celle de Twitch, et en chiffré", () => {
  // Le test précédent ne couvre que `fetch`. Une socket est une sortie réseau
  // au même titre, et elle porte le jeton de session dans sa première trame :
  // elle ne doit pouvoir viser que Twitch, et jamais en clair.
  const dur = new Set();
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/new WebSocket\(\s*([A-Za-z_$][\w$]*|"[^"]+")/g)) {
      assert.equal(m[1], "PUBSUB_URL", `${file} ouvre une socket sur ${m[1]}`);
    }
    for (const m of read(file).matchAll(/"(wss?:\/\/[^"]+)"/g)) dur.add(m[1]);
  }

  assert.deepEqual([...dur], ["wss://pubsub-edge.twitch.tv/v1"]);
});

test("aucun secret ni jeton écrit en dur", () => {
  for (const file of SRC_JS) {
    const code = read(file);
    assert.equal(
      /(api[_-]?key|secret|password|mot de passe)\s*[:=]\s*["'][^"']{8,}/i.test(code),
      false,
      `${file} contient un secret en dur`,
    );
  }
});

test("le stockage est versionné et migrable", () => {
  const storage = read("src/lib/storage.js");
  assert.match(storage, /STORAGE_VERSION/);
  assert.match(storage, /export async function migrate/);
  assert.match(read("src/background/service-worker.js"), /store\.migrate\(\)/);
});

test("le garde-fou des messages n'est pas exposé à la page", () => {
  const exposed = manifest.web_accessible_resources.flatMap((w) => w.resources);
  assert.equal(exposed.includes("src/lib/message-guard.js"), false);
  assert.match(read("src/background/service-worker.js"), /validateMessage\(msg, sender, chrome\.runtime\.id\)/);
});

// --- i18n -----------------------------------------------------------------

test("fr et en déclarent exactement les mêmes clés", () => {
  const [fr, en] = LOCALES.map((l) => Object.keys(messages[l]).sort());
  assert.deepEqual(fr, en);
  for (const key of ["ext_name", "ext_description"]) assert.ok(messages.fr[key], `${key} manquant`);
});

test("chaque clé i18n utilisée existe dans les deux langues", () => {
  const used = new Set();

  for (const file of HTML_FILES) {
    for (const m of read(file).matchAll(/data-i18n(?:-label|-title|-ph)?="([^"]+)"/g)) used.add(m[1]);
  }
  for (const file of SRC_JS) {
    for (const m of read(file).matchAll(/(?:getMessage|\bt)\(\s*"([a-z0-9_]+)"/g)) used.add(m[1]);
  }
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_([a-z0-9_]+)__/g)) used.add(m[1]);

  assert.ok(used.size > 20, "extraction des clés cassée");
  for (const key of used) {
    for (const locale of LOCALES) {
      assert.ok(messages[locale][key], `clé ${key} absente de _locales/${locale}`);
    }
  }
});

test("aucune clé i18n morte", () => {
  const sources = [...HTML_FILES.map(read), ...SRC_JS.map(read)];
  const haystack = [...sources, JSON.stringify(manifest)].join("\n");

  // Les familles construites dynamiquement, du type t(`status_${code}`).
  const dynamic = new Set();
  for (const m of haystack.matchAll(/`([a-z0-9_]+_)\$\{/g)) dynamic.add(m[1]);

  for (const key of Object.keys(messages.fr)) {
    if ([...dynamic].some((prefix) => key.startsWith(prefix))) continue;
    assert.ok(haystack.includes(key), `clé ${key} définie mais jamais utilisée`);
  }
});

// --- divers ---------------------------------------------------------------

test("tous les fichiers JS sont syntaxiquement valides", () => {
  for (const file of ALL_JS) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, file)], { stdio: "pipe" });
    } catch (err) {
      assert.fail(`${file} ne compile pas :\n${err.stderr?.toString() ?? err.message}`);
    }
  }
});

test("les ressources locales des pages HTML existent", () => {
  for (const file of HTML_FILES) {
    const dir = path.dirname(file);
    for (const m of read(file).matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|data:|#|mailto:)/.test(m[1])) continue;
      assert.ok(existsSync(path.join(ROOT, dir, m[1])), `${file} référence ${m[1]}, absent`);
    }
  }
});

test("aucune chaîne magique de type de message hors de messaging.js", () => {
  const literals = /sendMessage\(\s*\{\s*type:\s*"/;
  for (const file of SRC_JS) {
    assert.equal(literals.test(read(file)), false, `${file} utilise un type de message littéral`);
  }
});
