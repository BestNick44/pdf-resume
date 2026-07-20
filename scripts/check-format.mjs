import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const ignoredDirectories = new Set([".git", "node_modules"]);
const vendorDirectories = new Set([path.join(projectRoot, "viewer", "pdfjs")]);
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs"]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".brave-")) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !ignoredDirectories.has(entry.name) &&
      !vendorDirectories.has(entryPath)
    ) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

for (const filePath of await sourceFiles(projectRoot)) {
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
