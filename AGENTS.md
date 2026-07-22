# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat [`SPEC.md`](SPEC.md) as the authoritative product scope and milestone plan.
- The unpacked extension root is the repository root; [`manifest.json`](manifest.json) is the authoritative extension entry-point map.
- PDF.js is vendored without a build step. Treat [`viewer/pdfjs/PROVENANCE.json`](viewer/pdfjs/PROVENANCE.json) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) as authoritative for its pinned release, integrity inventory, and licenses; do not format or hand-edit upstream files under `viewer/pdfjs/`.
- Use [`docs/brave-validation.md`](docs/brave-validation.md) for reproducible authentic Brave loading and browser evidence. It requires a fresh profile, authenticated PID and flags, `extensions-internals` verification, local-file access proof, and artifact cleanup.
- Use [`storage/books.mjs`](storage/books.mjs) for all app access to the `books` storage item; [`docs/storage.md`](docs/storage.md) defines its schema, validation, and cross-context serialization contract.
- The project uses plain JavaScript with no build step and no runtime dependencies; TypeScript and type stubs are dev-only (run `npm install` once), used for JSDoc type checking via `npm run typecheck`. Use Node.js 20 or newer and run `npm run check` for formatting, static syntax checks, type checking, and the full test suite. For a focused contract run, use `node --test test/extension-contract.test.mjs`.
- [`IMPROVEMENTS.md`](IMPROVEMENTS.md) records the accepted improvement backlog (tracked as issues #23–#34) and the rejected findings with reasons; consult it before proposing performance, architecture, or typing changes. [`docs/typescript-adoption.md`](docs/typescript-adoption.md) is the authoritative contract for the JSDoc/`tsc` typing effort.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
