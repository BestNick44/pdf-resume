# TypeScript adoption spec

Decision record and implementation contract for adding type checking to this codebase. Issue numbers for each phase are listed in [`IMPROVEMENTS.md`](../IMPROVEMENTS.md).

## Decision

**No full TypeScript port.** The runtime stays plain JavaScript (`.mjs`/`.js`) with no build step: the repository root remains the unpacked extension root and `manifest.json` keeps pointing at source files. Instead, the project adopts **JSDoc type annotations checked by `tsc --noEmit`**, with TypeScript installed as a dev-only dependency.

### Why not a full port

- A `.ts` port forces a compile step, a `dist/` tree, source maps, and a changed load-unpacked and debugging workflow — it rebuilds the project's operational shell around a syntax change, violating the same "no build step" constraint that rejected a custom PDF.js build.
- Compile-time types cannot replace the runtime validators: data crosses trust boundaries (`chrome.storage.local` may hold malformed or legacy data, messages arrive from other extension contexts, senders must be verified). Every strict shape validator stays regardless of typing.
- The vendored PDF.js viewer has no type definitions, so the code that would benefit most (restore/tracking against `PDFViewerApplication`) would be `any`-typed either way.

### What typing is for here

Documenting and machine-checking the app-internal shapes — the seven-field book record, `positionOrder` entries, position observations, message payloads, status vocabularies — so call-site mistakes are caught at check time and the shapes stop living only in prose and validators.

## Adopted mechanism

1. **Dev dependencies** (exact-pinned; the only entries in `devDependencies`): `typescript`, `@types/chrome`, `@types/node`. Runtime dependencies remain **zero**, and `node_modules/` is git-ignored. Any future packaging step must exclude `node_modules/`, `tsconfig.json`, and `types/`.
2. **`tsconfig.json`** at the repository root: `strict: true`, `noEmit: true`, `allowJs: true`, `checkJs: false`, `module`/`moduleResolution: "nodenext"`, `target: "es2022"`, `lib: ["es2022", "dom"]`, `types: ["chrome", "node"]`; `exclude`: `viewer/pdfjs/**`, `node_modules`.
3. **Per-file opt-in**: a file is checked only when it starts with `// @ts-check`. `checkJs` stays `false` so unannotated files are never half-checked. The end state is every app-owned `.mjs`/`.js` file opted in.
4. **Checker script** `scripts/check-types.mjs` runs the locally installed `tsc` with the project config and passes its exit code through, printing an actionable message ("run `npm install`") when TypeScript is not installed. It joins the pipeline as `npm run typecheck`, and `npm run check` becomes `format:check && lint && typecheck && test`.

## Conventions

- **Shared shape definitions** live in app-owned, hand-written declaration files under `types/` (e.g. `types/storage.d.ts` for book/observation/message shapes, `types/pdfjs.d.ts` for the minimal PDF.js surface the app touches). JSDoc references them via `import()` types. Declaration files under `types/` are app-owned source: formatted, reviewed, and edited by hand.
- **Vendored code is never typed, edited, or generated from.** `types/pdfjs.d.ts` describes only what app code actually uses (application object fields, event bus, page view fields), is explicitly best-effort, and must shrink or grow with app usage — never chase the full upstream API.
- **`any` is a last resort.** Each `any` (or `@ts-expect-error`) requires a same-line comment stating why. Prefer precise unions and `unknown` + narrowing.
- **Types never weaken runtime checks.** Removing or loosening a runtime validator because "the types cover it" is always wrong at a trust boundary. Typing PRs must be annotation-only: zero behavior change, zero test-assertion changes.
- **Tests**: test files may opt in via `// @ts-check` opportunistically; they are not part of the phased plan and never block it.

## Phases

Ordered so each lands green on its own; do them before the pre-existing improvement backlog (see `IMPROVEMENTS.md` for the full order).

1. **Infrastructure** — dev deps, `.gitignore`, `tsconfig.json`, `scripts/check-types.mjs`, `npm run check` wiring, one trivial module opted in as proof, docs updated.
2. **Tooling and stable shared modules** — `scripts/*.mjs`, `shared/book-title.mjs`.
3. **Storage and messaging** — `types/storage.d.ts` typedefs; opt in `storage/books.mjs` and `shared/position-update-messaging.mjs`. Highest value: this is where the shape complexity concentrates. The position-write seam collapse rework later moves/renames these typedefs; that is an accepted, mechanical cost.
4. **Extension surfaces** — `types/pdfjs.d.ts`; opt in `background.js`, `popup/*.mjs`, and app-owned `viewer/*.mjs`.

## Non-goals

- Renaming any file to `.ts`/`.mts`.
- Emitting, bundling, or transforming code that ships.
- Typing or editing anything under `viewer/pdfjs/`.
- Adding runtime dependencies.
- Replacing runtime validation with static types.
