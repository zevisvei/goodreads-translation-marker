const langSel = document.getElementById("lang");
const scopeSel = document.getElementById("scope");
const hideChk = document.getElementById("hide");
const swapChk = document.getElementById("swapCovers");
const titleChk = document.getElementById("swapTitles");
const statsEl = document.getElementById("stats");
const markBtn = document.getElementById("mark");
const statusEl = document.getElementById("status");

function t(key, sub) {
  return chrome.i18n.getMessage(key, sub);
}

// localize the static UI; Hebrew/Arabic/... UIs flip to RTL
document.documentElement.lang = grUiLang();
document.documentElement.dir = t("@@bidi_dir") || "ltr";
document.querySelectorAll("[data-i18n]").forEach((el) => {
  const msg = t(el.dataset.i18n);
  if (msg) el.textContent = msg;
});

// populate language dropdown: names in the UI language, sorted for it
const ui = grUiLang();
GR_LANGUAGES.map((l) => ({ c: l.c, label: grLangLabel(l.c, l.n) }))
  .sort((a, b) => a.label.localeCompare(b.label, ui))
  .forEach((l) => {
    const o = document.createElement("option");
    o.value = l.c;
    o.textContent = l.label;
    langSel.appendChild(o);
  });

const DEFAULTS = Object.assign(
  { hide: false, swapCovers: false, swapTitles: false, scope: "all" },
  grDefaultLang()
);

// load saved settings
chrome.storage.sync.get(DEFAULTS, (s) => {
  langSel.value = s.langCode;
  scopeSel.value = s.scope;
  hideChk.checked = s.hide;
  swapChk.checked = s.swapCovers;
  titleChk.checked = s.swapTitles;
});

function selected() {
  return GR_LANGUAGES.find((x) => x.c === langSel.value);
}

async function activeGoodreadsTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https:\/\/www\.goodreads\.com\//.test(tab.url || "") ? tab : null;
}

function sendToTab(msg) {
  return activeGoodreadsTab().then(
    (tab) =>
      new Promise((res) => {
        if (!tab) return res(null);
        chrome.tabs.sendMessage(tab.id, msg, (resp) =>
          res(chrome.runtime.lastError ? null : resp || null)
        );
      })
  );
}

// "This page: 12 with, 30 without, 4 checking"
async function refreshStats() {
  const s = await sendToTab({ type: "getStats" });
  markBtn.disabled = !s || s.page !== "recs";
  if (!s) return void (statsEl.textContent = "");
  statsEl.textContent = s.page
    ? t("statsLine", [String(s.yes), String(s.no), String(s.pending)])
    : t("statsInactive");
}
refreshStats();
setInterval(refreshStats, 1500); // the popup page dies on close

// every change applies immediately; the content script listens via
// chrome.storage.onChanged — no reload needed
function save() {
  const l = selected();
  chrome.storage.sync.set(
    {
      langCode: langSel.value,
      langName: l ? l.n : langSel.options[langSel.selectedIndex].textContent,
      scope: scopeSel.value,
      hide: hideChk.checked,
      swapCovers: swapChk.checked,
      swapTitles: titleChk.checked,
    },
    () => {
      statusEl.textContent = t("statusSaved");
      setTimeout(refreshStats, 300);
    }
  );
}
[langSel, scopeSel, hideChk, swapChk, titleChk].forEach((el) =>
  el.addEventListener("change", save)
);

markBtn.addEventListener("click", async () => {
  const name = langSel.options[langSel.selectedIndex].textContent;
  if (!confirm(t("confirmMark", name))) return;
  const resp = await sendToTab({ type: "markNotInterested" });
  if (!resp) {
    statusEl.textContent = (await activeGoodreadsTab())
      ? t("statusNoResponse")
      : t("statusOpenRecs");
    return;
  }
  if (resp.notRecs) {
    statusEl.textContent = t("statusOpenRecs");
    return;
  }
  let msg = t("statusMarked", String(resp.clicked));
  if (resp.pending) msg += " " + t("statusPending", String(resp.pending));
  statusEl.textContent = msg;
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all || {}).filter((k) => /^gr_lang/.test(k));
    chrome.storage.local.remove(keys, async () => {
      statusEl.textContent = t("statusCacheCleared", String(keys.length));
      await sendToTab({ type: "reEvaluate" });
      refreshStats();
    });
  });
});
