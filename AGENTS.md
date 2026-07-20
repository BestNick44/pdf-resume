# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat [`SPEC.md`](SPEC.md) as the authoritative product scope and milestone plan.
- The unpacked extension root is the repository root; [`manifest.json`](manifest.json) is the authoritative extension entry-point map.
- The project uses plain JavaScript with no build step or installed dependencies. Use Node.js 20 or newer and run `npm run check` for formatting, static syntax checks, and contract tests. For a focused contract run, use `node --test test/extension-contract.test.mjs`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
