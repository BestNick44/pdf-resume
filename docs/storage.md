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

Sources:

- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [LockManager.request()](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)
