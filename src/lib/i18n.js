// i18n: we load the catalogue ourselves, we do not use `chrome.i18n.getMessage`.
//
// Two reasons, both in `src/lib/messages.js`: that API is locked to the browser
// UI language, and Chrome caches its catalogue (issue #59). Reading the JSON
// ourselves gives a language setting and removes a cache we do not control.
//
// `chrome.i18n` is still used for one thing: `getUILanguage()`, to honour the
// "follow the browser" setting.

import { FALLBACK_LANG, makeTranslator, resolveLang } from "./messages.js";

let translate = (key) => key;
let currentLang = FALLBACK_LANG;

export function t(key, subs) {
  return translate(key, subs);
}

export function activeLang() {
  return currentLang;
}

async function fetchCatalog(lang) {
  const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
  if (!res.ok) throw new Error(`_locales/${lang}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Loads the catalogue for the chosen language.
 *
 * Never throws: a UI without translations is bad, a UI that fails to start is
 * worse. On failure the previous translator stays in place, or keys render raw.
 *
 * @param {string} setting "auto" | "fr" | "en"
 */
export async function initI18n(setting = "auto") {
  const wanted = resolveLang(setting, chrome.i18n?.getUILanguage?.() ?? "");

  for (const lang of [wanted, FALLBACK_LANG]) {
    try {
      translate = makeTranslator(await fetchCatalog(lang));
      currentLang = lang;
      return lang;
    } catch (err) {
      console.warn("[TDC] catalogue", lang, "unavailable:", err?.message ?? err);
    }
  }
  return currentLang;
}

/**
 * Fills the document from the catalogue:
 *   data-i18n        -> textContent
 *   data-i18n-label  -> aria-label
 *   data-i18n-title  -> title
 *   data-i18n-ph     -> placeholder
 * Always through textContent, never through HTML (docs/AUDIT-SECU.md, pass 1).
 */
export function localizeDocument(root = document) {
  const apply = (attr, fn) => {
    for (const el of root.querySelectorAll(`[${attr}]`)) fn(el, t(el.getAttribute(attr)));
  };

  apply("data-i18n", (el, value) => {
    el.textContent = value;
  });
  apply("data-i18n-label", (el, value) => el.setAttribute("aria-label", value));
  apply("data-i18n-title", (el, value) => el.setAttribute("title", value));
  apply("data-i18n-ph", (el, value) => el.setAttribute("placeholder", value));

  document.documentElement.lang = currentLang;
}
