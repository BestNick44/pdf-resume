// @ts-check

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let compilerPath;
try {
  const packagePath = require.resolve("typescript/package.json");
  compilerPath = path.join(path.dirname(packagePath), "bin", "tsc");
} catch {
  console.error('Type checking requires dev dependencies: run "npm install"');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [compilerPath, "--project", "tsconfig.json"],
  { stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
