// i18n : `chrome.i18n` natif + application des attributs data-i18n.
// Aucun texte d'interface n'est écrit en dur dans les pages.

export function t(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

/**
 * Remplit le document depuis _locales :
 *   data-i18n        -> textContent
 *   data-i18n-label  -> aria-label
 *   data-i18n-title  -> title
 *   data-i18n-ph     -> placeholder
 * On passe par textContent, jamais par du HTML (docs/AUDIT-SECU.md, passe 1).
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

  document.documentElement.lang = chrome.i18n.getUILanguage?.() ?? "fr";
}
