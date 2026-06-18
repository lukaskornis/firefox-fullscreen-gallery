// Background page: fetches "next page" HTML on behalf of the content script.
// Background fetch bypasses page CORS thanks to the <all_urls> host permission.
const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "fsg-fetch") {
    return fetch(msg.url, { credentials: "include" })
      .then((r) => r.text())
      .then((html) => ({ ok: true, html }))
      .catch((err) => ({ ok: false, error: String(err) }));
  }
});
