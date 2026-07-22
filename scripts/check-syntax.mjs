// @ts-check

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAppJavaScriptFiles } from "./project-discovery.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const files = await discoverAppJavaScriptFiles(projectRoot);

if (files.length === 0) {
  throw new Error(`No app-owned JavaScript files found recursively under ${projectRoot}`);
}

for (const filePath of files) {
  const result = spawnSync(process.execPath, ["--check", filePath], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
