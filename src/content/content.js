// Amorce du script de contenu : injection minimale, isolated world.
// Les scripts de contenu classiques ne connaissent pas `import`, alors on charge
// le vrai module dynamiquement : il garde le contexte du script de contenu et
// peut donc réutiliser les modules purs de src/lib/ sans les dupliquer.
// Aucun code distant n'est chargé, la ressource est dans le paquet.
import(chrome.runtime.getURL("src/content/watcher.js")).catch((err) => {
  console.error("[TDC] chargement du module impossible", err);
});
