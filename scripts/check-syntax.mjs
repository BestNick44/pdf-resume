// @ts-check

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAppJavaScriptFiles } from "./project-discovery.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const files = await discoverAppJavaScriptFiles(projectRoot);

if (files.length === 0) {
  throw new Error(`No app-owned JavaScript files found recursively under ${projectRoot}`);
}

/**
 * @typedef {object} SyntaxCheckResult
 * @property {Error | undefined} error
 * @property {number | null} status
 * @property {string} stderr
 */

/** @param {string} filePath */
function checkSyntax(filePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ error, status: null, stderr });
    });
    child.on("close", (status) => {
      resolve({ error: undefined, status, stderr });
    });
  });
}

const concurrencyLimit = Math.min(8, availableParallelism());
/** @type {(SyntaxCheckResult | undefined)[]} */
const results = new Array(files.length);
let nextFileIndex = 0;

async function runWorker() {
  while (nextFileIndex < files.length) {
    const fileIndex = nextFileIndex;
    nextFileIndex += 1;
    results[fileIndex] = await checkSyntax(files[fileIndex]);
  }
}

await Promise.all(
  Array.from({ length: concurrencyLimit }, () => runWorker()),
);

for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
  const result = /** @type {SyntaxCheckResult} */ (results[fileIndex]);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(`${files[fileIndex]}\n`);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  }
}
