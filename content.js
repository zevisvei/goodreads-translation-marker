// Goodreads Translation Marker
// On the recommendations page, for each recommended book, check whether an
// edition exists in the user-selected language and tag it. Optionally hide
// non-matching books and bulk-mark them "Not interested".

const WORK_RE = /work\/editions\/(\d+)/;
const CACHE_PREFIX = "gr_lang3_"; // v3: coverUrl now read from the .elementList row
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_CONCURRENT = 3;

// default language from the browser UI language, falling back to English
function defaultLang() {
  const M = {
    he: ["heb", "Hebrew"], en: ["eng", "English"], fr: ["fre", "French"],
    de: ["ger", "German"], es: ["spa", "Spanish"], it: ["ita", "Italian"],
    pt: ["por", "Portuguese"], ru: ["rus", "Russian"], ar: ["ara", "Arabic"],
    ja: ["jpn", "Japanese"], zh: ["zho", "Chinese"], nl: ["nl", "Dutch"],
    pl: ["pol", "Polish"], tr: ["tur", "Turkish"], ko: ["kor", "Korean"],
    sv: ["swe", "Swedish"], da: ["dan", "Danish"], fi: ["fin", "Finnish"],
    no: ["nor", "Norwegian"], cs: ["cze", "Czech"], hu: ["hun", "Hungarian"],
    ro: ["rum", "Romanian"], uk: ["ukr", "Ukrainian"],
    el: ["gre", "Greek, Modern (1453-)"],
  };
  const l = ((navigator.language || "en").slice(0, 2)).toLowerCase();
  const [langCode, langName] = M[l] || ["eng", "English"];
  return { langCode, langName };
}

const SETTINGS = Object.assign({ hide: false, swapCovers: false }, defaultLang());

// bookId -> { card, anchor, badge, openBtn, hasLang, editionUrl, coverUrl,
//             title, imgOrig, swapped }
const results = new Map();

// ---- settings -----------------------------------------------------------

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

// ---- cache (per book + language) ---------------------------------------

function cacheKey(bookId) {
  return CACHE_PREFIX + SETTINGS.langCode + "_" + bookId;
}
function cacheGet(bookId) {
  return new Promise((res) => {
    try {
      const k = cacheKey(bookId);
      chrome.storage.local.get(k, (o) => {
        if (chrome.runtime.lastError || !o) return res(undefined);
        const v = o[k];
        res(v && Date.now() - v.ts < CACHE_TTL_MS ? v : undefined);
      });
    } catch (_) {
      res(undefined); // dead context -> just skip cache, still fetch + badge
    }
  });
}
function cacheSet(bookId, r) {
  try {
    chrome.storage.local.set(
      {
        [cacheKey(bookId)]: {
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

// ---- network / detection -----------------------------------------------

async function fetchText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return r.text();
}

// Goodreads/Amazon cover URLs carry a size modifier between the last two dots,
// e.g. "...cover._SY75_.jpg" or "..._SX50_SY75_.jpg". Strip it for full size.
function biggerCover(url) {
  if (!url) return url;
  return url.replace(/\._S[XY]\d+(?:_S[XY]\d+)?_(\.\w+)(?=$|\?)/, "$1");
}

// returns { has, editionUrl, coverUrl, title } for the selected language
async function checkBookHasLang(bookId) {
  const bookHtml = await fetchText(
    "https://www.goodreads.com/book/show/" + bookId
  );
  const m = bookHtml.match(WORK_RE);
  if (!m) return { has: false, editionUrl: null, coverUrl: "", title: "" };
  const workId = m[1];
  const editionsUrl =
    "https://www.goodreads.com/work/editions/" +
    workId +
    "?filter_by_language=" +
    encodeURIComponent(SETTINGS.langCode) +
    "&per_page=100";
  const edHtml = await fetchText(editionsUrl);
  const doc = new DOMParser().parseFromString(edHtml, "text/html");
  const rows = [...doc.querySelectorAll(".editionData")];
  const name = SETTINGS.langName.toLowerCase();
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

// ---- DOM ----------------------------------------------------------------

function bookIdFromHref(href) {
  const m = (href || "").match(/\/book\/show\/([^?#]+)/);
  return m ? m[1] : null;
}

// climb to the card element that wraps the cover and its action links
function findCard(anchor) {
  let el = anchor;
  for (let i = 0; i < 6 && el && el.parentElement; i++) {
    el = el.parentElement;
    if (/not interested/i.test(el.textContent || "")) return el;
  }
  return anchor.closest("li, td, .bookBox, .stacked, div") || anchor.parentElement;
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

// Is this anchor a real recommendation grid cover (not a hover-tip link,
// not the "Because you added..." source book, not a sidebar link)?
function isRecCover(anchor, dbg) {
  if (!anchor.querySelector("img")) {
    if (dbg) dbg.noImg++;
    return false; // must be a cover
  }
  // walk ancestors: reject hover tips and the "because you added" source book
  let el = anchor;
  for (let i = 0; i < 8 && el; i++) {
    const cls = ((el.className || "") + "").toString();
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

function makeBadge(state) {
  const b = document.createElement("span");
  applyBadge(b, state);
  return b;
}
function applyBadge(b, state) {
  b.className = "gr-lang-badge gr-lang-" + state;
  const L = SETTINGS.langName.split(";")[0].trim();
  if (state === "yes") b.textContent = "✔ " + L;
  else if (state === "no") b.textContent = "✘ " + L;
  else if (state === "loading") b.textContent = "… " + L + "?";
  else b.textContent = "? error";
}

function attachBadge(anchor, badge) {
  anchor.dataset.grLangDone = "1";
  // Place the badge AFTER .coverWrapper, in the card flow. The cover wrapper
  // has overflow:hidden + fixed height, so anything inside it gets clipped.
  const cw = anchor.closest(".coverWrapper");
  if (cw && cw.parentElement) {
    cw.parentElement.insertBefore(badge, cw.nextSibling);
  } else {
    const wrap = anchor.parentElement || anchor;
    wrap.insertBefore(badge, anchor.nextSibling);
  }
  return badge.parentElement;
}

// the language marker IS the link to the translated edition (no separate pill)
function makeLinkBadge(url) {
  const a = document.createElement("a");
  a.className = "gr-lang-badge gr-lang-yes gr-lang-link";
  a.href = url; // same tab
  a.textContent = "✔ " + SETTINGS.langName.split(";")[0].trim();
  return a;
}

function collectBooks() {
  const anchors = document.querySelectorAll('a[href*="/book/show/"]');
  const dbg = { total: anchors.length, noImg: 0, tipClass: 0, because: 0 };
  const seen = new Map();
  anchors.forEach((a) => {
    const id = bookIdFromHref(a.getAttribute("href") || a.href);
    if (!id || a.dataset.grLangDone) return;
    if (!isRecCover(a, dbg)) return;
    if (!seen.has(id)) seen.set(id, a);
  });
  if (seen.size)
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
      seen.size
    );
  return seen;
}

function reapplyHide() {
  results.forEach((rec) => {
    if (!rec.card) return;
    rec.card.style.display =
      SETTINGS.hide && rec.hasLang === false ? "none" : "";
  });
}

// ---- queue --------------------------------------------------------------

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

function setResult(rec, data) {
  rec.hasLang = data.has;
  rec.editionUrl = data.editionUrl;
  rec.coverUrl = data.coverUrl || "";
  rec.title = data.title || "";
  if (data.has && data.editionUrl) {
    // turn the loading span into the clickable "✔ <lang>" marker
    const link = makeLinkBadge(data.editionUrl);
    rec.badge.replaceWith(link);
    rec.badge = link;
    attachTooltip(link, rec);
    prefetchTip(rec); // warm the cache so hover shows instantly
    applyCoverSwap(rec);
  } else {
    applyBadge(rec.badge, "no");
  }
  if (SETTINGS.hide && !data.has && rec.card) rec.card.style.display = "none";
}

// ---- cover swap ---------------------------------------------------------

function applyCoverSwap(rec) {
  if (!SETTINGS.swapCovers || !rec.coverUrl) return;
  const img = rec.anchor.querySelector("img");
  if (!img) return;
  if (!rec.imgOrig)
    rec.imgOrig = {
      src: img.getAttribute("src"),
      srcset: img.getAttribute("srcset"),
    };
  img.src = rec.coverUrl;
  img.removeAttribute("srcset");
  if (rec.title) img.alt = rec.title;
  rec.swapped = true;
}

function revertCoverSwap(rec) {
  if (!rec.swapped) return;
  const img = rec.anchor.querySelector("img");
  if (img && rec.imgOrig) {
    if (rec.imgOrig.src != null) img.src = rec.imgOrig.src;
    else img.removeAttribute("src");
    if (rec.imgOrig.srcset != null) img.setAttribute("srcset", rec.imgOrig.srcset);
    else img.removeAttribute("srcset");
  }
  rec.swapped = false;
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
    m.textContent = expanded ? "(less)" : "...more";
  });
  document.body.appendChild(tipEl);
  return tipEl;
}

function renderTip(d) {
  const stars = d.rating
    ? "★ " +
      d.rating +
      " avg rating" +
      (d.count ? " — " + Number(d.count).toLocaleString() + " ratings" : "")
    : "";
  // a toggle (not a link) — expands the full blurb inside the tip
  const more =
    (d.desc || "").length > 180
      ? '<span class="gr-tip-more" role="button">...more</span>'
      : "";
  return (
    '<div class="gr-tip-title" dir="auto">' + escapeHtml(d.title || "") + "</div>" +
    (d.author ? '<div class="gr-tip-author" dir="auto">by ' + escapeHtml(d.author) + "</div>" : "") +
    (stars ? '<div class="gr-tip-rating">' + escapeHtml(stars) + "</div>" : "") +
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
}

async function process(bookId) {
  const rec = results.get(bookId);
  if (!rec) return;
  try {
    let cached = await cacheGet(bookId);
    if (cached === undefined) {
      const r = await checkBookHasLang(bookId);
      cacheSet(bookId, r);
      cached = r;
    }
    setResult(rec, cached);
  } catch (e) {
    console.warn("[gr-lang]", bookId, e);
    applyBadge(rec.badge, "err");
  }
}

// ---- main ---------------------------------------------------------------

function scan() {
  const books = collectBooks();
  if (books.size)
    console.log("[gr-lang] found", books.size, "book(s),", SETTINGS.langName);
  books.forEach((anchor, bookId) => {
    const badge = makeBadge("loading");
    attachBadge(anchor, badge);
    results.set(bookId, {
      anchor,
      badge,
      card: findCard(anchor),
      hasLang: undefined,
      openBtn: null,
      editionUrl: null,
    });
    queue.push(() => process(bookId));
  });
  pump();
}

// re-run from scratch (e.g. language changed) without a page reload
function reEvaluate() {
  results.forEach((rec) => {
    revertCoverSwap(rec);
    if (rec.badge) rec.badge.remove();
    if (rec.card) rec.card.style.display = "";
    if (rec.anchor) delete rec.anchor.dataset.grLangDone;
  });
  results.clear();
  queue.length = 0;
  scan();
}

function isRecommendationsPage() {
  if (/recommend/i.test(location.href)) return true;
  const h = document.querySelector("h1, .gr-h1, .pageTitle");
  return !!h && /recommendation/i.test(h.textContent || "");
}

// live updates when settings change in the popup — no page refresh needed
try {
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let langChanged = false,
    hideChanged = false,
    coverChanged = false;
  if (changes.langCode) {
    SETTINGS.langCode = changes.langCode.newValue;
    langChanged = true;
  }
  if (changes.langName) SETTINGS.langName = changes.langName.newValue;
  if (changes.hide) {
    SETTINGS.hide = changes.hide.newValue;
    hideChanged = true;
  }
  if (changes.swapCovers) {
    SETTINGS.swapCovers = changes.swapCovers.newValue;
    coverChanged = true;
  }
  if (!isRecommendationsPage()) return;
  if (langChanged) reEvaluate();
  else {
    if (hideChanged) reapplyHide();
    if (coverChanged)
      results.forEach((rec) =>
        SETTINGS.swapCovers ? applyCoverSwap(rec) : revertCoverSwap(rec)
      );
  }
});

// popup -> content: bulk-mark non-matching books as "Not interested"
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "markNotInterested") {
    let clicked = 0,
      pending = 0;
    results.forEach((rec) => {
      if (rec.hasLang === false) {
        const el = findNotInterested(rec.card);
        if (el) {
          el.click();
          clicked++;
        }
      } else if (rec.hasLang === undefined) {
        pending++;
      }
    });
    sendResponse({ clicked, pending });
    return true;
  }
});
} catch (_) {
  /* dead extension context -> listeners unavailable, page-side still works */
}

(async function init() {
  await loadSettings();
  if (!isRecommendationsPage()) {
    console.log("[gr-lang] not a recommendations page, idle.");
    return;
  }
  scan();
  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(scan, 600);
  });
  mo.observe(document.body, { childList: true, subtree: true });
})();
