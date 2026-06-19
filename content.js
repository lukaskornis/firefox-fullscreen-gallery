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

  // ---- Global cursor tracking -----------------------------------------------
  let lastMouse = { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) };
  document.addEventListener("mousemove", (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });

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

  // ---- Pick the most-prominent on-screen image to open on --------------------
  function viewportVisibleArea(rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const h = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    return w * h;
  }
  function pickStartIndex(images) {
    let best = 0, bestVis = -1, bestDist = Infinity;
    for (let i = 0; i < images.length; i++) {
      const el = images[i].el;
      if (!el || !el.isConnected) continue;
      const rect = el.getBoundingClientRect();
      const vis = viewportVisibleArea(rect);
      if (vis <= 0) continue;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - lastMouse.x, cy - lastMouse.y);
      // Prefer clearly-more-visible images; break near-ties (within 15%) by mouse proximity.
      if (vis > bestVis * 1.15) { best = i; bestVis = vis; bestDist = dist; }
      else if (vis > bestVis * 0.85 && dist < bestDist) { best = i; bestVis = Math.max(bestVis, vis); bestDist = dist; }
    }
    return best;
  }

  // ---- Discovery on a FETCHED page -------------------------------------------
  function extractFetched(doc, base) {
    const out = [];
    const abs = (u) => { if (!u) return null; try { return new URL(u, base).href; } catch (_) { return null; } };
    for (const img of doc.querySelectorAll("img")) {
      let src = img.getAttribute("src")
        || largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"))
        || img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
      src = abs(src);
      if (!src) continue;
      if (looksLikeJunk(img, src)) continue;
      const w = parseInt(img.getAttribute("width"), 10) || 0;
      const h = parseInt(img.getAttribute("height"), 10) || 0;
      if ((w && w < MIN_SIDE) || (h && h < MIN_SIDE)) continue;
      let full = null;
      for (const attr of FULL_ATTRS) {
        const v = img.getAttribute(attr);
        if (v) { full = abs(v); if (full) break; }
      }
      const anchor = img.closest("a[href]");
      const ah = anchor ? abs(anchor.getAttribute("href")) : null;
      const wrapped = ah ? unwrapParam(ah, IMG_PARAMS) : null;
      if (!full && wrapped) full = wrapped;
      if (!full && ah && IMG_URL_RE.test(ah)) full = ah;
      if (!full) {
        const big = abs(largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset")));
        if (big) full = big;
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
        .openlink, .close, .visit, .fs { color: #ddd; text-decoration: none; cursor: pointer;
          background: rgba(255,255,255,.08); border: none; padding: 6px 12px; border-radius: 6px;
          font-size: 13px; white-space: nowrap; }
        .openlink:hover, .close:hover, .visit:hover, .fs:hover { background: rgba(255,255,255,.2); color: #fff; }
        .visit { background: rgba(76,141,255,.22); color: #cfe0ff; }
        .visit:hover { background: rgba(76,141,255,.4); color: #fff; }
        .visit[hidden] { display: none; }
      </style>
      <div class="overlay">
        <div class="topbar">
          <span class="counter"></span>
          <button class="heart" title="Like / save (Space)">♡</button>
          <span class="spacer"></span>
          <a class="visit" title="Next page (Enter / ↑)">Next page ↵</a>
          <a class="openlink" target="_blank" rel="noopener">Open image ↗</a>
          <button class="fs" title="Toggle fullscreen (F)">⛶</button>
          <button class="close" title="Close (Esc)">✕</button>
        </div>
        <div class="stage">
          <div class="backdrop"></div>
          <button class="nav prev" title="Previous (← / A)">‹</button>
          <img class="main" alt="">
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
    const stage = q(".stage");

    let index = 0;
    let lastDomEl = null;
    let loadToken = 0;
    let flashTimer = 0;
    const originalScrollY = window.scrollY;

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
    function like() { likeItem(images[index]); flash("♥"); refreshHeart(); }
    function unlike() { unlikeItem(images[index]); flash("🤍"); refreshHeart(); }
    function toggleLike() {
      const item = images[index];
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
    const triedPages = new Set();
    let pageCursor = opts.local ? null : findNextLink(document, location.href);

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

    async function loadNextPage() {
      if (fetching) return;
      const item = images[index];
      if (settings.autoLikeNext && !opts.local) { likeItem(item); refreshHeart(); }
      const candidates = [];
      const add = (u) => { if (u && /^https?:/i.test(u) && !triedPages.has(u) && !candidates.includes(u)) candidates.push(u); };
      add(item.pageHref);
      add(item.source);
      add(pageCursor);
      if (!candidates.length) { transientCounter("No next page from here"); return; }

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
            for (const it of res.fresh) { seen.add(it.full); images.push(it); }
            pageCursor = findNextLink(res.doc, url);            // keep paginating from here
            show(startIdx);
            return;
          }
          const np = findNextLink(res.doc, url);               // thin page; remember its next link
          if (np && !triedPages.has(np)) pageCursor = np;
        }
        counter.textContent = restore;
        transientCounter("No further gallery pages");
      } finally {
        fetching = false;
      }
    }

    function show(i) {
      index = (i + images.length) % images.length;
      const item = images[index];
      if (images[index].el && images[index].el.isConnected) lastDomEl = images[index].el;
      const token = ++loadToken;
      counter.textContent = `${index + 1} / ${images.length}`;
      openLink.href = item.full;
      const nextTarget = item.pageHref || item.source || pageCursor;
      if (nextTarget) { visitLink.href = nextTarget; visitLink.hidden = false; }
      else { visitLink.removeAttribute("href"); visitLink.hidden = true; }
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
      if (index >= images.length - 3) loadMore();
    }
    function preload(i) {
      const item = images[(i + images.length) % images.length];
      if (item) new Image().src = item.full;
    }

    const next = () => { ensureFullscreen(); show(index + 1); };
    const prev = () => { ensureFullscreen(); show(index - 1); };
    const up = () => { ensureFullscreen(); like(); loadNextPage(); };
    const down = () => { ensureFullscreen(); unlike(); };

    q(".next").addEventListener("click", next);
    q(".prev").addEventListener("click", prev);
    q(".fs").addEventListener("click", toggleFullscreen);
    q(".close").addEventListener("click", close);
    heartEl.addEventListener("click", () => toggleLike());
    visitLink.addEventListener("click", (e) => { e.preventDefault(); loadNextPage(); });

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
    return { close, show, isLocal: !!opts.local };
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
  function openGallery() {
    if (window.__fsGalleryInstance) return;
    const seen = new Set();
    const images = collectImages(seen);
    const start = pickStartIndex(images);
    window.__fsGalleryInstance = images.length
      ? buildGallery(images, seen, { startIndex: start })
      : buildEmpty("No gallery-worthy images found on this page.");
  }
  function openLocalGallery() {
    if (window.__fsGalleryInstance) window.__fsGalleryInstance.close();
    const images = likedList.map((i) => ({ thumb: i.thumb || i.full, full: i.full, area: 0, pageHref: i.pageHref, source: i.source }));
    const seen = new Set(images.map((i) => i.full));
    window.__fsGalleryInstance = images.length
      ? buildGallery(images, seen, { local: true })
      : buildEmpty("Your saved gallery is empty. Press Space (or ↑) on images to save them, then reopen with Option+X.");
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
  }, true);

  loadSettings();
  loadLiked();

  try {
    if (sessionStorage.getItem(RESUME_KEY) === "1") {
      sessionStorage.removeItem(RESUME_KEY);
      openGallery();
    }
  } catch (_) { /* sessionStorage may be blocked */ }
})();
