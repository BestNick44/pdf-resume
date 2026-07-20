# Book storage contract

[`storage/books.mjs`](../storage/books.mjs) is the only app-owned interface for the `books` item in `chrome.storage.local`. Viewer, popup, and background code must use its exported asynchronous operations rather than read or write the item directly.

## API

- `getBook(fileUrl)` returns a cloned record or `undefined`.
- `listBooks()` returns cloned `{ fileUrl, book }` entries sorted by canonical URL in ascending code-unit order.
- `upsertBook(fileUrl, patch)` creates a record or patches only `title`, `customTitle`, and `totalPages`. Omitted fields are preserved. New records default to `customTitle: null`, `totalPages: 0`, `currentPage: 1`, and `scrollTop: 0`; `title` defaults to the empty string.
- `updatePosition(fileUrl, patch)` patches one or both of `currentPage` and `scrollTop`, advances `lastReadAt` monotonically, and does not create an untracked book.
- `removeBook(fileUrl)` returns `true` when it removes a record and `false` without writing when the record is absent.

Timestamps are non-negative integer Unix seconds and are module-managed. `totalPages: 0` means that the page count is not known yet. All other page counts are positive, `currentPage` starts at 1 and cannot exceed a known total, and `scrollTop` is a finite non-negative number.

Inputs are validated before storage access. Keys are canonical, local `file://` PDF URLs with no remote authority. PDF extensions are checked after decoding the pathname, so valid encoded extensions are accepted while malformed escapes and NUL are rejected. Records have exactly the seven fields in [`SPEC.md`](../SPEC.md). A missing `books` item is an empty library; a malformed existing item or record rejects rather than being silently discarded or rewritten. API inputs and results do not alias persisted objects.

## Concurrency

Chrome documents Storage as an asynchronous bulk key/value API available to all extension contexts; it does not provide a compare-and-swap operation for a nested property. Every mutation here therefore requests the origin-scoped Web Lock named `pdf-resume:books` across the complete `get("books")` / patch / `set({ books })` sequence. Web Locks queue the same named exclusive lock across tabs and workers of one origin.

Lock acquisition is bounded at 25 seconds, below Chrome's approximately 30-second inactive extension-service-worker deadline. If the lock is not granted before that bound, the request rejects before its callback runs and storage is not touched. Callers must await every mutation and retry rejected operations when appropriate; starting a mutation without awaiting it can lose the rejection when its context closes.

All app writers must use this module and the Web Locks API must be available. A direct `chrome.storage.local.set({ books: ... })` writer would violate the serialization contract and can lose concurrent changes. The lock serializes cooperating live contexts, but neither Web Locks nor `chrome.storage.local` provides durable transaction atomicity if a context is terminated during the read-modify-write sequence. Reads may observe either the complete value before or after a completed mutation.

## Viewer position delivery

The viewer never calls `storage/books.mjs` `updatePosition` directly. Normal debounced saves and the final lifecycle snapshot use the private, validated `runtime.sendMessage` protocol in [`shared/position-update-messaging.mjs`](../shared/position-update-messaging.mjs). The service worker orders accepted messages by receipt and is the only position writer; its listener returns literal `true`, awaits this module's `updatePosition`, and responds only after that operation settles. Thus a lifecycle snapshot received while an older normal save is in flight runs afterward and wins without competing viewer and worker writers.

While the viewer is live, a rejected normal save retries after 250 ms, 1 second, and 4 seconds. Exhausting those attempts retains the newest snapshot without a pending timer so a later observation or lifecycle event can try it again. The controller's `settled()` waits only for an active write attempt and returns explicit `durable`, `pending`, and `retryPending` state; it does not wait through a scheduled retry or imply durability. Initial tracked-book reads use the same bounded delays, cancel when their document generation retires, and do not retry malformed persisted state. The viewer reads with the validated canonical `file://` URL retained by its outer boot wrapper, never PDF.js's blob URL. A present record is restored only after PDF.js application initialization, `pagesinit`, its `documentinit` initial view, and `pagesPromise`; the pages wait shares PDF.js's 10-second bound so huge or lazy documents cannot hang restoration. A layout turn lets PDF.js finish any second initial-view application before app-owned navigation begins. The saved page is clamped to the loaded document, its exact `PDFPageView` must render without a `pagerendered.error`, and then the canonical viewer container offset is clamped and applied after a layout turn. A lightweight trusted-input lifecycle monitor runs during this window: app initialization and input without a resulting position change remain unobserved, genuine position activity makes restoration yield to the live position, and a changed live position can be handed to the worker if the page closes before full tracking arms. Position listeners are armed once after a final layout turn, and a position changed at that boundary is queued as normal user activity. Missing records remain read-only; malformed state, terminal read/restore failure, and PDF.js initialization rejection produce a nonfatal accessible app warning while leaving the loaded PDF available.

A `pagehide` handler can synchronously invoke `runtime.sendMessage`, but it cannot synchronously await the returned promise or prove that `chrome.storage.local` is durable before page teardown. The worker's open response channel moves the asynchronous work out of the dying page and materially improves the handoff, but abrupt browser/process shutdown or service-worker termination can still lose an unfinished mutation. Visibility changes that leave the page alive continue through the awaited normal save path.

Sources:

- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome extension messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [LockManager.request()](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)
