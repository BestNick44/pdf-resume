# Viewer startup overlap prototype (#30)

## Recommendation

**No-go for a production follow-up.** Variant A did not produce a consistent first-render improvement: the 120 MB fixture improved by 12.2 ms (5.4%), while the 10 MB fixture regressed by 16.6 ms (11.4%). Its memory result was effectively unchanged, and preserving position restore required accounting for lifecycle adapters created after the PDF.js iframe had already loaded. Variant B cannot open a `file://` document in the current vendored PDF.js viewer because that viewer's own CSP blocks `file:` connections.

No implementation ticket was opened.

## Environment and method

- Brave 1.92.141, Chromium 150.0.7871.128, macOS.
- Each measurement used a fresh headful Brave profile loaded and authenticated as described in [`brave-validation.md`](brave-validation.md): the PID was the Brave executable, `chrome://extensions-internals` reported this repository path, `COMMAND_LINE`, MV3, `ENABLED`, no disable reasons, and only the expected API and `file:///*` host permissions. `chrome.extension.isAllowedFileSchemeAccess()` returned `true` before accepted local-file runs.
- Three fresh-profile runs were recorded for every successful variant/size pair; the table reports medians.
- App-owned prototype instrumentation measured parent navigation start to observation of PDF.js's public `initializedPromise`, then to the first successful `pagerendered` event.
- Peak memory is the peak aggregate RSS of all Brave processes carrying that fresh profile's `--user-data-dir`, sampled every 50 ms from navigation through first render. It is broader than a single Task Manager row, but the same method was used for every run.
- The synthetic fixtures were valid image PDFs generated outside the repository: 20 pages / 10,005,972 bytes and 240 pages / 120,070,862 bytes. Every page contains a distinct uncompressed 707×707 grayscale image, making the large fixture 120,070,862 bytes without trailing garbage that could invalidate range behavior.
- Baseline behavior was current `main` (`ada2bb9`) plus measurement-only commit `e526a41`. Variant A is represented by `4596d64` plus the already-loaded-frame lifecycle correction retained as `cf7db6a`. Variant B is `7d78451` plus that correction.

## Measurements

| Variant | Fixture | Navigation → PDF.js initialized | Navigation → first `pagerendered` | Peak fresh-profile RSS |
|---|---:|---:|---:|---:|
| Baseline | 10 MB | 97.6 ms | 145.7 ms | 935.1 MiB |
| A: overlap shell initialization with Blob fetch | 10 MB | 97.0 ms | 162.3 ms | 931.2 MiB |
| B: programmatic canonical `file://` open | 10 MB | 85.8 ms to shell initialization in the diagnostic run | **Failed; no render** | N/A |
| Baseline | 120 MB | 133.6 ms | 226.1 ms | 1133.1 MiB |
| A: overlap shell initialization with Blob fetch | 120 MB | 90.9 ms | 213.9 ms | 1132.7 MiB |
| B: programmatic canonical `file://` open | 120 MB | N/A | **Failed; no render** | N/A |

Raw successful run medians came from these samples:

- Baseline 10 MB: init 97.7/97.6/94.7 ms; first render 146.1/145.7/140.7 ms; peak RSS 937.3/932.9/935.1 MiB.
- A 10 MB: init 97.0/92.5/97.3 ms; first render 162.3/159.6/162.9 ms; peak RSS 931.2/931.8/929.6 MiB.
- Baseline 120 MB: init 133.6/137.1/128.5 ms; first render 226.1/234.4/224.8 ms; peak RSS 1141.9/1132.8/1133.1 MiB.
- A 120 MB: init 93.1/90.2/90.9 ms; first render 213.9/201.8/214.0 ms; peak RSS 1130.7/1132.7/1134.4 MiB.

These local-SSD synthetic fixtures isolate the whole-file buffering cost but are not a corpus of real scanned books. The result is still sufficient for the recommendation: A's first-render effect is inconsistent and small even when the large fixture gives overlap the best chance to help.

## Variant A findings

A loaded `viewer/pdfjs/web/viewer.html` without a document while the existing app-owned fetch ran. It retained the first-1024-byte `%PDF-` signature validation and created a Blob URL only after validation, then called `PDFViewerApplication.open({ url, originalUrl })`.

The first authentic restore check exposed a lifecycle problem: `startViewerApp` did not create metadata and position adapters until after the iframe's one `load` event, so a seeded page-10 state initially remained on page 1. The corrected prototype initializes those adapters immediately when the same-origin iframe document is already complete. After correction, a consistent saved position of page 8 / `scrollTop` 9000 reopened at exactly page 8 / 9000 with no warning or console error.

Failure-path results in authentic Brave:

- **Denied file access:** with file access disabled, `isAllowedFileSchemeAccess()` returned `false`; the local-file instructions were visible, while the error and iframe remained hidden.
- **Missing file:** the accessible local-read error was visible and the iframe hidden.
- **Malformed signature:** the existing encoded-local-PDF input error was visible and the iframe hidden; no Blob URL was created.
- **Position restore:** page 8 / `scrollTop` 9000 restored exactly after the already-loaded-frame correction.

No manifest permission or CSP changes were made.

## Variant B feasibility in Brave

**Variant B does not work in Brave with the current packaged viewer.** Calling `PDFViewerApplication.open({ url: canonicalFileUrl, originalUrl: canonicalFileUrl })` directly bypassed PDF.js's query-string `validateFileURL` origin guard, but the subsequent PDF.js network load was blocked by the vendored viewer's own meta CSP:

> Connecting to `file:///…/small-10mb.pdf` violates the following Content Security Policy directive: `connect-src * blob: data:`. … The scheme `file:` must be added explicitly.

PDF.js then reported:

> Missing PDF file. Unexpected server response (0) while retrieving PDF `file:///…/small-10mb.pdf`.

The extension manifest already permits `file:` in its extension-page `connect-src`; a manifest change cannot loosen the stricter meta policy in `viewer/pdfjs/web/viewer.html`. Editing that vendored file is prohibited by the ticket and project provenance rules. Both fixture sizes therefore failed before first render, so render and peak-memory measurements are not meaningful.

## Type surface

[`types/pdfjs.d.ts`](../types/pdfjs.d.ts) does not declare the public `PDFViewerApplication.open({ url, originalUrl })` method used by both prototypes. The throwaway branch uses an app-local structural type. Any future work using this API would need to add that surface to the app-owned declaration.
