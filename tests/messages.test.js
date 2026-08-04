import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FALLBACK_LANG,
  LANGUAGES,
  formatMessage,
  makeTranslator,
  resolveLang,
} from "../src/lib/messages.js";

const catalogue = (lang) =>
  JSON.parse(readFileSync(new URL(`../_locales/${lang}/messages.json`, import.meta.url), "utf8"));

test("an explicit choice beats the browser", () => {
  assert.equal(resolveLang("fr", "en-US"), "fr");
  assert.equal(resolveLang("en", "fr-FR"), "en");
});

test("auto follows the browser", () => {
  assert.equal(resolveLang("auto", "fr"), "fr");
  assert.equal(resolveLang("auto", "fr-CA"), "fr");
  assert.equal(resolveLang("auto", "FR-fr"), "fr");
  assert.equal(resolveLang("auto", "en-GB"), "en");
});

test("REGRESSION: an untranslated language falls back to English, not to nothing", () => {
  // We ship two translations. A German user must read English, not raw keys.
  for (const ui of ["de", "es-ES", "ja", "", null, undefined]) {
    assert.equal(resolveLang("auto", ui), "en", String(ui));
  }
});

test("an unknown setting breaks nothing", () => {
  assert.equal(resolveLang("klingon", "fr"), "fr");
  assert.equal(resolveLang(undefined, "fr"), "fr");
  assert.ok(LANGUAGES.includes(FALLBACK_LANG));
});

test("named placeholders are replaced the way Chrome does it", () => {
  const entry = {
    message: "$COUNT$ action(s) to do",
    placeholders: { count: { content: "$1" } },
  };
  assert.equal(formatMessage(entry, ["3"]), "3 action(s) to do");
});

test("REGRESSION: named placeholders resolve BEFORE positional ones", () => {
  // A named placeholder resolves to "$1". Resolving it after the positional
  // pass would leave nothing to replace, and the user would read "$COUNT$".
  const entry = {
    message: "Nothing for $MIN$ min: $REASON$",
    placeholders: { min: { content: "$1" }, reason: { content: "$2" } },
  };
  assert.equal(formatMessage(entry, ["15", "offline"]), "Nothing for 15 min: offline");
});

test("placeholder case does not matter", () => {
  const entry = { message: "$Count$ and $COUNT$", placeholders: { count: { content: "$1" } } };
  assert.equal(formatMessage(entry, ["2"]), "2 and 2");
});

test("an escaped dollar stays a dollar", () => {
  assert.equal(formatMessage({ message: "cost: $$1" }, ["9"]), "cost: $1");
  assert.equal(formatMessage({ message: "100 $$" }, []), "100 $");
});

test("a missing substitution yields nothing, not the marker", () => {
  const entry = { message: "a $1 b $2 c", placeholders: {} };
  assert.equal(formatMessage(entry, ["X"]), "a X b  c");
});

test("a single substitution can be passed without an array", () => {
  assert.equal(formatMessage({ message: "hi $1" }, "there"), "hi there");
});

test("an unreadable entry does not throw", () => {
  for (const junk of [null, undefined, {}, { message: 42 }, []]) {
    assert.equal(formatMessage(junk, []), "");
  }
});

test("the translator renders the key when it is missing", () => {
  const t = makeTranslator({ hello: { message: "Hello" } });
  assert.equal(t("hello"), "Hello");
  assert.equal(t("missing"), "missing");
});

test("REGRESSION: the prototype provides no translation", () => {
  // Without `Object.hasOwn`, `t("constructor")` would return a function and the
  // popup would render nonsense. Same trap as in message-guard.js.
  const t = makeTranslator({});
  assert.equal(t("constructor"), "constructor");
  assert.equal(t("__proto__"), "__proto__");
  assert.equal(t("toString"), "toString");
});

test("a missing catalogue does not take the interface down", () => {
  const t = makeTranslator(null);
  assert.equal(t("popup_title"), "popup_title");
});

test("REGRESSION: both catalogues carry exactly the same keys", () => {
  // A key present on one side only would render raw in the other language,
  // which is precisely the defect behind issue #59.
  const fr = Object.keys(catalogue("fr")).sort();
  const en = Object.keys(catalogue("en")).sort();
  assert.deepEqual(fr, en);
});

test("both catalogues declare the same placeholders", () => {
  const fr = catalogue("fr");
  const en = catalogue("en");
  for (const key of Object.keys(fr)) {
    assert.deepEqual(
      Object.keys(fr[key].placeholders ?? {}).sort(),
      Object.keys(en[key].placeholders ?? {}).sort(),
      `placeholders differ for ${key}`,
    );
  }
});

test("no translation leaves an undeclared placeholder behind", () => {
  // `$FOO$` with no entry in `placeholders` would render as-is.
  for (const lang of ["fr", "en"]) {
    const table = catalogue(lang);
    for (const [key, entry] of Object.entries(table)) {
      const declared = new Set(Object.keys(entry.placeholders ?? {}).map((n) => n.toLowerCase()));
      for (const m of entry.message.matchAll(/\$([A-Za-z_][\w]*)\$/g)) {
        assert.ok(declared.has(m[1].toLowerCase()), `${lang}/${key}: $${m[1]}$ is not declared`);
      }
    }
  }
});
