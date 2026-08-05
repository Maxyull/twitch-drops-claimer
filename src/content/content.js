// Content script shim: minimal injection, isolated world.
// Classic content scripts do not know `import`, so the real module is loaded
// dynamically: it keeps the content script's context and can therefore reuse the
// pure modules in src/lib/ without duplicating them.
// No remote code is loaded, the resource ships inside the package.
import(chrome.runtime.getURL("src/content/watcher.js")).catch((err) => {
  console.error("[TDC] could not load the module", err);
});
