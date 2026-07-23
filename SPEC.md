# pdf-resume — Spec

A Chrome/Brave (Manifest V3) extension that remembers your reading position in local PDF books and restores it automatically, with a small progress dashboard.

## Problem

Reading books as local PDFs in the browser loses your place every time the tab is closed. Chrome's built-in PDF viewer exposes nothing to extensions, so position can't be tracked there.

## Solution overview

Bundle Mozilla's PDF.js viewer inside the extension. Tracking is **opt-in per file**:

- Untracked PDFs open in the normal built-in viewer; the extension does nothing.
- Clicking the extension icon on a PDF tab shows a popup with a **"Track this book"** button. Clicking it reopens the PDF in the extension's PDF.js viewer and registers the file.
- From then on, opening that same file (bookmark, history, drag-in) is **automatically redirected** to the tracking viewer, which restores the exact page + scroll offset.

## Core behaviors

### 1. Opt-in flow
- Popup on a `file://*.pdf` tab (untracked): shows filename + "Track this book" button.
- On click: save a book record, redirect the tab to `viewer.html?file=<encoded file:// URL>`.
- Requires the user to enable "Allow access to file URLs" once; the popup detects if it's missing and shows instructions instead of the button.

### 2. Auto-redirect for tracked files
- Background service worker listens to navigation events (`webNavigation.onBeforeNavigate` / `onCommitted`) for `file://*.pdf` URLs.
- If the URL matches a tracked book, redirect the tab to the extension viewer.
- Untracked PDFs are never touched.

### 3. Position tracking & restore
- Viewer saves current page number + scroll position to `chrome.storage.local`, debounced (~1s) on scroll/page change, and on tab close (`visibilitychange`/`pagehide`). A final genuine snapshot captured while viewer registration is in flight may write only after that same viewer ID is durably registered in the current tracking generation.
- On open, viewer restores the saved position after the document loads.

### 4. Book metadata
- Total pages from PDF.js.
- Title resolution order: PDF metadata `Title` field → filename (cleaned) → manual override in popup.

### 5. Dashboard (popup)
- On a tracked-book tab: title, current page / total pages, pages remaining, % progress bar, rename field, "Switch books" (opens the library to open another tracked book in the same tab), and "Untrack" button. A book on its known final page can be marked complete; completed books can be moved back to reading.
- On any other tab: separate Reading and Completed library lists with per-book progress bars; clicking either kind opens it in the viewer without changing its completion status.

## Data model (`chrome.storage.local`)

```json
{
  "books": {
    "<file:// URL>": {
      "title": "string",
      "customTitle": "string | null",
      "totalPages": 123,
      "currentPage": 45,
      "scrollTop": 6789,
      "addedAt": 1700000000,
      "lastReadAt": 1700000000
    }
  },
  "completedBooks": {
    "<file:// URL>": 1700000000
  },
  "positionOrder": {
    "<file:// URL>": {
      "version": 2,
      "generation": "128-bit lowercase hexadecimal string",
      "winner": {
        "effectiveTime": 1700000000123,
        "viewerId": "128-bit lowercase hexadecimal string",
        "sequence": 42
      },
      "viewers": {
        "<viewer ID>": {
          "effectiveTime": 1700000000123,
          "sequence": 42
        }
      }
    }
  }
}
```

All three maps are keyed by full `file://` URL (v1 accepts breakage on move/rename; "Untrack + re-track" is the recovery path). `completedBooks` maps completed tracked books to non-negative Unix-second completion timestamps; removing a book removes its completion marker. `positionOrder` is versioned app-owned metadata containing a tracking-lifetime generation, bounded per-viewer high-water marks, and a transitive winner key. Neither auxiliary map adds fields to the authoritative seven-field book record. See [`docs/storage.md`](docs/storage.md) for exact validation, migration, reset, growth, and ordering rules.

## Architecture

- **Manifest V3**, permissions: `storage`, `webNavigation`, `tabs`; host permission `file:///*`.
- **`background.js`** (service worker): redirect logic for tracked URLs.
- **`viewer/`**: prebuilt PDF.js viewer (from pdfjs-dist), lightly patched to add the position save/restore hooks.
- **`popup/`**: dashboard UI (plain HTML/CSS/JS, no framework).
- No build step if possible; vendor pdfjs-dist directly. Plain JS.

## Non-goals (v1)

- Web-hosted PDFs (local `file://` only).
- Sync across devices (`storage.local`, not `storage.sync` — positions are small but the PDF isn't on other machines anyway).
- Annotations, highlights, notes.
- Firefox/Safari support.
- Rename-proof file identity (hashing) — noted as a possible v2.

## Milestones

1. **Skeleton**: manifest, empty background worker, popup that says hello; loads unpacked in Brave.
2. **Viewer**: PDF.js vendored, `viewer.html?file=...` opens a local PDF.
3. **Tracking**: save/restore position for one hardcoded file.
4. **Opt-in + redirect**: popup "Track this book", background auto-redirect.
5. **Dashboard**: full popup UI (progress, library, rename, untrack).
6. **Polish**: file-URL-permission detection, edge cases, icons, README.

## Success criteria

Open a tracked book from a bookmark in Brave → it lands on the exact spot you left off, and the popup shows accurate progress. Untracked PDFs behave exactly as before.
