import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepositoryFiles } from "./project-discovery.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs"]);
const sourceFiles = await discoverRepositoryFiles(projectRoot, {
  extensions: textExtensions,
  excludeAppVendor: true,
});

for (const filePath of sourceFiles) {
  const relativePath = path.relative(projectRoot, filePath);
  const source = await readFile(filePath, "utf8");

  assert.equal(source.includes("\r"), false, `${relativePath}: use LF line endings`);
  assert.equal(source.includes("\t"), false, `${relativePath}: use spaces, not tabs`);
  assert.equal(source.endsWith("\n"), true, `${relativePath}: add a final newline`);

  source.split("\n").forEach((line, index) => {
    assert.doesNotMatch(line, /[ \t]+$/, `${relativePath}:${index + 1}: trailing whitespace`);
  });

  if (path.extname(filePath) === ".json") {
    const formatted = `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
    assert.equal(source, formatted, `${relativePath}: format JSON with two-space indentation`);
  }
}
