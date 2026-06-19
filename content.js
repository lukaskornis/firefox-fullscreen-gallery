(() => {
  "use strict";
  const api = typeof browser !== "undefined" ? browser : chrome;

  if (window.__fsGalleryLoaded) {
    if (window.__fsGalleryToggle) window.__fsGalleryToggle();
    return;
  }
  window.__fsGalleryLoaded = true;

  // ---- Tuning ----------------------------------------------------------------
  const MIN_SIDE = 140;
  const MIN_AREA = 140 * 140;
  const JUNK_RE = /\b(logo|icon|sprite|avatar|emoji|emoticon|badge|favicon|spinner|loader|pixel|tracking|button|arrow|bullet|star-rating)\b/i;
  const IMG_URL_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)(\?|#|$)/i;
  const FULL_ATTRS = [
    "data-full", "data-full-src", "data-original", "data-large",
    "data-large_image", "data-zoom-image", "data-image", "data-src-large",
    "data-hires", "data-old-hires"
  ];
  const RESUME_KEY = "__fsGalleryResume";
  const STORE_KEY = "fsgLiked";
  const SETTINGS_KEY = "fsgSettings";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The gallery always opens on a text-only welcome card (no image) at index 0.
  const makeWelcome = () => ({ welcome: true, full: "", thumb: "" });

  // ---- Settings (synced live from the popup) ---------------------------------
  let settings = { lettersNav: true, optionShortcuts: true, autoLikeNext: false, hideGraphics: true };
  async function loadSettings() {
    try {
      const r = await api.storage.local.get(SETTINGS_KEY);
      if (r[SETTINGS_KEY]) settings = Object.assign(settings, r[SETTINGS_KEY]);
    } catch (_) { /* ignore */ }
  }

  // ---- Liked / locally-saved store -------------------------------------------
  let likedList = [];
  let likedKeys = new Set();
  async function loadLiked() {
    try {
      const r = await api.storage.local.get(STORE_KEY);
      likedList = Array.isArray(r[STORE_KEY]) ? r[STORE_KEY] : [];
    } catch (_) { likedList = []; }
    likedKeys = new Set(likedList.map((i) => i.full));
  }
  function persistLiked() { return api.storage.local.set({ [STORE_KEY]: likedList }).catch(() => {}); }
  function isLiked(full) { return likedKeys.has(full); }
  function likeItem(item) {
    if (likedKeys.has(item.full)) return false;
    likedKeys.add(item.full);
    likedList.push({
      full: item.full, thumb: item.thumb || item.full,
      pageHref: item.pageHref || null, source: location.href,
      title: document.title, savedAt: Date.now()
    });
    persistLiked();
    return true;
  }
  function unlikeItem(item) {
    if (!likedKeys.has(item.full)) return false;
    likedKeys.delete(item.full);
    likedList = likedList.filter((i) => i.full !== item.full);
    persistLiked();
    return true;
  }
  function clearLiked() {
    likedList = []; likedKeys = new Set();
    persistLiked();
    if (window.__fsGalleryInstance && window.__fsGalleryInstance.isLocal) window.__fsGalleryInstance.close();
  }

  // Keep in-memory state live when the popup changes storage.
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
      settings = Object.assign({ lettersNav: true, optionShortcuts: true, autoLikeNext: false, hideGraphics: true }, changes[SETTINGS_KEY].newValue);
    }
    if (changes[STORE_KEY]) {
      const v = changes[STORE_KEY].newValue;
      likedList = Array.isArray(v) ? v : [];
      likedKeys = new Set(likedList.map((i) => i.full));
      if (likedList.length === 0 && window.__fsGalleryInstance && window.__fsGalleryInstance.isLocal) {
        window.__fsGalleryInstance.close();
      }
    }
  });

  // ---- Shared discovery helpers ---------------------------------------------
  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null, bestScore = -1;
    for (const part of srcset.split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const segs = piece.split(/\s+/);
      const url = segs[0];
      const desc = segs[1] || "";
      let score = 1;
      if (/(\d+)w$/.test(desc)) score = parseInt(desc, 10);
      else if (/([\d.]+)x$/.test(desc)) score = parseFloat(desc) * 1000;
      if (score > bestScore) { bestScore = score; best = url; }
    }
    return best;
  }
  // Search engines (Google/Bing/DDG) wrap results in a redirect whose real image
  // and source page sit in query params — e.g. /imgres?imgurl=...&imgrefurl=...
  const IMG_PARAMS = ["imgurl", "mediaurl", "imageurl", "image_url"];
  const PAGE_PARAMS = ["imgrefurl", "ru"];
  function unwrapParam(href, keys) {
    try {
      const u = new URL(href, location.href);
      for (const k of keys) {
        const v = u.searchParams.get(k);
        if (v) return v;
      }
    } catch (_) { /* malformed */ }
    return null;
  }
  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (_) { return false; }
  }

  function looksLikeJunk(node, src) {
    const haystack = `${node.className || ""} ${node.id || ""} ${node.getAttribute ? (node.getAttribute("alt") || "") : ""} ${src}`;
    return JUNK_RE.test(haystack);
  }
  // A card's navigable page — but NOT when it points straight at an image file
  // (navigating there just opens a raw image and breaks the gallery; the image is
  // already shown as the current item's full source).
  function anchorPage(el, base) {
    const a = el.closest && el.closest("a[href]");
    if (!a) return null;
    let href;
    try { href = new URL(a.getAttribute("href"), base).href; } catch (_) { return null; }
    const ref = unwrapParam(href, PAGE_PARAMS);      // search-result wrapper → source page
    if (ref) return /^https?:/i.test(ref) ? ref : null;
    if (!/^https?:/i.test(href)) return null;
    if (IMG_URL_RE.test(href)) return null;          // direct image → not a page
    if (unwrapParam(href, IMG_PARAMS)) return null;  // image wrapper handled by fullSrc
    if (href === base || href === base.split("#")[0] + "#") return null;
    return href;
  }

  // ---- Graphic vs. photo heuristics (lightweight, no ML) ---------------------
  const CHROME_SEL = "nav, footer, [role='navigation'], [role='contentinfo']";

  // Sample alpha via a tiny canvas. Returns true (transparent) / false (opaque) /
  // null (can't tell — cross-origin taint or not yet decoded). JPEG can't have alpha.
  function hasTransparency(img) {
    const s = (img.currentSrc || img.src || "").toLowerCase();
    if (/\.jpe?g(\?|#|$)/.test(s)) return false;
    if (!img.complete || !img.naturalWidth) return null;
    try {
      const cw = Math.min(48, img.naturalWidth);
      const ch = Math.min(48, img.naturalHeight);
      const cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      let clear = 0;
      for (let p = 3; p < data.length; p += 4) if (data[p] < 250) clear++;
      return clear / (cw * ch) > 0.08; // >8% see-through → treat as graphic
    } catch (_) {
      return null; // tainted canvas
    }
  }

  // True when the node looks like page chrome / a vector graphic rather than a photo.
  function looksLikeGraphic(node, src) {
    if (/\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/i.test(src)) return true;
    if (node.closest && node.closest(CHROME_SEL)) return true;
    if (node.tagName === "IMG" && hasTransparency(node) === true) return true;
    return false;
  }

  // ---- Discovery on the LIVE page --------------------------------------------
  function thumbSrc(img) {
    return img.currentSrc || largestFromSrcset(img.getAttribute("srcset")) || img.src
      || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || null;
  }
  function fullSrc(img, thumb) {
    const candidates = [];
    for (const attr of FULL_ATTRS) {
      const v = img.getAttribute(attr);
      if (v) candidates.push(v);
    }
    const anchor = img.closest("a[href]");
    if (anchor) {
      const wrapped = unwrapParam(anchor.href, IMG_PARAMS);     // Google/Bing real image
      if (wrapped) candidates.unshift(wrapped);                 // highest priority
      else if (IMG_URL_RE.test(anchor.href)) candidates.push(anchor.href);
    }
    const big = largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    if (big) candidates.push(big);
    for (const c of candidates) {
      try {
        const abs = new URL(c, location.href).href;
        if (abs && abs !== thumb) return abs;
      } catch (_) { /* malformed */ }
    }
    return null;
  }
  function collectImages(seen) {
    const out = [];
    for (const img of document.images) {
      const src = thumbSrc(img);
      if (!src) continue;
      if (looksLikeJunk(img, src)) continue;
      if (settings.hideGraphics && looksLikeGraphic(img, src)) continue;
      const rect = img.getBoundingClientRect();
      const w = Math.max(rect.width, img.naturalWidth || 0);
      const h = Math.max(rect.height, img.naturalHeight || 0);
      if (w < MIN_SIDE || h < MIN_SIDE) continue;
      if (w * h < MIN_AREA) continue;
      const full = fullSrc(img, src) || src;
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ thumb: src, full, area: w * h, pageHref: anchorPage(img, location.href), el: img });
    }
    for (const el of document.querySelectorAll("*")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none") continue;
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (!m) continue;
      let abs;
      try { abs = new URL(m[1], location.href).href; } catch (_) { continue; }
      if (!IMG_URL_RE.test(abs) && !/^data:image\//.test(abs)) continue;
      if (looksLikeJunk(el, abs)) continue;
      if (settings.hideGraphics && looksLikeGraphic(el, abs)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ thumb: abs, full: abs, area: rect.width * rect.height, pageHref: anchorPage(el, location.href), el });
    }
    return out;
  }

  // ---- Discovery on a FETCHED page -------------------------------------------
  // A fetched document is never rendered, so lazy-loaded <img> tags still hold a
  // placeholder in src (blank gif / data-URI / "loading" image) with the real URL in
  // data-* / srcset. Grabbing src first appends those placeholders → black images.
  const PLACEHOLDER_RE = /(^data:image\/(gif|svg)|\b(blank|spacer|placeholder|lazy|loading|transparent|1x1|pixel|grey|gray|dummy)\b)/i;
  const LAZY_ATTRS = [
    "data-src", "data-original", "data-lazy-src", "data-lazy", "data-url",
    "data-image", "data-hi-res", "data-actualsrc", "data-echo", "data-flickity-lazyload"
  ];
  function bestFetchedSrc(img, abs) {
    const cands = [];
    for (const a of FULL_ATTRS) { const v = img.getAttribute(a); if (v) cands.push(v); }
    for (const a of LAZY_ATTRS) { const v = img.getAttribute(a); if (v) cands.push(v); }
    const ss = largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    if (ss) cands.push(ss);
    const raw = img.getAttribute("src");
    if (raw && !PLACEHOLDER_RE.test(raw)) cands.push(raw);      // real src, not a placeholder
    if (raw && PLACEHOLDER_RE.test(raw)) cands.push(raw);       // last resort if nothing else
    for (const c of cands) {
      const u = abs(c);
      if (u && !PLACEHOLDER_RE.test(u)) return u;
    }
    return abs(raw);
  }
  function extractFetched(doc, base) {
    const out = [];
    const abs = (u) => { if (!u) return null; try { return new URL(u, base).href; } catch (_) { return null; } };
    for (const img of doc.querySelectorAll("img")) {
      const src = bestFetchedSrc(img, abs);
      if (!src || PLACEHOLDER_RE.test(src)) continue;            // skip pure placeholders
      if (looksLikeJunk(img, src)) continue;
      const w = parseInt(img.getAttribute("width"), 10) || 0;
      const h = parseInt(img.getAttribute("height"), 10) || 0;
      if ((w && w < MIN_SIDE) || (h && h < MIN_SIDE)) continue;
      let full = null;
      for (const attr of FULL_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) { full = abs(v); if (full && !PLACEHOLDER_RE.test(full)) break; full = null; }
      }
      const anchor = img.closest("a[href]");
      const ah = anchor ? abs(anchor.getAttribute("href")) : null;
      const wrapped = ah ? unwrapParam(ah, IMG_PARAMS) : null;
      if (!full && wrapped) full = wrapped;
      if (!full && ah && IMG_URL_RE.test(ah)) full = ah;
      if (!full) {
        const big = abs(largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")));
        if (big && !PLACEHOLDER_RE.test(big)) full = big;
      }
      full = full || src;
      let pageHref = null;
      if (ah) {
        const ref = unwrapParam(ah, PAGE_PARAMS);
        if (ref && /^https?:/i.test(ref)) pageHref = ref;
        else if (/^https?:/i.test(ah) && !IMG_URL_RE.test(ah) && !wrapped && ah !== base) pageHref = ah;
      }
      out.push({ thumb: src, full, area: w * h, pageHref });
    }
    return out;
  }

  // Find a site's "next page" / pagination link in a (live or fetched) document.
  const NEXT_TEXT_RE = /^(next|older|more|load more|»|›|>>|→|›|»)$/i;
  function findNextLink(doc, base) {
    const abs = (u) => { if (!u) return null; try { return new URL(u, base).href; } catch (_) { return null; } };
    const sel = "a[rel~='next'], link[rel='next'], a.next, .next > a, .pagination .next a, " +
      "li.next a, a.pagination-next, a[aria-label*='next' i], a[aria-label*='older' i]";
    const direct = doc.querySelector(sel);
    if (direct) { const h = abs(direct.getAttribute("href")); if (h && /^https?:/i.test(h) && h !== base) return h; }
    for (const a of doc.querySelectorAll("a[href]")) {
      const t = (a.textContent || "").trim();
      if (t.length <= 12 && NEXT_TEXT_RE.test(t)) {
        const h = abs(a.getAttribute("href"));
        if (h && /^https?:/i.test(h) && h !== base) return h;
      }
    }
    return null;
  }

  // ---- Gallery UI ------------------------------------------------------------
  function buildGallery(images, seen, opts) {
    opts = opts || {};
    const host = document.createElement("div");
    host.id = "fs-gallery-host";
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .overlay { position: fixed; inset: 0; background: #0b0b0d; display: flex;
          flex-direction: column; font-family: system-ui, sans-serif; user-select: none; }
        .stage { flex: 1; position: relative; display: flex; align-items: center;
          justify-content: center; overflow: hidden; }
        /* Blurred zoomed copy fills the whole screen behind the contained image. */
        .backdrop { position: absolute; inset: 0; background-position: center;
          background-size: cover; filter: blur(34px) brightness(.42) saturate(1.15);
          transform: scale(1.12); }
        .stage img { position: relative; z-index: 1; width: 100%; height: 100%;
          object-fit: contain; transition: opacity .15s ease; }
        .spinner { position: absolute; z-index: 3; width: 46px; height: 46px;
          border: 4px solid rgba(255,255,255,.18); border-top-color: rgba(255,255,255,.85);
          border-radius: 50%; animation: spin .8s linear infinite; opacity: 0; pointer-events: none; }
        .spinner.show { opacity: 1; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .welcome { position: absolute; z-index: 3; inset: 0; display: none; flex-direction: column;
          align-items: center; justify-content: center; text-align: center; gap: 16px; padding: 40px; }
        .welcome.show { display: flex; }
        .welcome h2 { font-size: clamp(30px, 5vw, 58px); font-weight: 650; letter-spacing: .5px;
          color: #fff; text-shadow: 0 4px 30px rgba(0,0,0,.6); }
        .welcome p { font-size: 15px; line-height: 1.7; color: #9aa3b2; max-width: 560px; }
        .welcome kbd { font-family: ui-monospace, monospace; font-size: 12px; color: #cfe0ff;
          background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14);
          border-radius: 5px; padding: 1px 6px; margin: 0 1px; }
        .flash { position: absolute; z-index: 4; font-size: 130px; line-height: 1; opacity: 0;
          pointer-events: none; text-shadow: 0 6px 30px rgba(0,0,0,.7); }
        .flash.show { animation: pop .6s ease; }
        @keyframes pop { 0% { opacity: 0; transform: scale(.5); }
          30% { opacity: .95; transform: scale(1.15); } 100% { opacity: 0; transform: scale(1); } }
        .nav { position: absolute; z-index: 2; top: 0; bottom: 0; width: 16%; display: flex;
          align-items: center; border: none; cursor: pointer; background: transparent; color: #fff;
          font-size: 48px; opacity: 0; transition: opacity .15s, background .15s; }
        .nav:hover { opacity: 1; background: rgba(255,255,255,.05); }
        .nav.prev { left: 0; justify-content: flex-start; padding-left: 24px; }
        .nav.next { right: 0; justify-content: flex-end; padding-right: 24px; }
        .topbar { position: absolute; z-index: 5; top: 0; left: 0; right: 0; display: flex;
          align-items: center; gap: 12px; padding: 12px 16px; color: #eee; font-size: 13px;
          opacity: .22; transition: opacity .2s; background: linear-gradient(rgba(0,0,0,.55), transparent); }
        .topbar:hover { opacity: 1; }
        .counter { font-variant-numeric: tabular-nums; letter-spacing: .5px; min-width: 90px; }
        .spacer { flex: 1; }
        .heart { font-size: 20px; cursor: pointer; background: none; border: none; color: #ddd; padding: 0 4px; }
        .openlink, .close, .visit, .fs, .gopage, .shuffle { color: #ddd; text-decoration: none; cursor: pointer;
          background: rgba(255,255,255,.08); border: none; padding: 6px 12px; border-radius: 6px;
          font-size: 13px; white-space: nowrap; }
        .openlink:hover, .close:hover, .visit:hover, .fs:hover, .gopage:hover, .shuffle:hover { background: rgba(255,255,255,.2); color: #fff; }
        .shuffle.on { background: rgba(76,141,255,.4); color: #fff; }
        .visit { background: rgba(76,141,255,.22); color: #cfe0ff; }
        .visit:hover { background: rgba(76,141,255,.4); color: #fff; }
        .visit[hidden], .gopage[hidden] { display: none; }
      </style>
      <div class="overlay">
        <div class="topbar">
          <span class="counter"></span>
          <button class="heart" title="Like / save (Space)">♡</button>
          <span class="spacer"></span>
          <a class="visit" title="Next page (Enter / ↑)">Next page ↵</a>
          <a class="gopage" title="Open this image's page in this tab (O)">Open page ⤴</a>
          <a class="openlink" target="_blank" rel="noopener">Open image ↗</a>
          <button class="shuffle" title="Random mode (Option+R)">🔀</button>
          <button class="fs" title="Toggle fullscreen (F)">⛶</button>
          <button class="close" title="Close (Esc)">✕</button>
        </div>
        <div class="stage">
          <div class="backdrop"></div>
          <button class="nav prev" title="Previous (← / A)">‹</button>
          <img class="main" alt="">
          <div class="welcome">
            <h2>Welcome to the gallery</h2>
            <p><kbd>→</kbd> <kbd>←</kbd> browse &nbsp;·&nbsp; <kbd>Space</kbd> like &nbsp;·&nbsp;
              <kbd>↑</kbd> like + next page &nbsp;·&nbsp; <kbd>Enter</kbd> next page &nbsp;·&nbsp;
              <kbd>F</kbd> fullscreen &nbsp;·&nbsp; <kbd>Esc</kbd> close</p>
          </div>
          <div class="spinner"></div>
          <div class="flash"></div>
          <button class="nav next" title="Next (→ / D)">›</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const q = (sel) => root.querySelector(sel);
    const mainImg = q(".main");
    const backdrop = q(".backdrop");
    const spinner = q(".spinner");
    const flashEl = q(".flash");
    const counter = q(".counter");
    const heartEl = q(".heart");
    const openLink = q(".openlink");
    const visitLink = q(".visit");
    const goPageLink = q(".gopage");
    const welcomeEl = q(".welcome");
    const shuffleBtn = q(".shuffle");
    const stage = q(".stage");

    let index = 0;
    let random = false;
    let lastDomEl = null;
    let loadToken = 0;
    let flashTimer = 0;
    const originalScrollY = window.scrollY;
    const pageStack = [];   // return points for going back a page: { idx, prevUrl }

    function flash(sym) {
      flashEl.textContent = sym;
      flashEl.classList.remove("show");
      void flashEl.offsetWidth;
      flashEl.classList.add("show");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashEl.classList.remove("show"), 650);
    }

    // Cheap, ML-free artifact masking: when an image is scaled up a lot, a tiny blur
    // plus slight contrast/saturation hides JPEG blocks and pixel edges.
    function refineImage() {
      const nw = mainImg.naturalWidth, nh = mainImg.naturalHeight;
      const src = mainImg.currentSrc || mainImg.src;
      if (src) backdrop.style.backgroundImage = `url("${src}")`;
      if (!nw || !nh) { mainImg.style.filter = ""; return; }
      const scale = Math.min(stage.clientWidth / nw, stage.clientHeight / nh);
      if (scale > 1.4) {
        const b = Math.min((scale - 1) * 0.35, 1.3);
        mainImg.style.filter = `blur(${b.toFixed(2)}px) contrast(1.04) saturate(1.05)`;
      } else {
        mainImg.style.filter = "";
      }
    }
    mainImg.addEventListener("load", refineImage);

    // --- True fullscreen ---
    let fsTried = false;
    function ensureFullscreen() {
      if (fsTried || document.fullscreenElement) return;
      fsTried = true;
      if (host.requestFullscreen) host.requestFullscreen().catch(() => {});
    }
    function toggleFullscreen() {
      fsTried = true;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (host.requestFullscreen) host.requestFullscreen().catch(() => {});
    }

    // --- Like actions ---
    function refreshHeart() {
      const liked = isLiked(images[index].full);
      heartEl.textContent = liked ? "♥" : "♡";
      heartEl.style.color = liked ? "#ff5a7a" : "#ddd";
    }
    function like() { if (images[index].welcome) return; likeItem(images[index]); flash("♥"); refreshHeart(); }
    function unlike() { unlikeItem(images[index]); flash("🤍"); refreshHeart(); }
    function toggleLike() {
      const item = images[index];
      if (item.welcome) return;
      if (isLiked(item.full)) { unlikeItem(item); flash("🤍"); }
      else { likeItem(item); flash("♥"); }
      refreshHeart();
    }

    // --- Lazy harvesting on the current page ---
    let scanY = window.scrollY, scanning = false, exhausted = !!opts.local;
    async function loadMore() {
      if (scanning || exhausted) return;
      scanning = true;
      const before = images.length;
      const step = Math.max(400, window.innerHeight * 0.9);
      let atBottomStreak = 0;
      for (let pass = 0; pass < 12; pass++) {
        const docH = document.documentElement.scrollHeight;
        scanY = Math.min(scanY + step, docH);
        window.scrollTo(0, scanY);
        await sleep(130);
        collectImages(seen).forEach((it) => images.push(it));
        if (images.length > before) counter.textContent = `${index + 1} / ${images.length}`;
        if (scanY >= docH - window.innerHeight - 2) {
          if (++atBottomStreak >= 2) { exhausted = true; break; }
        } else atBottomStreak = 0;
      }
      scanning = false;
    }

    // --- Seamless next page (only ever targets real HTML pages, never raw images) ---
    // Candidates, in priority order: the image's own detail/card page, the page it was
    // saved from (for the favorites gallery), then the site's pagination "next" link.
    // We only *enter* a page that yields MORE THAN ONE fresh gallery image, so single-image
    // detail/dead-end pages are skipped and we fall through to the next candidate.
    let fetching = false;
    let pagesExhausted = false;
    const triedPages = new Set();
    let pageCursor = opts.local ? null : findNextLink(document, location.href);
    // A page we entered seamlessly (background fetch) is NOT rendered, so its lazy-loaded
    // images never appeared. When we run dry on it we real-navigate here to render them.
    let pendingLiveUrl = null;

    async function fetchGallery(url) {
      const resp = await api.runtime.sendMessage({ type: "fsg-fetch", url });
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || "fetch failed");
      const doc = new DOMParser().parseFromString(resp.html, "text/html");
      const fresh = extractFetched(doc, url).filter((it) => !seen.has(it.full));
      return { doc, fresh };
    }
    function transientCounter(msg) {
      counter.textContent = msg;
      setTimeout(() => { if (counter.textContent === msg) counter.textContent = `${index + 1} / ${images.length}`; }, 1300);
    }

    async function loadNextPage(o) {
      const auto = !!(o && o.auto);                            // auto = reached the end, not a keypress
      if (fetching) return false;
      const item = images[index];
      if (settings.autoLikeNext && !opts.local && !auto) { likeItem(item); refreshHeart(); }
      const candidates = [];
      const add = (u) => { if (u && /^https?:/i.test(u) && !triedPages.has(u) && !candidates.includes(u)) candidates.push(u); };
      add(item.pageHref);
      add(item.source);
      add(pageCursor);
      if (!candidates.length) {
        pagesExhausted = true;
        if (!auto) transientCounter("No next page from here");
        return false;
      }

      fetching = true;
      const restore = `${index + 1} / ${images.length}`;
      counter.textContent = "Loading next page…";
      try {
        for (const url of candidates) {
          triedPages.add(url);
          let res;
          try { res = await fetchGallery(url); } catch (_) { continue; }
          if (res.fresh.length > 1) {                          // a real gallery → enter it
            const startIdx = images.length;
            pageStack.push({ idx: index, prevUrl: location.href });   // remember where we left off
            for (const it of res.fresh) { seen.add(it.full); images.push(it); }
            pageCursor = findNextLink(res.doc, url);            // keep paginating from here
            try { history.pushState(null, "", url); } catch (_) { /* cross-origin: address bar stays */ }
            pendingLiveUrl = url;                               // its lazy images still await a real render
            show(startIdx);
            return true;
          }
          const np = findNextLink(res.doc, url);               // thin page; remember its next link
          if (np && !triedPages.has(np)) pageCursor = np;
        }
        // tried everything we knew about; only truly exhausted if no fresh cursor surfaced
        pagesExhausted = !pageCursor || triedPages.has(pageCursor);
        counter.textContent = restore;
        if (!auto) transientCounter("No further gallery pages");
        return false;
      } finally {
        fetching = false;
      }
    }

    // Validate the next gallery page seamlessly (must hold >1 fresh image) and return its
    // URL WITHOUT entering it — the caller real-navigates there so the browser renders the
    // page and its lazy-loaders actually run (a background-fetched doc never does).
    async function findLiveNextTarget() {
      if (fetching) return null;
      const item = images[index];
      const candidates = [];
      const add = (u) => { if (u && /^https?:/i.test(u) && !triedPages.has(u) && !candidates.includes(u)) candidates.push(u); };
      add(item.pageHref); add(item.source); add(pageCursor);
      if (!candidates.length) { pagesExhausted = true; return null; }
      fetching = true;
      try {
        for (const url of candidates) {
          triedPages.add(url);
          let res;
          try { res = await fetchGallery(url); } catch (_) { continue; }
          if (res.fresh.length > 1) return url;
          const np = findNextLink(res.doc, url);
          if (np && !triedPages.has(np)) pageCursor = np;
        }
        pagesExhausted = !pageCursor || triedPages.has(pageCursor);
        return null;
      } finally { fetching = false; }
    }

    // Real same-tab navigation to a page so it renders fully (lazy images load), stashing a
    // resume marker so the gallery reopens on the image we left off (same-origin only —
    // sessionStorage is per-origin, so a cross-origin jump just lands without auto-reopening).
    function goLiveAndResume(url) {
      if (!url || !/^https?:/i.test(url)) return false;
      try {
        const at = images[index] ? images[index].full : null;
        if (sameOrigin(url)) sessionStorage.setItem(RESUME_KEY, JSON.stringify({ at }));
      } catch (_) { /* storage blocked */ }
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.location.assign(url);
      return true;
    }

    // Reaching the end: first exhaust this (live) page's lazy-loaders. If we're sitting on a
    // page we entered seamlessly, render it for real so ITS lazy images load. Otherwise find
    // the next gallery page and travel there for real — so browsing continues, lazy-load-aware.
    let extending = false;
    async function autoExtend() {
      if (extending || fetching) return;
      extending = true;
      try {
        const before = images.length;
        await loadMore();                                      // scroll-harvest the live page
        if (images.length > before) return;                   // found more locally; good for now
        if (pendingLiveUrl && sameOrigin(pendingLiveUrl)) {    // seamless page → render it live
          const url = pendingLiveUrl; pendingLiveUrl = null;
          if (goLiveAndResume(url)) return;
        }
        if (pagesExhausted) return;
        const target = await findLiveNextTarget();
        if (!target) return;
        if (sameOrigin(target)) { goLiveAndResume(target); return; }
        transientCounter("Next page is on another site — press O to open it");
        pagesExhausted = true;                                 // don't yank the user cross-origin on autopilot
      } finally {
        extending = false;
      }
    }

    function show(i) {
      index = (i + images.length) % images.length;
      const item = images[index];
      ++loadToken;                                   // cancel any in-flight hi-res load
      if (item.welcome) {                            // text-only welcome card — no image visible
        welcomeEl.classList.add("show");
        mainImg.removeAttribute("src");
        mainImg.style.opacity = "0";
        mainImg.style.filter = "";
        backdrop.style.backgroundImage = "";
        spinner.classList.remove("show");
        counter.textContent = "Welcome";
        heartEl.style.visibility = "hidden";
        openLink.style.visibility = "hidden";
        visitLink.hidden = true;
        goPageLink.hidden = true;
        preload(index + 1);
        return;
      }
      welcomeEl.classList.remove("show");
      heartEl.style.visibility = "";
      openLink.style.visibility = "";
      if (item.el && item.el.isConnected) lastDomEl = item.el;
      const token = loadToken;
      counter.textContent = `${index + 1} / ${images.length}`;
      openLink.href = item.full;
      const nextTarget = item.pageHref || item.source || pageCursor;
      if (nextTarget) { visitLink.href = nextTarget; visitLink.hidden = false; }
      else { visitLink.removeAttribute("href"); visitLink.hidden = true; }
      const pageTarget = item.pageHref || item.source;          // this image's own page (not pagination)
      if (pageTarget && /^https?:/i.test(pageTarget)) { goPageLink.href = pageTarget; goPageLink.hidden = false; }
      else { goPageLink.removeAttribute("href"); goPageLink.hidden = true; }
      refreshHeart();

      mainImg.style.opacity = ".55";
      mainImg.src = item.thumb || item.full;
      if (item.full && item.full !== item.thumb) {
        spinner.classList.add("show");
        const hi = new Image();
        hi.onload = () => { if (token === loadToken) { mainImg.src = item.full; mainImg.style.opacity = "1"; spinner.classList.remove("show"); } };
        hi.onerror = () => { if (token === loadToken) { mainImg.style.opacity = "1"; spinner.classList.remove("show"); } };
        hi.src = item.full;
      } else {
        mainImg.style.opacity = "1";
      }
      preload(index + 1);
      preload(index - 1);
      if (index >= images.length - 3) autoExtend();
    }
    function preload(i) {
      const item = images[(i + images.length) % images.length];
      if (item && item.full && !item.welcome) new Image().src = item.full;
    }

    // Random ("shuffle") mode: advancing jumps to a random image (never the welcome card at 0).
    function randomIndex() {
      if (images.length <= 2) return Math.min(1, images.length - 1);
      let r;
      do { r = 1 + Math.floor(Math.random() * (images.length - 1)); } while (r === index);
      return r;
    }
    function toggleRandom() {
      random = !random;
      shuffleBtn.classList.toggle("on", random);
      flash(random ? "🔀" : "➡️");
      if (random) show(randomIndex());
    }

    const next = () => { ensureFullscreen(); show(random ? randomIndex() : index + 1); };
    const prev = () => { ensureFullscreen(); show(random ? randomIndex() : index - 1); };
    const up = () => { ensureFullscreen(); like(); loadNextPage(); };
    // Down / S: step back a page if we've traversed forward — resume on the image we left on
    // (and restore that page's address bar); otherwise just go to the previous image.
    const down = () => {
      ensureFullscreen();
      if (!pageStack.length) { show(index - 1); return; }
      const { idx, prevUrl } = pageStack.pop();
      try { history.pushState(null, "", prevUrl); } catch (_) { /* cross-origin */ }
      // Back on a still-fetched page → its lazy images await a live render; back on the
      // original (live) page → nothing pending.
      pendingLiveUrl = pageStack.length ? prevUrl : null;
      show(idx);
    };

    // Real same-tab navigation to this image's own page (e.g. from a saved favorite,
    // jump to the actual page that holds the picture / its gallery).
    function navigateToPage() {
      const item = images[index];
      const url = item.pageHref || item.source;
      if (!url || !/^https?:/i.test(url)) return;
      // Reopen the gallery automatically only when the destination shares our origin
      // (sessionStorage is per-origin; setting it before a cross-origin jump would just
      // leave a stale flag on the page we're leaving).
      try {
        if (sameOrigin(url)) sessionStorage.setItem(RESUME_KEY, JSON.stringify({ at: item.full }));
      } catch (_) { /* malformed / blocked */ }
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); }
      window.location.assign(url);
    }

    q(".next").addEventListener("click", next);
    q(".prev").addEventListener("click", prev);
    q(".fs").addEventListener("click", toggleFullscreen);
    shuffleBtn.addEventListener("click", toggleRandom);
    q(".close").addEventListener("click", close);
    heartEl.addEventListener("click", () => toggleLike());
    visitLink.addEventListener("click", (e) => { e.preventDefault(); loadNextPage(); });
    goPageLink.addEventListener("click", (e) => { e.preventDefault(); navigateToPage(); });

    stage.addEventListener("wheel", (e) => { e.preventDefault(); if (e.deltaY > 0) next(); else prev(); }, { passive: false });
    stage.addEventListener("click", (e) => { if (e.target === stage || e.target === backdrop) close(); });

    function onKey(e) {
      if (e.altKey) return; // Option combos belong to the global listener
      const code = e.code;
      const L = settings.lettersNav;
      if (e.key === "ArrowRight" || (L && code === "KeyD")) { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft" || (L && code === "KeyA")) { e.preventDefault(); prev(); }
      else if (e.key === "ArrowUp" || (L && code === "KeyW")) { e.preventDefault(); up(); }
      else if (e.key === "ArrowDown" || (L && code === "KeyS")) { e.preventDefault(); down(); }
      else if (e.key === " ") { e.preventDefault(); toggleLike(); }
      else if (e.key === "Enter") { e.preventDefault(); loadNextPage(); }
      else if (code === "KeyO") { e.preventDefault(); navigateToPage(); }
      else if (code === "KeyF") { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === "Escape") { if (!document.fullscreenElement) close(); }
      else if (e.key === "Home") { show(0); }
      else if (e.key === "End") { show(images.length - 1); }
    }
    document.addEventListener("keydown", onKey, true);

    function close() {
      document.removeEventListener("keydown", onKey, true);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      host.remove();
      if (lastDomEl && lastDomEl.isConnected) lastDomEl.scrollIntoView({ block: "center", inline: "center" });
      else window.scrollTo(0, originalScrollY);
      window.__fsGalleryInstance = null;
    }

    show(opts.startIndex || 0);
    if (host.requestFullscreen) host.requestFullscreen().catch(() => {}); // fullscreen by default
    return { close, show, isLocal: !!opts.local, toggleRandom };
  }

  function buildEmpty(message) {
    const host = document.createElement("div");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <div style="position:fixed;inset:0;background:#0b0b0d;display:flex;align-items:center;
                  justify-content:center;flex-direction:column;gap:18px;
                  font-family:system-ui,sans-serif;color:#bbb;text-align:center;padding:24px;">
        <div style="font-size:18px;max-width:600px;">${message}</div>
        <button style="cursor:pointer;background:#222;color:#eee;border:1px solid #444;
                       padding:8px 16px;border-radius:6px;font-size:14px;">Close</button>
      </div>`;
    document.documentElement.appendChild(host);
    const finish = () => { host.remove(); window.__fsGalleryInstance = null; };
    root.querySelector("button").addEventListener("click", finish);
    const onKey = (e) => { if (e.key === "Escape") { document.removeEventListener("keydown", onKey, true); finish(); } };
    document.addEventListener("keydown", onKey, true);
    return { close: finish, show() {}, isLocal: false };
  }

  // ---- Open / toggle ---------------------------------------------------------
  function openGallery(resumeAt) {
    if (window.__fsGalleryInstance) return;
    const seen = new Set();
    const real = collectImages(seen);
    if (!real.length) { window.__fsGalleryInstance = buildEmpty("No gallery-worthy images found on this page."); return; }
    const images = [makeWelcome(), ...real];          // welcome card always first
    let start = 0;                                     // open on the welcome card (no image visible)
    if (resumeAt) {                                    // resumed after a real next-page navigation
      const i = images.findIndex((im) => im.full === resumeAt);
      if (i >= 0) start = i;                           // land on the image we left off
    }
    window.__fsGalleryInstance = buildGallery(images, seen, { startIndex: start });
  }
  function openLocalGallery() {
    if (window.__fsGalleryInstance) window.__fsGalleryInstance.close();
    const real = likedList.map((i) => ({ thumb: i.thumb || i.full, full: i.full, area: 0, pageHref: i.pageHref, source: i.source }));
    if (!real.length) {
      window.__fsGalleryInstance = buildEmpty("Your saved gallery is empty. Press Space (or ↑) on images to save them, then reopen with Option+X.");
      return;
    }
    const images = [makeWelcome(), ...real];
    const seen = new Set(real.map((i) => i.full));
    window.__fsGalleryInstance = buildGallery(images, seen, { local: true, startIndex: 0 });
  }
  function toggleGallery() {
    if (window.__fsGalleryInstance) window.__fsGalleryInstance.close();
    else openGallery();
  }
  window.__fsGalleryToggle = toggleGallery;

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "fsg-toggle") toggleGallery();
    else if (msg.type === "fsg-open") openGallery();
    else if (msg.type === "fsg-local") openLocalGallery();
  });

  // Global Option shortcuts (e.code because macOS Option+letter mangles e.key).
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || !settings.optionShortcuts) return;
    if (e.code === "KeyZ") { e.preventDefault(); toggleGallery(); }
    else if (e.code === "KeyX") { e.preventDefault(); openLocalGallery(); }
    else if (e.code === "KeyC") { e.preventDefault(); clearLiked(); }
    else if (e.code === "KeyR") {
      const inst = window.__fsGalleryInstance;
      if (inst && inst.toggleRandom) { e.preventDefault(); inst.toggleRandom(); }
    }
  }, true);

  loadSettings();
  loadLiked();

  try {
    const resume = sessionStorage.getItem(RESUME_KEY);
    if (resume) {
      sessionStorage.removeItem(RESUME_KEY);
      let at = null;
      if (resume !== "1") { try { at = JSON.parse(resume).at || null; } catch (_) { /* legacy flag */ } }
      openGallery(at);
    }
  } catch (_) { /* sessionStorage may be blocked */ }
})();
