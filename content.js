// Goodreads Translation Marker
// For every book cover on Goodreads (recommendations, search, lists, shelves,
// series, author and book pages), check whether an edition exists in the
// user-selected language and tag it. Optionally hide non-matching books, show
// the translated cover/title, and (recommendations page) bulk-mark the rest
// "Not interested".
// languages.js is loaded first and provides GR_LANGUAGES / grLangLabel / etc.

const WORK_RE = /work\/editions\/(\d+)/;
const CACHE_PREFIX = "gr_lang4_"; // v4: keyed by numeric book id
const ANY_CACHE_RE = /^gr_lang\d+_/; // this and older cache generations
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const CACHE_MISS_TTL_MS = 1000 * 60 * 60 * 24 * 7; // "none found" can change sooner
const GC_KEY = "gr_lang_gc_ts";
const GC_EVERY_MS = 1000 * 60 * 60 * 24;
const MAX_CONCURRENT = 3;

const SETTINGS = Object.assign(
  { hide: false, swapCovers: false, swapTitles: false, scope: "all" },
  grDefaultLang()
);

// one rec per tagged cover (the same book can appear more than once):
// { bookId, workId, anchor, img, main, card, badge, hasLang, editionUrl,
//   coverUrl, title, isSelf, imgOrig, swapped, titleOrig }
const results = new Set();
// bookId -> Promise<{ has, editionUrl, coverUrl, title }> for the current language
const lookups = new Map();

// "recs" | "book" | "other" | null (inactive)
let PAGE = null;

// ---- settings / i18n ----------------------------------------------------

// true while the extension context is alive; chrome.* calls throw once it's not
function ctxAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

function loadSettings() {
  return new Promise((res) => {
    try {
      chrome.storage.sync.get(SETTINGS, (s) => {
        if (!chrome.runtime.lastError && s) Object.assign(SETTINGS, s);
        res(SETTINGS);
      });
    } catch (_) {
      res(SETTINGS); // dead context -> use defaults, keep working without sync
    }
  });
}

// localized UI string (_locales/*/messages.json), English fallback
function t(key, fallback, sub) {
  try {
    return chrome.i18n.getMessage(key, sub) || fallback;
  } catch (_) {
    return fallback;
  }
}

function langLabel() {
  return grLangLabel(SETTINGS.langCode, SETTINGS.langName);
}

// ---- cache (per book + language) ---------------------------------------

function cacheKey(lang, bookId) {
  return CACHE_PREFIX + lang + "_" + bookId;
}
function expired(v, now) {
  return !v || !v.ts || now - v.ts > (v.has ? CACHE_TTL_MS : CACHE_MISS_TTL_MS);
}
function cacheGet(lang, bookId) {
  return new Promise((res) => {
    try {
      const k = cacheKey(lang, bookId);
      chrome.storage.local.get(k, (o) => {
        if (chrome.runtime.lastError || !o) return res(undefined);
        const v = o[k];
        res(expired(v, Date.now()) ? undefined : v);
      });
    } catch (_) {
      res(undefined); // dead context -> just skip cache, still fetch + badge
    }
  });
}
function cacheSet(lang, bookId, r) {
  try {
    chrome.storage.local.set(
      {
        [cacheKey(lang, bookId)]: {
          has: r.has,
          editionUrl: r.editionUrl,
          coverUrl: r.coverUrl || "",
          title: r.title || "",
          ts: Date.now(),
        },
      },
      () => void chrome.runtime.lastError
    );
  } catch (_) {
    /* dead context -> ignore */
  }
}

// once a day drop expired entries and leftovers of older cache generations
function gcCache() {
  try {
    chrome.storage.local.get(GC_KEY, (o) => {
      if (chrome.runtime.lastError || !o) return;
      const now = Date.now();
      if (now - (o[GC_KEY] || 0) < GC_EVERY_MS) return;
      chrome.storage.local.get(null, (all) => {
        if (chrome.runtime.lastError || !all) return;
        const stale = Object.keys(all).filter(
          (k) =>
            ANY_CACHE_RE.test(k) &&
            (!k.startsWith(CACHE_PREFIX) || expired(all[k], now))
        );
        if (stale.length) chrome.storage.local.remove(stale, () => void chrome.runtime.lastError);
        chrome.storage.local.set({ [GC_KEY]: now }, () => void chrome.runtime.lastError);
      });
    });
  } catch (_) {
    /* dead context -> ignore */
  }
}

// ---- network / detection -----------------------------------------------

async function fetchText(url, tries = 3) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { credentials: "include" });
    if (r.ok) return r.text();
    // throttled or flaky -> back off and retry
    if (i + 1 < tries && (r.status === 429 || r.status >= 500)) {
      await new Promise((res) => setTimeout(res, 1500 * 2 ** i));
      continue;
    }
    throw new Error("HTTP " + r.status + " for " + url);
  }
}

// Goodreads/Amazon cover URLs carry a size modifier between the last two dots,
// e.g. "...cover._SY75_.jpg" or "..._SX50_SY75_.jpg". Strip it for full size.
function biggerCover(url) {
  if (!url) return url;
  return url.replace(/\._S[XY]\d+(?:_S[XY]\d+)?_(\.\w+)(?=$|\?)/, "$1");
}

// give a full-size cover URL the same size modifier as the cover it replaces
// ("x.jpg" + "y._SX50_.jpg" -> "x._SX50_.jpg") so thumbnails stay small
function sizedLike(url, orig) {
  const m = (orig || "").match(/\._(S[XY]\d+(?:_S[XY]\d+)?)_\.\w+(?=$|\?)/);
  if (!m || /\._S[XY]\d+/.test(url)) return url;
  return url.replace(/(\.\w+)(?=$|\?)/, "._" + m[1] + "_$1");
}

// returns { has, editionUrl, coverUrl, title } for the given language.
// workId is optional — when the page already links the work, skip the
// (heavy) book page fetch.
async function checkBookHasLang(bookId, workId, lang, langName) {
  if (!workId) {
    const bookHtml = await fetchText(
      "https://www.goodreads.com/book/show/" + bookId
    );
    const m = bookHtml.match(WORK_RE);
    if (!m) return { has: false, editionUrl: null, coverUrl: "", title: "" };
    workId = m[1];
  }
  const editionsUrl =
    "https://www.goodreads.com/work/editions/" +
    workId +
    "?filter_by_language=" +
    encodeURIComponent(lang) +
    "&per_page=100";
  const edHtml = await fetchText(editionsUrl);
  const doc = new DOMParser().parseFromString(edHtml, "text/html");
  const rows = [...doc.querySelectorAll(".editionData")];
  const name = langName.toLowerCase();
  // require an explicit "Edition language: <name>" match — rejects the case
  // where Goodreads ignores an unknown code and returns all editions.
  const match = rows.find(
    (r) =>
      /edition language:/i.test(r.textContent) &&
      r.textContent.toLowerCase().includes(name)
  );
  if (!match) return { has: false, editionUrl: editionsUrl, coverUrl: "", title: "" };
  const link = match.querySelector('a.bookTitle, a[href*="/book/show/"]');
  const editionUrl = link
    ? new URL(link.getAttribute("href"), location.origin).href
    : editionsUrl;
  const title = link ? link.textContent.trim() : "";
  // the cover <img> sits in the .elementList row, NOT inside .editionData
  const row = match.closest(".elementList, tr, li") || match.parentElement;
  const img = (row && row.querySelector("img")) || match.querySelector("img");
  const rawCover = img && (img.getAttribute("src") || img.getAttribute("data-src"));
  const coverUrl = rawCover
    ? biggerCover(new URL(rawCover, location.origin).href)
    : "";
  return { has: true, editionUrl, coverUrl, title };
}

// the editions list appends the binding when a book has no series:
// "Title (Paperback)" -> "Title"
function cleanTitle(title) {
  return (title || "").replace(
    /\s*\((?:paperback|hardcover|kindle edition|ebook|mass market paperback|audiobook|audio cd|library binding|board book|unknown binding|nook)\)\s*$/i,
    ""
  );
}

// cached + de-duplicated: several covers of the same book share one request
function lookup(bookId, workId) {
  const lang = SETTINGS.langCode;
  const langName = SETTINGS.langName;
  if (!lookups.has(bookId)) {
    const p = (async () => {
      const cached = await cacheGet(lang, bookId);
      if (cached) return cached;
      const r = await checkBookHasLang(bookId, workId, lang, langName);
      cacheSet(lang, bookId, r);
      return r;
    })();
    lookups.set(bookId, p);
    // forget failures so a later scan can retry
    p.catch(() => lookups.get(bookId) === p && lookups.delete(bookId));
  }
  return lookups.get(bookId);
}

// ---- DOM ----------------------------------------------------------------

function bookIdFromHref(href) {
  const m = (href || "").match(/\/book\/show\/(\d+)/);
  return m ? m[1] : null;
}

function isRecommendationsPage() {
  if (/recommend/i.test(location.href)) return true;
  const h = document.querySelector("h1, .gr-h1, .pageTitle");
  return !!h && /recommendation/i.test(h.textContent || "");
}

function pageKind() {
  const p = location.pathname;
  // an editions list: every row is already an edition of one work
  if (/^\/work\//.test(p)) return null;
  if (isRecommendationsPage()) return "recs";
  if (SETTINGS.scope === "recs") return null;
  if (/^\/book\/show\/\d/.test(p)) return "book";
  return "other";
}

// the element that wraps one book (cover + title + actions); hidden by "hide"
function findCard(anchor) {
  if (PAGE === "recs") {
    let el = anchor;
    for (let i = 0; i < 6 && el && el.parentElement; i++) {
      el = el.parentElement;
      if (/not interested/i.test(el.textContent || "")) return el;
    }
    return anchor.closest("li, td, .bookBox, .stacked, div") || anchor.parentElement;
  }
  // search / lists / shelves rows, shelf & genre lists, series, carousels
  return anchor.closest(
    'tr, .elementList, .bookBox, .responsiveBook, .Book, li'
  );
}

// find the "Not interested" clickable inside a card
// Goodreads: <a class="userNotInterestedWorkAction" href="#">Not interested</a>
function findNotInterested(card) {
  if (!card) return null;
  return (
    card.querySelector("a.userNotInterestedWorkAction") ||
    [...card.querySelectorAll("a, button")].find((e) =>
      /^not interested$/i.test((e.textContent || "").trim())
    ) ||
    null
  );
}

// the cover <img> of a book link. Classic pages nest it in the <a>; the React
// design (new search, book page carousels) overlays an empty
// "BookCard__stretchedLink" next to the cover instead.
function coverImg(anchor) {
  const img = anchor.querySelector("img");
  if (img || !anchor.classList.contains("BookCard__stretchedLink")) return img;
  const card = anchor.closest(".BookCard");
  return card && card.querySelector("img");
}

// Is this anchor a real book cover (not a hover-tip link, not the
// "Because you added..." source book, not our own tooltip)?
function isBookCover(anchor, dbg) {
  if (!coverImg(anchor)) {
    if (dbg) dbg.noImg++;
    return false; // must be a cover
  }
  if (anchor.closest(".gr-lang-tip")) return false;
  // walk ancestors: reject hover tips and the "because you added" source book
  let el = anchor;
  for (let i = 0; i < 8 && el; i++) {
    // "tooltipTrigger" / "js-dataTooltip" wrap the cover itself on
    // lists/shelves (they *open* a tip) — not a tip
    const cls = ((el.className || "") + "").replace(/\S*(tooltipTrigger|dataTooltip)\S*/gi, "");
    const id = (el.id || "") + "";
    if (/booktip|tooltip|hover|coverTip|\bpopup\b/i.test(cls) || /tip|tooltip/i.test(id)) {
      if (dbg) dbg.tipClass++;
      return false;
    }
    if (el.getAttribute && el.getAttribute("role") === "tooltip") {
      if (dbg) dbg.tipClass++;
      return false;
    }
    const txt = el.textContent || "";
    // the "because you added" text only lives in the hover tip subtree
    if (/because you added/i.test(txt) && txt.length < 1500) {
      if (dbg) dbg.because++;
      return false;
    }
    el = el.parentElement;
  }
  return true;
}

function makeBadge(state, rec) {
  const b = document.createElement("span");
  applyBadge(b, state, rec);
  return b;
}
function applyBadge(b, state, rec) {
  b.className =
    "gr-lang-badge gr-lang-" + state + (rec && rec.main ? " gr-lang-main" : "");
  const L = langLabel();
  if (state === "yes")
    b.textContent =
      "✔ " + L + (rec && rec.main && rec.isSelf ? " · " + t("thisEdition", "this edition") : "");
  else if (state === "no") b.textContent = "✘ " + L;
  else if (state === "loading") b.textContent = "… " + L + "?";
  else b.textContent = t("badgeError", "? error");
}

// the language marker IS the link to the translated edition (no separate pill)
function makeLinkBadge(url, rec) {
  const a = document.createElement("a");
  a.className =
    "gr-lang-badge gr-lang-yes gr-lang-link" + (rec.main ? " gr-lang-main" : "");
  a.href = url; // same tab
  const L = langLabel();
  a.textContent = "✔ " + L;
  a.setAttribute("aria-label", t("badgeTitle", "Open the " + L + " edition", L));
  return a;
}

function attachBadge(rec) {
  const badge = rec.badge;
  if (rec.main) {
    rec.main.after(badge);
    return;
  }
  const anchor = rec.anchor;
  anchor.dataset.grLangDone = "1";
  // Place the badge AFTER .coverWrapper, in the card flow. The cover wrapper
  // has overflow:hidden + fixed height, so anything inside it gets clipped.
  // Lists/shelves wrap the cover in a tooltip trigger: go after that too, so
  // hovering the badge doesn't open Goodreads' own tip.
  const p = anchor.parentElement;
  const host =
    anchor.closest(".coverWrapper, .BookCard") ||
    (p && p.matches(".js-tooltipTrigger, .tooltipTrigger") ? p : anchor);
  host.after(badge);
}

function collectBooks() {
  const anchors = document.querySelectorAll('a[href*="/book/show/"]');
  const dbg = { total: anchors.length, noImg: 0, tipClass: 0, because: 0 };
  const found = [];
  anchors.forEach((a) => {
    if (a.dataset.grLangDone) return;
    const id = bookIdFromHref(a.getAttribute("href") || a.href);
    if (!id || !isBookCover(a, dbg)) return;
    found.push([id, a]);
  });
  if (found.length)
    console.log(
      "[gr-lang] anchors:",
      dbg.total,
      "| excluded noImg:",
      dbg.noImg,
      "tip:",
      dbg.tipClass,
      "because:",
      dbg.because,
      "| accepted:",
      found.length
    );
  return found;
}

function applyHide(rec) {
  if (!rec.card) return;
  rec.card.style.display = SETTINGS.hide && rec.hasLang === false ? "none" : "";
}

// ---- queue (concurrency-limited, lazy off the recommendations page) ------

const queue = [];
let active = 0;
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => {
      active--;
      pump();
    });
  }
}

function enqueue(rec) {
  queue.push(() => process(rec));
  pump();
}

// long lists/shelves: only check covers as they come near the viewport
const lazyRecs = new WeakMap();
const io =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) =>
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            io.unobserve(e.target);
            const rec = lazyRecs.get(e.target);
            if (rec && results.has(rec)) enqueue(rec);
          }),
        { rootMargin: "800px 0px" }
      )
    : null;

function schedule(rec) {
  // recommendations need every result for bulk "Not interested"
  if (PAGE === "recs" || rec.main || !io) return enqueue(rec);
  lazyRecs.set(rec.anchor, rec);
  io.observe(rec.anchor);
}

async function process(rec) {
  const lang = SETTINGS.langCode;
  try {
    const data = await lookup(rec.bookId, rec.workId);
    if (!results.has(rec) || lang !== SETTINGS.langCode) return; // stale
    setResult(rec, data);
  } catch (e) {
    console.warn("[gr-lang]", rec.bookId, e);
    if (!results.has(rec)) return;
    rec.hasLang = null;
    applyBadge(rec.badge, "err", rec);
  }
}

function setResult(rec, data) {
  rec.hasLang = data.has;
  rec.editionUrl = data.editionUrl;
  rec.coverUrl = data.coverUrl || "";
  rec.title = cleanTitle(data.title);
  // the book shown IS the edition in that language — nothing to link/swap
  rec.isSelf = data.has && bookIdFromHref(data.editionUrl) === rec.bookId;
  if (data.has && data.editionUrl && !rec.isSelf) {
    // turn the loading span into the clickable "✔ <lang>" marker
    const link = makeLinkBadge(data.editionUrl, rec);
    rec.badge.replaceWith(link);
    rec.badge = link;
    attachTooltip(link, rec);
    prefetchTip(rec); // warm the cache so hover shows instantly
    applyCoverSwap(rec);
    applyTitleSwap(rec);
  } else {
    applyBadge(rec.badge, data.has ? "yes" : "no", rec);
  }
  applyHide(rec);
}

// ---- cover / title swap --------------------------------------------------

function recImg(rec) {
  return rec.img || (rec.anchor && coverImg(rec.anchor));
}

function applyCoverSwap(rec) {
  if (!SETTINGS.swapCovers || !rec.coverUrl || rec.isSelf || !rec.hasLang) return;
  const img = recImg(rec);
  if (!img) return;
  if (!rec.imgOrig)
    rec.imgOrig = {
      src: img.getAttribute("src"),
      srcset: img.getAttribute("srcset"),
      style: img.getAttribute("style"),
    };
  // keep the thumbnail's footprint: classic pages size covers by the file
  const w = img.getBoundingClientRect().width;
  if (w) {
    img.style.width = w + "px";
    img.style.height = "auto";
  }
  img.src = sizedLike(rec.coverUrl, rec.imgOrig.src);
  img.removeAttribute("srcset");
  if (rec.title) img.alt = rec.title;
  rec.swapped = true;
}

function revertCoverSwap(rec) {
  if (!rec.swapped) return;
  const img = recImg(rec);
  if (img && rec.imgOrig) {
    if (rec.imgOrig.src != null) img.src = rec.imgOrig.src;
    else img.removeAttribute("src");
    if (rec.imgOrig.srcset != null) img.setAttribute("srcset", rec.imgOrig.srcset);
    else img.removeAttribute("srcset");
    if (rec.imgOrig.style != null) img.setAttribute("style", rec.imgOrig.style);
    else img.removeAttribute("style");
  }
  rec.swapped = false;
}

// text links to the same book inside its card (search/list/shelf titles)
function findTitleEls(rec) {
  if (!rec.card || rec.main) return [];
  return [...rec.card.querySelectorAll('a[href*="/book/show/"]')]
    .filter(
      (a) =>
        bookIdFromHref(a.getAttribute("href")) === rec.bookId &&
        !a.querySelector("img") &&
        !a.classList.contains("gr-lang-badge") &&
        (a.textContent || "").trim()
    )
    .map((a) => a.querySelector('[itemprop="name"]') || a);
}

function applyTitleSwap(rec) {
  if (!SETTINGS.swapTitles || !rec.title || rec.isSelf || !rec.hasLang || rec.titleOrig)
    return;
  rec.titleOrig = findTitleEls(rec).map((el) => {
    const orig = { el, html: el.innerHTML, tip: el.getAttribute("title") };
    el.setAttribute("title", el.textContent.trim()); // original on hover
    el.textContent = rec.title;
    el.dir = "auto";
    return orig;
  });
}

function revertTitleSwap(rec) {
  if (!rec.titleOrig) return;
  rec.titleOrig.forEach(({ el, html, tip }) => {
    el.innerHTML = html;
    el.removeAttribute("dir");
    if (tip == null) el.removeAttribute("title");
    else el.setAttribute("title", tip);
  });
  rec.titleOrig = null;
}

// ---- hover tooltip (preview of the translated book page) ----------------

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// editionUrl -> { cover, title, desc, rating, count }
const tipCache = new Map();
async function fetchTip(url) {
  if (tipCache.has(url)) return tipCache.get(url);
  const html = await fetchText(url);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (p) =>
    doc.querySelector('meta[property="' + p + '"]')?.getAttribute("content") || "";
  let rating = "", count = "", author = "";
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const j = JSON.parse(s.textContent);
      const ar = j && j.aggregateRating;
      if (ar) {
        rating = ar.ratingValue || rating;
        count = ar.ratingCount || count;
      }
      if (j && j.author) {
        author = Array.isArray(j.author)
          ? j.author.map((a) => a.name).filter(Boolean).join(", ")
          : j.author.name || author;
      }
    } catch (_) {}
  });
  // og:description is truncated to ~50 chars; the full blurb lives here
  const descEl =
    doc.querySelector('[data-testid="description"]') ||
    doc.querySelector(".BookPageMetadataSection__description") ||
    doc.querySelector(".Formatted") ||
    doc.querySelector("#description");
  const desc = (descEl ? descEl.textContent : meta("og:description")).trim();
  const info = {
    cover: meta("og:image"),
    title: meta("og:title"),
    desc,
    author,
    rating,
    count,
  };
  tipCache.set(url, info);
  return info;
}

function prefetchTip(rec) {
  if (rec.editionUrl) fetchTip(rec.editionUrl).catch(() => {});
}

let tipEl;
function tooltipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className = "gr-lang-tip";
  tipEl.dir = "ltr"; // Goodreads-style LTR layout; text nodes auto-direct
  tipEl.style.display = "none";
  // keep the tip visible while the pointer is over it
  tipEl.addEventListener("mouseenter", () => clearTimeout(tipEl._hideT));
  tipEl.addEventListener("mouseleave", hideTip);
  // "...more" expands the full description inline (no navigation)
  tipEl.addEventListener("click", (e) => {
    const m = e.target.closest(".gr-tip-more");
    if (!m) return;
    e.preventDefault();
    const desc = tipEl.querySelector(".gr-tip-desc");
    if (!desc) return;
    const expanded = desc.classList.toggle("gr-tip-expanded");
    m.textContent = expanded ? t("tipLess", "(less)") : t("tipMore", "...more");
  });
  document.body.appendChild(tipEl);
  return tipEl;
}

function renderTip(d) {
  const stars = d.rating
    ? "★ " +
      d.rating +
      " " +
      t("tipAvg", "avg rating") +
      (d.count
        ? " — " + Number(d.count).toLocaleString(grUiLang()) + " " + t("tipRatings", "ratings")
        : "")
    : "";
  // a toggle (not a link) — expands the full blurb inside the tip
  const more =
    (d.desc || "").length > 180
      ? '<span class="gr-tip-more" role="button" dir="auto">' +
        escapeHtml(t("tipMore", "...more")) +
        "</span>"
      : "";
  return (
    '<div class="gr-tip-title" dir="auto">' + escapeHtml(d.title || "") + "</div>" +
    (d.author
      ? '<div class="gr-tip-author" dir="auto">' +
        escapeHtml(t("tipBy", "by") + " " + d.author) +
        "</div>"
      : "") +
    (stars ? '<div class="gr-tip-rating" dir="auto">' + escapeHtml(stars) + "</div>" : "") +
    '<div class="gr-tip-row">' +
    (d.cover ? '<img class="gr-tip-cover" src="' + escapeHtml(d.cover) + '" alt="">' : "") +
    '<div class="gr-tip-desc" dir="auto">' + escapeHtml(d.desc || "") + "</div>" +
    "</div>" +
    more
  );
}

function positionTip(el, target) {
  const r = target.getBoundingClientRect();
  el.style.top = window.scrollY + r.bottom + 6 + "px";
  const w = el.offsetWidth || 320;
  let left = window.scrollX + r.left;
  const max = window.scrollX + document.documentElement.clientWidth - w - 8;
  el.style.left = Math.max(window.scrollX + 8, Math.min(left, max)) + "px";
}

function showTip(target, rec) {
  const el = tooltipEl();
  clearTimeout(el._hideT);
  el.innerHTML = renderTip({
    cover: rec.coverUrl,
    title: rec.title,
    desc: "…",
    url: rec.editionUrl,
  });
  el.style.display = "block";
  positionTip(el, target);
  if (!rec.editionUrl) return;
  fetchTip(rec.editionUrl)
    .then((info) => {
      if (el.style.display === "none") return;
      el.innerHTML = renderTip({
        cover: info.cover || rec.coverUrl,
        title: info.title || rec.title,
        author: info.author,
        desc: info.desc || "",
        rating: info.rating,
        count: info.count,
        url: rec.editionUrl,
      });
      positionTip(el, target);
    })
    .catch(() => {});
}

function hideTip() {
  if (!tipEl) return;
  tipEl._hideT = setTimeout(() => {
    tipEl.style.display = "none";
  }, 150);
}

function attachTooltip(target, rec) {
  target.addEventListener("mouseenter", () => showTip(target, rec));
  target.addEventListener("mouseleave", hideTip);
  // keyboard users get the same preview
  target.addEventListener("focus", () => showTip(target, rec));
  target.addEventListener("blur", hideTip);
}

// ---- main ---------------------------------------------------------------

function addRec(rec) {
  Object.assign(rec, { hasLang: undefined, editionUrl: null });
  rec.badge = makeBadge("loading", rec);
  attachBadge(rec);
  results.add(rec);
  schedule(rec);
}

function dropRec(rec) {
  revertCoverSwap(rec);
  revertTitleSwap(rec);
  if (rec.badge) rec.badge.remove();
  if (rec.card) rec.card.style.display = "";
  if (rec.anchor) {
    delete rec.anchor.dataset.grLangDone;
    if (io) io.unobserve(rec.anchor);
  }
  results.delete(rec);
}

// the book on a /book/show/ page: badge under its title, swap its big cover
function scanMainBook() {
  const h1 = document.querySelector('h1[data-testid="bookTitle"]');
  const bookId = bookIdFromHref(location.pathname);
  if (!h1 || !bookId) return;
  for (const rec of results) if (rec.main === h1 && rec.bookId === bookId) return;
  const work = document.querySelector('a[href*="/work/editions/"]');
  const m = work && (work.getAttribute("href") || "").match(WORK_RE);
  addRec({
    bookId,
    workId: m ? m[1] : null,
    anchor: null,
    main: h1,
    img: document.querySelector(".BookPage__bookCover img"),
    card: null,
  });
}

function scan() {
  PAGE = pageKind();
  if (!PAGE) return;
  // React pages re-render: forget removed covers, re-attach dropped badges
  results.forEach((rec) => {
    const host = rec.main || rec.anchor;
    if (!host.isConnected) dropRec(rec);
    else if (!rec.badge.isConnected) attachBadge(rec);
  });
  if (PAGE === "book") scanMainBook();
  const books = collectBooks();
  if (books.length)
    console.log("[gr-lang] found", books.length, "cover(s),", SETTINGS.langName);
  books.forEach(([bookId, anchor]) => {
    const card = findCard(anchor);
    // search/author rows link the work directly — saves a book page fetch
    const work = card && card.querySelector('a[href*="/work/editions/"]');
    const m = work && (work.getAttribute("href") || "").match(WORK_RE);
    addRec({ bookId, workId: m ? m[1] : null, anchor, card });
  });
}

// re-run from scratch (language/scope changed, cache cleared, SPA navigation)
function reEvaluate() {
  [...results].forEach(dropRec);
  queue.length = 0;
  lookups.clear();
  scan();
}

function stats() {
  const s = { page: PAGE, yes: 0, no: 0, pending: 0, err: 0 };
  results.forEach((rec) => {
    if (rec.hasLang === true) s.yes++;
    else if (rec.hasLang === false) s.no++;
    else if (rec.hasLang === null) s.err++;
    else s.pending++;
  });
  return s;
}

// live updates when settings change in the popup — no page refresh needed
try {
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const k of Object.keys(changes))
    if (k in SETTINGS) SETTINGS[k] = changes[k].newValue;
  if (changes.langCode || changes.scope) return reEvaluate();
  if (changes.hide) results.forEach(applyHide);
  if (changes.swapCovers)
    results.forEach((rec) =>
      SETTINGS.swapCovers ? applyCoverSwap(rec) : revertCoverSwap(rec)
    );
  if (changes.swapTitles)
    results.forEach((rec) =>
      SETTINGS.swapTitles ? applyTitleSwap(rec) : revertTitleSwap(rec)
    );
});

// popup -> content
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "getStats") {
    sendResponse(stats());
  } else if (msg.type === "reEvaluate") {
    reEvaluate();
    sendResponse(stats());
  } else if (msg.type === "markNotInterested") {
    // bulk-mark non-matching books as "Not interested" (recommendations only)
    if (PAGE !== "recs") return sendResponse({ clicked: 0, pending: 0, notRecs: true });
    const done = new Set();
    let clicked = 0,
      pending = 0;
    results.forEach((rec) => {
      if (rec.hasLang === false) {
        const el = !done.has(rec.card) && findNotInterested(rec.card);
        if (el) {
          done.add(rec.card);
          el.click();
          clicked++;
        }
      } else if (rec.hasLang === undefined) {
        pending++;
      }
    });
    sendResponse({ clicked, pending });
  }
});
} catch (_) {
  /* dead extension context -> listeners unavailable, page-side still works */
}

(async function init() {
  await loadSettings();
  gcCache();
  let url = location.pathname + location.search;
  scan();
  if (!PAGE) console.log("[gr-lang] inactive on this page.");
  // new content (infinite scroll, carousels) and client-side navigation
  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(() => {
      const now = location.pathname + location.search;
      if (now !== url) {
        url = now;
        reEvaluate();
      } else scan();
    }, 600);
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
