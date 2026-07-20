import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

async function readManifest() {
  return JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
}

function resolveExtensionPath(relativePath) {
  assert.equal(path.isAbsolute(relativePath), false, `${relativePath} must be relative`);

  const resolvedPath = path.resolve(projectRoot, relativePath);
  assert.equal(
    resolvedPath.startsWith(`${projectRoot}${path.sep}`),
    true,
    `${relativePath} must stay inside the extension`,
  );
  return resolvedPath;
}

async function assertFileExists(relativePath) {
  await access(resolveExtensionPath(relativePath));
}

test("manifest declares the milestone-one MV3 contract", async () => {
  const manifest = await readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "pdf-resume");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.permissions, ["storage", "webNavigation", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["file:///*"]);
  assert.deepEqual(manifest.background, { service_worker: "background.js" });
  assert.deepEqual(manifest.action, {
    default_title: "pdf-resume",
    default_popup: "popup/popup.html",
  });
});

test("every manifest entry point is a packaged file", async () => {
  const manifest = await readManifest();

  await assertFileExists(manifest.background.service_worker);
  await assertFileExists(manifest.action.default_popup);
});

test("popup shell is accessible and does not promise tracking yet", async () => {
  const manifest = await readManifest();
  const popup = await readFile(
    resolveExtensionPath(manifest.action.default_popup),
    "utf8",
  );

  assert.match(popup, /<html\s+lang="en">/i);
  assert.match(popup, /<main[\s>]/i);
  assert.match(popup, /<h1[^>]*>\s*pdf-resume\s*<\/h1>/i);
  assert.match(popup, /pdf-resume is ready/i);
  assert.match(popup, /tracking controls (?:will arrive|are coming|arrive) in a later milestone/i);
  assert.doesNotMatch(popup, /tracking (?:is )?(?:active|enabled|ready|working)/i);
});

test("popup resources are packaged and comply with extension-page CSP", async () => {
  const manifest = await readManifest();
  const popupPath = resolveExtensionPath(manifest.action.default_popup);
  const popup = await readFile(popupPath, "utf8");
  const resourcePattern = /<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"[^>]*>/gi;
  const resources = [...popup.matchAll(resourcePattern)].map((match) => match[1]);

  assert.deepEqual(manifest.content_security_policy, {
    extension_pages: "script-src 'self'; object-src 'none';",
  });
  assert.equal(resources.length > 0, true, "popup should load at least one local asset");
  assert.doesNotMatch(popup, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(popup, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(popup, /\sstyle\s*=/i);
  assert.doesNotMatch(popup, /(?:https?:)?\/\//i);
  assert.doesNotMatch(popup, /javascript:/i);

  for (const resource of resources) {
    assert.doesNotMatch(resource, /^[a-z][a-z\d+.-]*:/i);
    const resourcePath = path.resolve(path.dirname(popupPath), resource);
    assert.equal(resourcePath.startsWith(`${projectRoot}${path.sep}`), true);
    await access(resourcePath);
  }
});

test("background worker is valid JavaScript with no milestone-one side effects", async () => {
  const manifest = await readManifest();
  const workerPath = resolveExtensionPath(manifest.background.service_worker);
  const worker = await readFile(workerPath, "utf8");

  await execFileAsync(process.execPath, ["--check", workerPath]);
  assert.equal(worker.trim(), "");
});
