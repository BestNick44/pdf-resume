# Improvement plan

Decisions distilled from two verified reviews (a performance audit and an architecture review, 2026-07-22). Every claim below was checked against the code before being accepted. Product context that drove the calls (see [SPEC.md](SPEC.md)): this is a personal, opt-in reading tracker — libraries are realistically tens of books (the whole `books` map is a few KB), but individual books are large (hundreds of MB, thousands of pages). Findings that only matter at hundreds of books were rejected; findings that matter for one big book were accepted.

Each accepted item has a GitHub issue with strict requirements and acceptance criteria — implement from the issue, not from this summary.

## Phase 0: TypeScript adoption (do these first)

A partial typing effort — JSDoc annotations checked by dev-only `tsc --noEmit`, no build step, no `.ts` files — specified in [`docs/typescript-adoption.md`](docs/typescript-adoption.md). These land before the backlog below; every backlog issue carries a "TypeScript interaction" section describing how the two compose.

| # | Issue | What |
|---|---|---|
| 0.1 | [#31](https://github.com/BestNick44/pdf-resume/issues/31) | Typecheck infrastructure: dev deps, `tsconfig.json`, `scripts/check-types.mjs`, `npm run check` wiring |
| 0.2 | [#32](https://github.com/BestNick44/pdf-resume/issues/32) | Annotate tooling scripts and `shared/book-title.mjs` |
| 0.3 | [#33](https://github.com/BestNick44/pdf-resume/issues/33) | `types/storage.d.ts` + annotate `storage/books.mjs` and messaging |
| 0.4 | [#34](https://github.com/BestNick44/pdf-resume/issues/34) | `types/pdfjs.d.ts` + annotate background, popup, viewer |

A full JS→TS port was considered and rejected: it would force a build pipeline onto a project whose root is the unpacked extension, and compile-time types cannot replace the runtime validators at trust boundaries (storage contents, cross-context messages). The JSDoc approach captures the shape-checking value without either cost.

## Accepted work (recommended order, after phase 0)

| # | Issue | What | Why it earned a ticket |
|---|---|---|---|
| 1 | [#23](https://github.com/BestNick44/pdf-resume/issues/23) | Trim test-only exports from `shared/book-title.mjs` | Two of four exports have no production caller; tests should cross the same seam callers do. Trivial. |
| 2 | [#24](https://github.com/BestNick44/pdf-resume/issues/24) | Shared `strict-record.mjs` for duplicated `isPlainObject`, hex-ID generator, status vocabulary | Byte-identical private copies in `storage/books.mjs` and `shared/position-update-messaging.mjs` will drift. |
| 3 | [#25](https://github.com/BestNick44/pdf-resume/issues/25) | Popup: parallelize `getBook` + file-access permission check | Independent sequential awaits on every popup open of a PDF tab; near-free fix. |
| 4 | [#26](https://github.com/BestNick44/pdf-resume/issues/26) | Parallelize `scripts/check-syntax.mjs` | ~0.72 s → ~0.09 s on a check that runs constantly; no production risk. |
| 5 | [#27](https://github.com/BestNick44/pdf-resume/issues/27) | Delete the test-only `updatePosition` writer in `storage/books.mjs` | Dead production code whose name collides with two other `updatePosition`s. Prerequisite for #28. |
| 6 | [#28](https://github.com/BestNick44/pdf-resume/issues/28) | Collapse position-write seam: one `recordObservation` writer, one message type | The storage implementation is already unified behind `mutatePositionObservation`; only the interface still splits it. This is where ordering bugs cluster. **Advanced; depends on #27.** |
| 7 | [#29](https://github.com/BestNick44/pdf-resume/issues/29) | Position restore: stop waiting on `pagesPromise` (all page proxies) | The headline feature degrades on exactly the target use case — long books. Restore latency should scale with the target page, not total page count. **Advanced.** |
| 8 | [#30](https://github.com/BestNick44/pdf-resume/issues/30) | Prototype: overlap PDF.js startup with the PDF fetch; test programmatic `file://` open | Whole-file buffering before PDF.js starts is the other big-document latency cost. Time-boxed prototype with measurements before any implementation ticket. |

## Rejected findings (and why)

Kept so the same ideas don't get re-proposed without new evidence.

- **Per-book storage keys / schema migration** — linear whole-map scaling is real but irrelevant at tens of books and a few-KB map; migration adds versioning/atomicity risk to the most correctness-sensitive code. Revisit only with a Brave profile showing real cost at realistic sizes.
- **Redirect membership cache in the background worker** — cache-invalidation complexity to skip reading a tiny map on a warm worker.
- **Popup library virtualization / bounded rendering** — "unbounded" is ~30 rows in practice. The one genuine defect (focus lost when the list rebuilds on open) is a small a11y fix, not a rendering-architecture change; ticket it separately if it bites.
- **Deduplicating the two viewer-startup storage reads** — one redundant read of a tiny map that already overlaps in time; merging risks the independent retry/abort behavior. May fall out of #28 naturally.
- **requestAnimationFrame-coalescing position observations** — verification weakened the finding (duplicate work only occurs during active interaction windows) and writes are already debounced. Needs a trace before acting.
- **Unifying the three check scripts; removing `node --check` from contract tests** — total check time is ~1.25 s; the contract-test checks give focused runs standalone syntax coverage.
- **Locale pruning / custom PDF.js build** — conflicts with the project's explicit constraints (no build step, vendored PDF.js never hand-edited, provenance tracked). Package-size only; revisit if store publishing makes size matter.
- **Grouping viewer/popup injected deps behind platform adapters** — half the premise failed verification (the popup's 11 deps are required and explicitly passed, not defaulted), and the wide seams are load-bearing for fault-injection tests.
- **Position-write value object ("one owning module")** — good direction but premature; re-evaluate after #28 lands.
