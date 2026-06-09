const langSel = document.getElementById("lang");
const hideChk = document.getElementById("hide");
const statusEl = document.getElementById("status");

// populate language dropdown
for (const l of GR_LANGUAGES) {
  const o = document.createElement("option");
  o.value = l.c;
  o.textContent = l.n;
  langSel.appendChild(o);
}

// default language from the browser UI language, falling back to English
function defaultLang() {
  const M = {
    he: "heb", en: "eng", fr: "fre", de: "ger", es: "spa", it: "ita",
    pt: "por", ru: "rus", ar: "ara", ja: "jpn", zh: "zho", nl: "nl",
    pl: "pol", tr: "tur", ko: "kor", sv: "swe", da: "dan", fi: "fin",
    no: "nor", cs: "cze", hu: "hun", ro: "rum", uk: "ukr", el: "gre",
  };
  const l = (navigator.language || "en").slice(0, 2).toLowerCase();
  const code = M[l] || "eng";
  const found = GR_LANGUAGES.find((x) => x.c === code);
  return { langCode: code, langName: found ? found.n : "English" };
}

// load saved settings
chrome.storage.sync.get(
  Object.assign({ hide: false }, defaultLang()),
  (s) => {
    langSel.value = s.langCode;
    hideChk.checked = s.hide;
  }
);

function selectedName() {
  const l = GR_LANGUAGES.find((x) => x.c === langSel.value);
  return l ? l.n : langSel.options[langSel.selectedIndex].textContent;
}

async function activeGoodreadsTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

document.getElementById("save").addEventListener("click", () => {
  const settings = {
    langCode: langSel.value,
    langName: selectedName(),
    hide: hideChk.checked,
  };
  // content script applies changes live via chrome.storage.onChanged — no reload
  chrome.storage.sync.set(settings, () => {
    statusEl.textContent = "Saved — page updates automatically.";
    setTimeout(() => window.close(), 700);
  });
});

document.getElementById("mark").addEventListener("click", async () => {
  const name = selectedName();
  if (
    !confirm(
      'Mark every book WITHOUT a "' +
        name +
        '" edition as "Not interested" on this page?\nThis updates your Goodreads recommendations.'
    )
  )
    return;
  const tab = await activeGoodreadsTab();
  if (!tab || !/goodreads\.com/.test(tab.url || "")) {
    statusEl.textContent = "Open your Goodreads recommendations page first.";
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "markNotInterested" }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      statusEl.textContent = "No response — reload the page and try again.";
      return;
    }
    let msg = "Marked " + resp.clicked + ' book(s) "Not interested".';
    if (resp.pending) msg += " " + resp.pending + " still checking — rerun.";
    statusEl.textContent = msg;
  });
});
