# Design Recommendation: "Explore Similar Images"

Status: proposal · Scope: Firefox MV2 WebExtension, vanilla JS, no deps, no build step, no bundled ML.

## Goal

Let the user, while inside the fullscreen gallery, pull in **more images visually or
contextually related to the one they're looking at** — ideally appending them seamlessly
into the running gallery via the existing background-fetch + `extractFetched(doc, base)`
pipeline, instead of opening a new tab.

## The core constraint (read this first)

The extension's entire pitch is **"100% local, no analytics, no telemetry, no external
services."** Every general-purpose reverse-image-search provider (Google Lens, Bing, Yandex,
TinEye) works by **sending the image (or its URL) to a third party**. That is a direct
violation of the privacy promise. Therefore:

- Any third-party search **must be OPT-IN and OFF by default**, behind an explicit popup
  toggle, with a one-line in-UI warning the first time it's enabled.
- The **default, always-available** behaviors must be the ones that touch **no third party**:
  same-site "more from this page/source" and in-page perceptual-hash clustering.

There is also a hard *technical* wall: the existing pipeline parses **server-rendered HTML**
with `DOMParser`. The major visual-search engines now return **JavaScript-rendered** result
pages and actively bot-detect, so a plain `fetch` returns a near-empty shell or a CAPTCHA
(see Options 1–4). This pushes us toward the same conclusion from a different angle.

---

## Options

### 1. Google Lens / "search by image"

- **URL (GET):** `https://lens.google.com/uploadbyurl?url=<IMAGE_URL>&hl=en` (the legacy
  `google.com/searchbyimage?image_url=` redirects here). It *does* accept a remote image URL
  via GET — no upload needed.
- **Fit / parse:** Poor for our pipeline. Lens results are **rendered client-side via JS**;
  a credentialed `fetch` returns a shell with no parseable `<img>` thumbnails, and Google
  bot-detects unattended requests (CAPTCHA, consent interstitials, IP bans). `DOMParser`
  over that shell yields nothing to append. Works only as an **"open in new tab"** handoff.
- **Cost:** Free to open in a tab; the only reliable *parseable* route is a paid SERP-scraper
  API (SerpApi/Bright Data/etc.) — out of scope (external service + cost).
- **Privacy:** Sends the image URL to Google; with `credentials:"include"` it's tied to the
  user's Google session. High impact.

### 2. Bing Visual Search

- **URL (GET):** `https://www.bing.com/images/searchbyimage?cbir=sbi&imgurl=<IMAGE_URL>`.
- **Fit / parse:** Same problem as Lens — results are JS-hydrated and bot-walled. Not
  reliably parseable from a background `fetch`. New-tab handoff only.
- **Cost:** Free in-tab. (The old Bing Visual Search API is effectively deprecated/retired
  alongside the Bing Search API sunset; don't build on it.)
- **Privacy:** Sends image URL to Microsoft. High impact.

### 3. TinEye

- **URL (GET):** `https://tineye.com/search?url=<IMAGE_URL>` for the web UI.
- **Fit / parse:** TinEye finds **exact/near-duplicate** matches (where else this image
  appears), **not "visually similar."** The web UI is also JS-driven and rate-limited for
  anonymous use. The official **TinEye API** returns clean JSON, but it's **commercial and
  paid** (~$200/yr for 5k searches, down to ~$0.01/search at 1M volume) and needs an API key
  — an external paid service, disqualified by the product pitch.
- **Privacy:** Sends image URL to TinEye. High impact. (Note: it returns *source pages*, not
  similar images — a different feature than what we want anyway.)

### 4. Yandex Images

- **URL (GET):** `https://yandex.com/images/search?rpt=imageview&url=<IMAGE_URL>`.
- **Fit / parse:** Historically the *best* "visually similar" results, but today it's
  JS-rendered, geo/consent-gated, and aggressive about bot detection (CAPTCHA). Not reliably
  parseable from a background `fetch`. New-tab handoff only.
- **Privacy:** Sends image URL to Yandex (a non-EU/US data jurisdiction). Highest reputational
  impact for a privacy-branded tool.

### 5. "More from this source / page" — same-site, **no third party** ✅

- **Idea:** The image and its surrounding DOM almost always link to *more* relevant images:
  the gallery/album page, the post permalink, a tag/category/"related" link, "next/older"
  pagination, or the image's own detail page. Harvest those `<a href>` candidates near the
  current image (ancestors of its `<img>`, `rel="next"`, links whose text/`href` matches
  `tag|gallery|album|related|more|category`), `fetch(url, {credentials:"include"})` them, and
  feed the returned doc straight into the **existing `extractFetched(doc, base)`** to append
  images in place.
- **Fit / parse:** Excellent — it's literally the seamless-next-page pipeline pointed at a
  *related* link instead of the *next* link. Same-origin (or at least the originating site),
  so markup shape and auth already behave the way the user expects.
- **Cost / privacy:** Zero marginal cost, **zero new third party** — the user already trusts
  the site they're browsing. Fully consistent with the privacy pitch; can ship **default ON**.
- **Caveat:** It's "related/contextual," not pixel-level "visually similar." That's an
  acceptable and honest framing.

### 6. Perceptual hashing (pHash / dHash) in-page — **no network** ✅

- **Idea:** Compute a cheap dHash/aHash (resize to 8×8 / 9×8 on a `<canvas>`, grayscale,
  compare adjacent luminances → 64-bit hash) for images **already harvested into the gallery**.
  Cluster by Hamming distance to power **dedupe** ("hide near-duplicates") and **"jump to
  visually similar"** within the current set. Pure JS + canvas, fully local.
- **Fit / parse:** Great as a *companion* to Option 5: as new images stream in from related
  fetches, hash them and cluster. ~50–150 LOC, no deps.
- **Cost / privacy:** Zero network, zero third party. Default-ON-safe.
- **Hard limit:** **Canvas cross-origin tainting.** Reading pixels (`getImageData`) from an
  image loaded cross-origin without CORS headers throws a `SecurityError`. Mitigations:
  set `img.crossOrigin = "anonymous"` and skip (graceful) any image that still taints; or
  hash only same-origin images. It clusters/dedupes *what we already have* — it does **not**
  fetch new similar images from the web.

### 7. Local CLIP embeddings (transformers.js / WASM) — **rejected**

- **Idea:** Run a small CLIP image encoder locally for true semantic similarity.
- **Assessment:** Strong privacy story, but it requires **bundling/downloading a multi-MB ML
  model + WASM runtime**, which directly violates "no dependencies, no build step, no bundled
  ML, lightweight." Cold-load and per-image inference cost are also far beyond a vanilla
  gallery's budget. **Reject** for this product. (Revisit only if the product ever adds an
  optional, separately-downloaded "power features" bundle.)

---

## Recommendation

Ship **two** features, in this order, both reusing existing machinery:

1. **"More from this page/source" (Option 5) — default ON, primary feature.**
   It's the only approach that (a) reuses the background-fetch + `extractFetched` pipeline
   verbatim, (b) appends real images seamlessly into the running gallery, (c) costs nothing,
   and (d) keeps the privacy promise intact. The major engines (Options 1–4) all fail the
   *parse* test (JS-rendered + bot-walled) **and** the *privacy* test, so they can't be the
   core experience regardless.

2. **In-page pHash dedupe/cluster (Option 6) — default ON.**
   A cheap, fully-local companion that makes Option 5 feel polished (suppress the duplicates
   that related-page fetches inevitably drag in) and enables "jump to similar within this
   gallery." No network, no third party.

3. **Optional third-party reverse search (Options 1/4) — OFF by default, "open in new tab."**
   Because we *cannot* reliably parse their results, do **not** try to append them. Instead,
   when the opt-in toggle is on, offer a key that **opens Google Lens (and optionally Yandex)
   in a new tab** with the current image URL. This is honest about the privacy cost (new tab,
   visible third party) and sidesteps the scraping/CAPTCHA arms race entirely. Degrades
   gracefully by definition — the browser renders the page, not us.

---

## Integration sketch

### Keybinding

Existing keys in use: arrows / WASD, Space, Enter, **F**, Esc, Home/End, Option+Z/X/C.
Proposed:

- **`G`** — "**G**et similar": run the default same-site "more from this page" harvest and
  append results (Options 5 + 6). Mnemonic-free but unused and easy to reach.
- **`Shift+G`** — only when the opt-in third-party toggle is ON: open the configured external
  engine(s) (Lens / Yandex) for the current image in a **new tab**. Silently no-op when the
  toggle is OFF, so the key never leaks data unexpectedly.

(`R` was avoided as a likely "rotate/reload" collision risk; `G` for "get/gather" is clear of
the listed bindings.)

### Popup toggles

Add to the popup, both persisted in `browser.storage.local`:

- `similarSameSite` (default **true**) — enable the `G` same-site harvest + pHash clustering.
- `similarThirdParty` (default **false**) — enable `Shift+G` external open-in-tab; with a
  sub-select for engine (Lens / Yandex) and an inline warning:
  *"Sends this image's URL to a third party. Off by default."*

### Message flow (same-site path — the seamless one)

```
content script (on 'G')
  → collect candidate related links near current <img>
      (ancestor <a>, rel="next", href/text ~ /tag|album|gallery|related|more|category/)
  → send {type:"FETCH_SIMILAR", urls:[...]} to background
background
  → for each url: fetch(url, {credentials:"include"}) → text()
  → reply {type:"SIMILAR_HTML", url, html}    // one per url, streamed
content script
  → DOMParser.parseFromString(html, "text/html")
  → extractFetched(doc, base)                 // EXISTING function, unchanged
  → for each new image: compute dHash, drop if Hamming-near an existing one (Option 6)
  → append survivors to the gallery in place
```

The third-party path is trivial: content script just builds the engine URL and calls
`browser.tabs.create({url})` (or `window.open`) — no fetch, no parse.

### Expected failure modes (and graceful degradation)

- **No related links found** → show a brief toast ("No related images found here"); do nothing
  destructive. Optionally fall back to re-running the existing next-page logic.
- **CORS / opaque response** → background `fetch` with `<all_urls>` host perms generally gets
  the body, but if a site returns an error/login wall, `extractFetched` yields 0 images →
  treat as "no results," don't crash.
- **Bot-wall / CAPTCHA / JS-only result page** (the third-party engines, and some hostile
  sites) → `DOMParser` finds no usable `<img>`; detect "0 extracted" and surface the toast.
  This is exactly why third-party engines are *open-in-tab only*, never parsed.
- **Canvas tainting** (Option 6) → wrap `getImageData` in try/catch; on `SecurityError`, skip
  hashing that image (it still displays, just isn't deduped).
- **Rate limiting** → cap concurrent background fetches (e.g. 2–3) and debounce repeated `G`
  presses so we don't hammer the source site.

---

## Privacy note (paste-ready for README)

> **"Explore similar images" and your privacy.** By default, the *similar images* feature
> only follows links that already exist on the page you're viewing (tags, albums, "related"
> links) and only talks to the **same website you're already on** — no third party, no
> analytics, nothing leaves your normal browsing. Optionally, you can turn on **third-party
> reverse image search** (Google Lens or Yandex). This is **off by default**; when enabled, it
> opens the chosen search engine in a new tab and **sends that image's URL to that company**.
> We never do this without you explicitly opting in, and we never silently send your images
> anywhere.

---

## Sources

- [Google Lens URL format (SerpApi)](https://serpapi.com/blog/web-scraping-google-lens-results-with-nodejs/)
- [Scraping Google Lens is JS-rendered + bot-detected (Webshare)](https://www.webshare.io/academy-article/scrape-google-lens)
- [Scrape Google Lens 2026 guide (Scrapingdog)](https://www.scrapingdog.com/blog/scrape-google-lens/)
- [Reverse image URL params for Bing/Yandex/TinEye (GitHub: lilmond)](https://github.com/lilmond/Reverse-Image-Search)
- [Yandex reverse image (searchapi.io)](https://www.searchapi.io/yandex-reverse-image-api)
- [TinEye API commercial pricing (TinEye blog)](https://blog.tineye.com/new-image-search-pricing/)
