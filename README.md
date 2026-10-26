# Goodreads Translation Marker (unofficial)

Chrome extension. On Goodreads it tags every book cover with a badge showing whether an edition
exists in **the language you pick** — no more opening "All editions" by hand. It works on the
recommendations page, search results, Listopia lists, shelves/genres, series, author pages and
book pages (old and new Goodreads designs). It can also show the translated cover and title, hide
non-matching books, and bulk-mark them "Not interested" on the recommendations page.

> **Disclaimer:** Unofficial. Not affiliated with, endorsed by, or sponsored by Goodreads or
> Amazon. "Goodreads" is a trademark of its respective owner. This tool runs entirely in your
> own browser using your own logged-in session and stores nothing externally. Use at your own
> risk; it may break if Goodreads changes its site. Provided "as is" under the MIT License.

- `✔ <Language>` — an edition in that language exists; the badge links to it and shows a
  preview (cover, rating, blurb) on hover/focus
- `✔ <Language> · this edition` — on a book page that already is that edition
- `✘ <Language>` — none found
- `… <Language>?` — checking
- `? error` — fetch error (retried on the next visit)

Language names are shown in your browser's language (e.g. `✔ עברית` on a Hebrew browser).

## Settings (toolbar popup)

The popup follows your browser language (English and Hebrew included, Hebrew in RTL).
Every change applies instantly — the open page updates live, no reload needed.

- **Language** — any of Goodreads' 85 edition languages (default: your browser's
  UI language, falling back to English).
- **Run on** — all Goodreads pages (default) or the recommendations page only.
- **Hide books without this language** — non-matching books are hidden on the page.
- **Show the translated edition cover** — swaps each cover for the translated edition's.
- **Show the translated title** — swaps the title text in search/list/shelf rows (the original
  title stays in the hover tooltip).
- **Page stats** — how many books on the current page have / lack the language / are pending.
- **Mark non-matching as "Not interested"** — recommendations page only. Clicks Goodreads'
  "Not interested" on every loaded book that lacks the chosen language. Asks for confirmation;
  this updates your real Goodreads recommendations.
- **Clear cache & recheck** — drops all cached results and checks the page again.

Only real book covers are tagged — Goodreads' hover previews and the "Because you added…"
source book are ignored.

## How it works

For each recommended book the content script:
1. fetches the book page and extracts its `work/editions/<id>`;
2. fetches that editions list filtered to the chosen language (`?filter_by_language=<code>`);
3. marks a match if an edition row's "Edition language: …" label matches the chosen language
   (this rejects Goodreads' fallback of ignoring an unknown code and returning all editions).

Step 1 is skipped when the page already links the work (search and author pages).

Runs in your logged-in browser; book and edition pages load with your session. Results are
cached per book+language in `chrome.storage.local` (30 days for matches, 7 days for "none found",
expired entries are cleaned up daily). Fetches are throttled to 3 at a time and retried with
back-off on HTTP 429/5xx. On the recommendations page every book is checked right away (needed for
bulk "Not interested"); elsewhere books are checked lazily as they scroll into view.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder (`goodreads`)
4. After any code change, click **reload (↻)** on the extension card.
5. Open your recommendations page and **refresh** it.

## Limitations

- A book with **>100 editions in the chosen language** could miss one past the first 100
  (Goodreads caps `per_page` at 100) — practically never for a single language.
- Detection relies on Goodreads having catalogued the edition with the correct edition language.
- DOM selectors target current Goodreads markup; a redesign may need updates in
  `collectBooks()` / `findCard()` / `findNotInterested()` in `content.js`; the main book on a book page is found via `h1[data-testid="bookTitle"]`.
- "Not interested" selector matches the English label `Not interested`. If your Goodreads UI is
  in another language, update the regex in `findNotInterested()`.
- Adding a UI language: copy `_locales/en/messages.json` to `_locales/<code>/messages.json` and
  translate the messages.

## License

[MIT](LICENSE) © 2026. Unofficial; not affiliated with Goodreads or Amazon.
