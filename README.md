# Goodreads Translation Marker (unofficial)

Chrome extension. On the Goodreads **recommendations** page it tags each book with a badge
showing whether an edition exists in **the language you pick** — no more opening "All editions"
by hand. It can also hide non-matching books and bulk-mark them "Not interested".

> **Disclaimer:** Unofficial. Not affiliated with, endorsed by, or sponsored by Goodreads or
> Amazon. "Goodreads" is a trademark of its respective owner. This tool runs entirely in your
> own browser using your own logged-in session and stores nothing externally. Use at your own
> risk; it may break if Goodreads changes its site. Provided "as is" under the MIT License.

- `✔ <Language>` — an edition in that language exists
- `✘ <Language>` — none found
- `… <Language>?` — checking
- `? error` — fetch error

## Settings (toolbar popup)

Click the extension icon:
- **Language** — any of Goodreads' 85 edition languages (default: your browser's
  UI language, falling back to English).
- **Hide books without this language** — non-matching books are hidden on the page.
- **Save** — applies instantly; the open recommendations page updates live (no reload needed).
- **Mark non-matching as "Not interested"** — clicks Goodreads' "Not interested" on every
  book on the current page that lacks the chosen language. Asks for confirmation; this updates
  your real Goodreads recommendations.

Each matching book also gets an **↗ <Language>** link that opens that edition's page
(in the same tab).

Only the real recommended covers are tagged — the hover preview and the "Because you added…"
source book are ignored.

## How it works

For each recommended book the content script:
1. fetches the book page and extracts its `work/editions/<id>`;
2. fetches that editions list filtered to the chosen language (`?filter_by_language=<code>`);
3. marks a match if an edition row's "Edition language: …" label matches the chosen language
   (this rejects Goodreads' fallback of ignoring an unknown code and returning all editions).

Runs in your logged-in browser; book and edition pages load with your session. Results are
cached per book+language in `chrome.storage.local` for 30 days; fetches are throttled to 3 at a time.

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
  `collectBooks()` / `findCard()` / `findNotInterested()` in `content.js`.
- "Not interested" selector matches the English label `Not interested`. If your Goodreads UI is
  in another language, update the regex in `findNotInterested()`.

## License

[MIT](LICENSE) © 2026. Unofficial; not affiliated with Goodreads or Amazon.
