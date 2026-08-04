// Bounded parallel traversal.
// Twitch sometimes exposes several dozen campaigns: fetching them one by one
// takes minutes, all at once gets you throttled. A small number of requests in
// flight at a time is the right compromise.
// Pure module.

/**
 * Applies `fn` to every item, at most `limit` at a time.
 * Result order follows the items, not the order they finish in.
 * A failure interrupts nothing: that item gets `fallback`, the rest carry on.
 *
 * @param {Array} items
 * @param {number} limit  maximum number of simultaneous executions
 * @param {(item:any, index:number)=>Promise<any>} fn
 * @param {any} fallback  value kept when `fn` throws
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
