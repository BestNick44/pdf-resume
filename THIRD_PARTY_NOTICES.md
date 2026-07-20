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
