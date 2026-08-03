// Parcours parallèle borné.
// Twitch expose parfois plusieurs dizaines de campagnes : les chercher une par
// une prend des minutes, toutes d'un coup c'est se faire jeter. Un petit nombre
// de requêtes en vol à la fois est le bon compromis.
// Module pur.

/**
 * Applique `fn` à chaque élément, au plus `limit` en parallèle.
 * L'ordre des résultats suit celui des éléments, pas celui des fins d'exécution.
 * Un échec n'interrompt rien : l'élément vaut `fallback`, les autres continuent.
 *
 * @param {Array} items
 * @param {number} limit  nombre maximum d'exécutions simultanées
 * @param {(item:any, index:number)=>Promise<any>} fn
 * @param {any} fallback  valeur retenue quand `fn` échoue
 */
export async function mapLimited(items, limit, fn, fallback = null) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, list.length));

  let next = 0;
  async function worker() {
    while (next < list.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(list[index], index);
      } catch {
        results[index] = fallback;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
