# Third-party notices

## Mozilla PDF.js 6.1.200

The packaged viewer under [`viewer/pdfjs/`](viewer/pdfjs/) is an unmodified runtime subset of Mozilla's official stable PDF.js 6.1.200 generic distribution. It is licensed under the Apache License 2.0; the complete upstream license is preserved at [`viewer/pdfjs/LICENSE`](viewer/pdfjs/LICENSE).

Exact release, commit, release asset URL and SHA-256, excluded non-runtime files, and the packaged runtime tree digest are recorded in [`viewer/pdfjs/PROVENANCE.json`](viewer/pdfjs/PROVENANCE.json). The omitted files are only source maps, the upstream test PDF, and optional debugger assets; all viewer runtime modules, workers, controls, images, locales, CMaps, ICC profiles, standard fonts, and WASM codecs are included.

The distribution contains these additional notices and licenses:

- Adobe CMap resources: [`viewer/pdfjs/web/cmaps/LICENSE`](viewer/pdfjs/web/cmaps/LICENSE)
- ICC profiles: [`viewer/pdfjs/web/iccs/LICENSE`](viewer/pdfjs/web/iccs/LICENSE)
- Foxit standard fonts: [`viewer/pdfjs/web/standard_fonts/LICENSE_FOXIT`](viewer/pdfjs/web/standard_fonts/LICENSE_FOXIT)
- Liberation Fonts: [`viewer/pdfjs/web/standard_fonts/LICENSE_LIBERATION`](viewer/pdfjs/web/standard_fonts/LICENSE_LIBERATION)
- OpenJPEG, JBIG2, and QCMS WASM components and PDF.js fallback implementations: [`viewer/pdfjs/web/wasm/`](viewer/pdfjs/web/wasm/)

### QuickJS sandbox

The packaged [`quickjs-eval.js`](viewer/pdfjs/web/wasm/quickjs-eval.js) and [`quickjs-eval.wasm`](viewer/pdfjs/web/wasm/quickjs-eval.wasm) are the exact artifacts from PDF.js tag [`v6.1.200`](https://github.com/mozilla/pdf.js/tree/v6.1.200/external/quickjs), which resolves to commit [`6353acefe5007cd4899247a8c4e83cb7c9435a54`](https://github.com/mozilla/pdf.js/commit/6353acefe5007cd4899247a8c4e83cb7c9435a54). Their Git blob IDs are respectively `f087fb29602352e8be9a6e7f7d766ccdb0dda038` and `42980e94aa4d7359e4113c968c67800b45462764`. The [PDF.js v6.1.200 QuickJS README](https://github.com/mozilla/pdf.js/blob/v6.1.200/external/quickjs/README.md) identifies both QuickJS and Mozilla pdf.js.quickjs as MIT-licensed inputs.

- **QuickJS:** PDF.js imported the artifacts in commit [`7a7e4fd382481a76f55c6d735873f635c9178db1`](https://github.com/mozilla/pdf.js/commit/7a7e4fd382481a76f55c6d735873f635c9178db1) from QuickJS commit [`3d5e064e9dd67c70f7962836505a7fa067bf0a4e`](https://github.com/bellard/quickjs/commit/3d5e064e9dd67c70f7962836505a7fa067bf0a4e). The complete [QuickJS MIT license](licenses/quickjs-MIT.txt) is copied from the [license at that exact commit](https://github.com/bellard/quickjs/blob/3d5e064e9dd67c70f7962836505a7fa067bf0a4e/LICENSE).
- **Mozilla pdf.js.quickjs:** the wrapper source used to produce that update is commit [`b62f7cd527363ca2c1fe7467f274bc9acbf78c24`](https://github.com/mozilla/pdf.js.quickjs/tree/b62f7cd527363ca2c1fe7467f274bc9acbf78c24); its [Dockerfile](https://github.com/mozilla/pdf.js.quickjs/blob/b62f7cd527363ca2c1fe7467f274bc9acbf78c24/Dockerfile) pins the same QuickJS commit and its [README](https://github.com/mozilla/pdf.js.quickjs/blob/b62f7cd527363ca2c1fe7467f274bc9acbf78c24/README.md) declares the wrapper MIT-licensed. The complete [pdf.js.quickjs MIT license](licenses/pdf.js.quickjs-MIT.txt) is copied from Mozilla's authoritative [license commit `e2c5bfc8194b16f5973eea5e4e025b67be3c1015`](https://github.com/mozilla/pdf.js.quickjs/blob/e2c5bfc8194b16f5973eea5e4e025b67be3c1015/LICENSE), which added the formal notice after the artifact-producing source commit.
