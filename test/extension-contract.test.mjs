import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertRegularFile,
  discoverAppHtmlFiles,
  discoverAppJavaScriptFiles,
  discoverHtmlResourceReferences,
  validateStaticResourceGraph,
} from "../scripts/project-discovery.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const expectedExtensionCsp = {
  extension_pages:
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' file: blob: data:; worker-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' blob: data:;",
};

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

async function assertPackagedFile(relativePath) {
  await assertRegularFile(resolveExtensionPath(relativePath), relativePath);
}

async function relativeFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await relativeFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(path.relative(directoryPath, entryPath));
    }
  }

  return files;
}

async function vendorTreeDigest(vendorRoot) {
  async function entries(directoryPath) {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    const files = [];

    for (const entry of directoryEntries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await entries(entryPath)));
      } else if (entry.isFile() && entry.name !== "PROVENANCE.json") {
        files.push(entryPath);
      }
    }

    return files;
  }

  const inventory = [];
  for (const filePath of await entries(vendorRoot)) {
    const contents = await readFile(filePath);
    const digest = createHash("sha256").update(contents).digest("hex");
    inventory.push(`${digest}  ${path.relative(vendorRoot, filePath).split(path.sep).join("/")}\n`);
  }

  return {
    fileCount: inventory.length,
    digest: createHash("sha256").update(inventory.join("")).digest("hex"),
  };
}

test("manifest declares the milestone-one MV3 contract", async () => {
  const manifest = await readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "pdf-resume");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.permissions, ["storage", "webNavigation", "tabs"]);
  assert.deepEqual(manifest.host_permissions, ["file:///*"]);
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
  assert.deepEqual(manifest.action, {
    default_title: "pdf-resume",
    default_popup: "popup/popup.html",
  });
});

test("package configuration treats JavaScript extension entries as ESM", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.type, "module");
});

test("type checking is strict, dev-only, and never emits runtime files", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
  const tsconfig = JSON.parse(
    await readFile(path.join(projectRoot, "tsconfig.json"), "utf8"),
  );
  const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");

  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(Object.keys(packageJson.devDependencies).sort(), [
    "@types/chrome",
    "@types/node",
    "typescript",
  ]);
  for (const version of Object.values(packageJson.devDependencies)) {
    assert.doesNotMatch(version, /^[~^]/u);
  }
  assert.equal(packageJson.scripts.typecheck, "node scripts/check-types.mjs");
  assert.equal(
    packageJson.scripts.check,
    "npm run format:check && npm run lint && npm run typecheck && npm test",
  );
  assert.deepEqual(tsconfig, {
    compilerOptions: {
      strict: true,
      noEmit: true,
      allowJs: true,
      checkJs: false,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      lib: ["es2022", "dom"],
      types: ["chrome", "node"],
    },
    exclude: ["viewer/pdfjs/**", "node_modules"],
  });
  assert.equal(gitignore, "node_modules/\n");
});

test("type checking explains how to install a missing local compiler", async (t) => {
  const temporaryProject = await mkdtemp(path.join(tmpdir(), "pdf-resume-typecheck-"));
  t.after(() => rm(temporaryProject, { recursive: true, force: true }));
  const checkerPath = path.join(temporaryProject, "check-types.mjs");
  await copyFile(resolveExtensionPath("scripts/check-types.mjs"), checkerPath);

  await assert.rejects(
    execFileAsync(process.execPath, [checkerPath], { cwd: temporaryProject }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(
        error.stderr,
        'Type checking requires dev dependencies: run "npm install"\n',
      );
      return true;
    },
  );
});

test("every app-owned JavaScript file is opted into type checking", async () => {
  const uncheckedFiles = [];

  for (const filePath of await discoverAppJavaScriptFiles(projectRoot)) {
    const relativePath = path.relative(projectRoot, filePath);
    if (relativePath.startsWith(`test${path.sep}`)) {
      continue;
    }
    if (!(await readFile(filePath, "utf8")).startsWith("// @ts-check\n")) {
      uncheckedFiles.push(relativePath);
    }
  }

  assert.deepEqual(uncheckedFiles, []);
});

test("every manifest entry point is a packaged regular file", async () => {
  const manifest = await readManifest();

  await assertPackagedFile(manifest.background.service_worker);
  await assertPackagedFile(manifest.action.default_popup);
});

test("popup shell exposes accessible opt-in, pending, and error surfaces", async () => {
  const manifest = await readManifest();
  const popup = await readFile(
    resolveExtensionPath(manifest.action.default_popup),
    "utf8",
  );

  assert.match(popup, /<html\s+lang="en">/i);
  assert.match(popup, /<main[^>]+id="popupMain"[^>]+aria-busy="true"/i);
  assert.match(popup, /<h1[^>]*>\s*pdf-resume\s*<\/h1>/i);
  assert.match(popup, /id="popupStatus"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(popup, /id="popupError"[^>]+role="alert"[^>]+hidden/i);
  assert.match(popup, /<button[^>]+id="trackButton"[^>]+type="button"[^>]+hidden/i);
  assert.match(popup, />\s*Track this book\s*<\/button>/i);
});

test("popup resources are packaged and comply with extension-page CSP", async () => {
  const manifest = await readManifest();
  const popupPath = resolveExtensionPath(manifest.action.default_popup);
  const popup = await readFile(popupPath, "utf8");
  const resources = discoverHtmlResourceReferences(popup);

  assert.deepEqual(manifest.content_security_policy, expectedExtensionCsp);
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
    await assertRegularFile(resourcePath, resource);
  }
});

test("background entry registers navigation and private position-observation handlers", async () => {
  const manifest = await readManifest();
  const workerPath = resolveExtensionPath(manifest.background.service_worker);
  const worker = await readFile(workerPath, "utf8");

  await execFileAsync(process.execPath, ["--check", workerPath]);
  assert.equal(manifest.background.type, "module");
  assert.match(
    worker,
    /import \{ createPositionUpdateMessageHandler \} from "\.\/shared\/position-update-messaging\.mjs";/,
  );
  assert.match(
    worker,
    /import \{ getBook, recordObservation \} from "\.\/storage\/books\.mjs";/,
  );
  assert.match(worker, /runtime\.onMessage\.addListener/);
  assert.match(worker, /onBeforeNavigate\.addListener/);
  assert.match(
    worker,
    /createPositionUpdateMessageHandler\(\{[\s\S]*recordObservation,[\s\S]*\}\)/,
  );
  await assertPackagedFile("shared/position-update-messaging.mjs");
  await assertPackagedFile("storage/books.mjs");
});

test("popup and viewer entry points load their app-owned modules", async () => {
  const popup = await readFile(resolveExtensionPath("popup/popup.html"), "utf8");
  const popupEntry = await readFile(resolveExtensionPath("popup/popup-entry.mjs"), "utf8");
  const viewer = await readFile(resolveExtensionPath("viewer.html"), "utf8");
  const viewerEntry = await readFile(resolveExtensionPath("viewer/viewer-entry.mjs"), "utf8");
  const viewerApp = await readFile(resolveExtensionPath("viewer/viewer-app.mjs"), "utf8");

  assert.match(popup, /<script src="popup-entry\.mjs" type="module"><\/script>/i);
  assert.match(
    popupEntry,
    /import \{\s+getBook,\s+listBooks,\s+removeBook,\s+trackBook,\s+updateCustomTitle,\s+\} from "\.\.\/storage\/books\.mjs";/,
  );
  assert.match(popupEntry, /import \{ createPopupApp \} from "\.\/popup-app\.mjs";/);
  assert.match(popupEntry, /import \{ createPopupView \} from "\.\/popup-view\.mjs";/);
  assert.match(popupEntry, /tabs\.query\(query\)/);
  assert.match(popupEntry, /tabs\.get\(tabId\)/);
  assert.match(popupEntry, /tabs\.update\(tabId, updateProperties\)/);
  assert.match(popupEntry, /extension\.isAllowedFileSchemeAccess\(\)/);
  assert.match(popupEntry, /runtime\.getURL\(path\)/);
  assert.match(popupEntry, /\blistBooks\b/);
  await assertPackagedFile("popup/popup-app.mjs");
  await assertPackagedFile("popup/popup-view.mjs");
  assert.match(viewer, /<script src="viewer\/viewer-entry\.mjs" type="module"><\/script>/i);
  assert.match(
    viewerEntry,
    /^\/\/ @ts-check\n\nimport \{ startViewerApp \} from "\.\/viewer-app\.mjs";/,
  );
  assert.match(
    viewerApp,
    /import \{\s+getBook,\s+getPositionTrackingState,\s+hydrateMetadata,\s+\} from "\.\.\/storage\/books\.mjs";/,
  );
  assert.match(
    viewerApp,
    /import \{ createPdfJsMetadataHydration \} from "\.\/pdfjs-metadata-hydration\.mjs";/,
  );
  assert.match(
    viewerApp,
    /import \{ createPdfJsPositionTracking \} from "\.\/pdfjs-position-tracking\.mjs";/,
  );
  assert.match(viewerApp, /chrome\.extension\.isAllowedFileSchemeAccess\(\)/);
  assert.match(viewerApp, /createMetadataHydration\(\{/);
  assert.match(viewerApp, /createPositionTracking\(\{/);
  assert.match(
    viewerApp,
    /getPositionTrackingState: getPositionTrackingStateOperation/,
  );
  assert.match(
    viewerApp,
    /recordObservation: positionUpdates\.recordObservation/,
  );
  await execFileAsync(process.execPath, ["--check", resolveExtensionPath("popup/popup-entry.mjs")]);
  await execFileAsync(process.execPath, ["--check", resolveExtensionPath("viewer/viewer-entry.mjs")]);
  await execFileAsync(process.execPath, ["--check", resolveExtensionPath("viewer/viewer-app.mjs")]);
});

test("production viewer entry bootstraps the viewer app", async () => {
  const viewerEntryUrl = pathToFileURL(
    resolveExtensionPath("viewer/viewer-entry.mjs"),
  ).href;
  const script = `
    const selectors = [];
    const elements = {
      "#pdfViewer": { hidden: true, src: "" },
      "#viewerError": { hidden: true },
      "#viewerErrorMessage": { textContent: "" },
      "#viewerFileAccessInstructions": { hidden: true },
      "#viewerWarning": { hidden: true },
      "#viewerWarningMessage": { textContent: "" },
    };
    globalThis.chrome = {
      extension: { isAllowedFileSchemeAccess: async () => true },
    };
    globalThis.window = { location: { search: "" } };
    globalThis.document = {
      querySelector(selector) {
        selectors.push(selector);
        return elements[selector];
      },
    };
    await import(${JSON.stringify(viewerEntryUrl)});
    process.stdout.write(JSON.stringify({
      errorHidden: elements["#viewerError"].hidden,
      errorMessage: elements["#viewerErrorMessage"].textContent,
      selectors,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ]);

  assert.deepEqual(JSON.parse(stdout), {
    errorHidden: false,
    errorMessage:
      "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.",
    selectors: [
      "#pdfViewer",
      "#viewerError",
      "#viewerErrorMessage",
      "#viewerFileAccessInstructions",
      "#viewerWarning",
      "#viewerWarningMessage",
    ],
  });
});

test("shared storage module exposes its API without resolving extension globals on import", async () => {
  const storageModule = await import("../storage/books.mjs");

  assert.deepEqual(
    [
      "getBook",
      "getPositionTrackingState",
      "hydrateMetadata",
      "trackBook",
      "upsertBook",
      "updateCustomTitle",
      "removeBook",
      "listBooks",
      "recordObservation",
    ].filter((operation) => typeof storageModule[operation] !== "function"),
    [],
  );
  assert.equal(Object.hasOwn(storageModule, "updatePosition"), false);
  assert.equal(
    Object.hasOwn(storageModule, "updatePendingPositionObservation"),
    false,
  );
  assert.equal(Object.hasOwn(storageModule, "updatePositionObservation"), false);
});

test("viewer accepts canonically encoded local PDF URLs", async () => {
  const { parseViewerFileQuery } = await import("../viewer/viewer-url.mjs");
  const localPdf = "file:///Users/reader/Books/A book (final).PDF#page=2";
  const encodedExtensionPdf = "file:///Users/reader/Books/Encoded%2Epdf";

  assert.equal(
    parseViewerFileQuery(`?file=${encodeURIComponent(localPdf)}`).href,
    "file:///Users/reader/Books/A%20book%20(final).PDF#page=2",
  );
  assert.equal(
    parseViewerFileQuery(`?file=${encodeURIComponent(encodedExtensionPdf)}`).href,
    encodedExtensionPdf,
  );
});

test("viewer rejects absent, malformed, extra, remote, and non-PDF inputs", async () => {
  const { parseViewerFileQuery } = await import("../viewer/viewer-url.mjs");
  const invalidQueries = [
    "",
    "?",
    "?file=",
    "?file=file:///tmp/book.pdf",
    "?file=%E0%A4%A",
    `?file=${encodeURIComponent("https://example.test/book.pdf")}`,
    `?file=${encodeURIComponent("file://fileserver/share/book.pdf")}`,
    `?file=${encodeURIComponent("file:///tmp/book.txt")}`,
    `?file=${encodeURIComponent("file:///tmp/book.pdf")}&extra=1`,
    `?file=${encodeURIComponent("file:///tmp/book.pdf")}&file=${encodeURIComponent("file:///tmp/other.pdf")}`,
  ];

  for (const query of invalidQueries) {
    assert.throws(() => parseViewerFileQuery(query), /local PDF URL/i, query);
  }
});

test("viewer shell is accessible and keeps local input out of markup", async () => {
  const viewer = await readFile(resolveExtensionPath("viewer.html"), "utf8");

  assert.match(viewer, /<html\s+lang="en">/i);
  assert.match(viewer, /<main[^>]+id="viewerError"[^>]+role="alert"[^>]+hidden/i);
  assert.match(viewer, /<aside[^>]+id="viewerWarning"[^>]+role="status"[^>]+hidden/i);
  assert.match(viewer, /<iframe[^>]+id="pdfViewer"[^>]+title="PDF viewer"[^>]+hidden/i);
  assert.match(viewer, /src="viewer\/viewer-entry\.mjs"/i);
  assert.doesNotMatch(viewer, /<script\b(?![^>]*\bsrc=)[^>]*>/i);
});

test("viewer boot displays a valid local PDF through the packaged PDF.js viewer", async () => {
  const { bootViewer } = await import("../viewer/viewer-boot.mjs");
  const { createViewerView } = await import("../viewer/viewer-view.mjs");
  const pdfBlob = new Blob(["ignored prefix\n%PDF-1.7\n"]);
  const fetchCalls = [];
  const objectUrlBlobs = [];
  let loadListener;
  let loadOptions;
  let focusCalls = 0;
  const frame = {
    hidden: true,
    src: "",
    addEventListener(type, listener, options) {
      assert.equal(type, "load");
      loadListener = listener;
      loadOptions = options;
    },
    focus() {
      focusCalls += 1;
    },
  };
  const errorPanel = { hidden: true };
  const errorMessage = { textContent: "" };
  const objectUrl = "blob:chrome-extension://abcdefghijkl/document-id";
  const search = `?file=${encodeURIComponent("file:///tmp/My Book.pdf")}`;

  const result = await bootViewer({
    search,
    fetchPdf: async (...args) => {
      fetchCalls.push(args);
      return { ok: true, blob: async () => pdfBlob };
    },
    createObjectUrl(blob) {
      objectUrlBlobs.push(blob);
      return objectUrl;
    },
    isFileSchemeAccessAllowed: async () => true,
    pdfJsViewerUrl: new URL(
      "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html",
    ),
    view: createViewerView({ frame, errorPanel, errorMessage }),
  });

  assert.deepEqual(result, {
    fileUrl: "file:///tmp/My%20Book.pdf",
    objectUrl,
  });
  assert.deepEqual(fetchCalls, [
    [
      "file:///tmp/My%20Book.pdf",
      { cache: "no-store", credentials: "omit", redirect: "error" },
    ],
  ]);
  assert.equal(objectUrlBlobs.length, 1);
  assert.equal(objectUrlBlobs[0], pdfBlob);
  assert.equal(frame.hidden, false);
  assert.equal(errorPanel.hidden, true);
  assert.equal(errorMessage.textContent, "");
  const displayedUrl = new URL(frame.src);
  assert.equal(displayedUrl.protocol, "chrome-extension:");
  assert.equal(displayedUrl.hostname, "abcdefghijkl");
  assert.equal(displayedUrl.pathname, "/viewer/pdfjs/web/viewer.html");
  assert.equal(
    displayedUrl.searchParams.get("file"),
    `${objectUrl}#My%20Book.pdf`,
  );
  assert.doesNotMatch(displayedUrl.href, /file:/);
  assert.deepEqual(loadOptions, { once: true });
  assert.equal(focusCalls, 0);
  loadListener();
  assert.equal(focusCalls, 1);
});

test("viewer boot presents local input errors without creating or showing a viewer", async (t) => {
  const { bootViewer } = await import("../viewer/viewer-boot.mjs");
  const { createViewerView } = await import("../viewer/viewer-view.mjs");
  const invalidInputs = [
    ["missing", ""],
    ["malformed", "?file=file:///tmp/book.pdf"],
    ["remote", `?file=${encodeURIComponent("https://example.test/book.pdf")}`],
    ["non-PDF", `?file=${encodeURIComponent("file:///tmp/book.txt")}`],
  ];

  for (const [name, search] of invalidInputs) {
    await t.test(name, async () => {
      const frame = {
        hidden: true,
        src: "",
        addEventListener() {
          assert.fail("an invalid input must not register a viewer load handler");
        },
      };
      const errorPanel = { hidden: true };
      const errorMessage = { textContent: "" };
      let objectUrlCalls = 0;

      const result = await bootViewer({
        search,
        fetchPdf: async () => assert.fail("an invalid input must not be fetched"),
        createObjectUrl() {
          objectUrlCalls += 1;
        },
        isFileSchemeAccessAllowed: async () => true,
        pdfJsViewerUrl: new URL(
          "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html",
        ),
        view: createViewerView({ frame, errorPanel, errorMessage }),
      });

      assert.equal(result, undefined);
      assert.equal(objectUrlCalls, 0);
      assert.equal(frame.hidden, true);
      assert.equal(frame.src, "");
      assert.equal(errorPanel.hidden, false);
      assert.equal(
        errorMessage.textContent,
        "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.",
      );
    });
  }
});

test("viewer boot rejects bad signatures and presents local read failures", async (t) => {
  const { bootViewer } = await import("../viewer/viewer-boot.mjs");
  const { createViewerView } = await import("../viewer/viewer-view.mjs");
  const inputError =
    "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.";
  const readError =
    "The local PDF could not be read. Verify that the file still exists and can be opened.";
  const cases = [
    {
      name: "bad PDF signature",
      fetchPdf: async () => ({ ok: true, blob: async () => new Blob(["not a PDF"]) }),
      message: inputError,
    },
    {
      name: "rejected file request",
      fetchPdf: async () => {
        throw new TypeError("Failed to fetch");
      },
      message: readError,
    },
    {
      name: "unsuccessful file response",
      fetchPdf: async () => ({ ok: false, status: 404 }),
      message: readError,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const frame = {
        hidden: true,
        src: "",
        addEventListener() {
          assert.fail("a rejected file must not register a viewer load handler");
        },
      };
      const errorPanel = { hidden: true };
      const errorMessage = { textContent: "" };
      let objectUrlCalls = 0;

      const result = await bootViewer({
        search: `?file=${encodeURIComponent("file:///tmp/book.pdf")}`,
        fetchPdf: testCase.fetchPdf,
        createObjectUrl() {
          objectUrlCalls += 1;
        },
        isFileSchemeAccessAllowed: async () => true,
        pdfJsViewerUrl: new URL(
          "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html",
        ),
        view: createViewerView({ frame, errorPanel, errorMessage }),
      });

      assert.equal(result, undefined);
      assert.equal(objectUrlCalls, 0);
      assert.equal(frame.hidden, true);
      assert.equal(frame.src, "");
      assert.equal(errorPanel.hidden, false);
      assert.equal(errorMessage.textContent, testCase.message);
    });
  }
});

test("viewer view adapter presents step-by-step file access instructions", async () => {
  const { createViewerView } = await import("../viewer/viewer-view.mjs");
  const frame = { hidden: false };
  const errorPanel = { hidden: false };
  const errorMessage = { textContent: "Old error" };
  const fileAccessInstructions = { hidden: true };
  const warningPanel = { hidden: false };
  const warningMessage = { textContent: "Old warning" };
  const view = createViewerView({
    frame,
    errorPanel,
    errorMessage,
    fileAccessInstructions,
    warningPanel,
    warningMessage,
  });

  view.showFileAccessInstructions();

  assert.equal(frame.hidden, true);
  assert.equal(errorPanel.hidden, true);
  assert.equal(errorMessage.textContent, "");
  assert.equal(fileAccessInstructions.hidden, false);
  assert.equal(warningPanel.hidden, true);
  assert.equal(warningMessage.textContent, "");

  const viewerHtml = await readFile(resolveExtensionPath("viewer.html"), "utf8");
  assert.match(
    viewerHtml,
    /<section\s+id="viewerFileAccessInstructions"[^>]+aria-labelledby="viewerFileAccessHeading"[^>]+hidden\s*>/,
  );
  assert.match(
    viewerHtml,
    /<ol>[\s\S]*main menu[\s\S]*Manage extensions[\s\S]*Details[\s\S]*Allow access to file URLs[\s\S]*reload this page[\s\S]*<\/ol>/i,
  );
});

test("viewer view adapter switches between focused viewer and accessible error states", async () => {
  const { createViewerView } = await import("../viewer/viewer-view.mjs");
  let loadListener;
  let loadOptions;
  let focusCalls = 0;
  const frame = {
    hidden: false,
    src: "chrome-extension://abcdefghijkl/old-viewer.html",
    addEventListener(type, listener, options) {
      assert.equal(type, "load");
      loadListener = listener;
      loadOptions = options;
    },
    focus() {
      focusCalls += 1;
    },
  };
  const errorPanel = { hidden: true };
  const errorMessage = { textContent: "" };
  const warningPanel = { hidden: true };
  const warningMessage = { textContent: "" };
  const view = createViewerView({
    frame,
    errorPanel,
    errorMessage,
    warningPanel,
    warningMessage,
  });

  view.showWarning("The saved position could not be restored.");

  assert.equal(frame.hidden, false, "a warning must preserve the loaded PDF");
  assert.equal(errorPanel.hidden, true);
  assert.equal(warningPanel.hidden, false);
  assert.equal(warningMessage.textContent, "The saved position could not be restored.");

  view.showError("A local error occurred.");

  assert.equal(frame.hidden, true);
  assert.equal(errorPanel.hidden, false);
  assert.equal(errorMessage.textContent, "A local error occurred.");
  assert.equal(warningPanel.hidden, true);
  assert.equal(warningMessage.textContent, "");

  const viewerUrl = new URL(
    "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html?file=blob%3Atest",
  );
  view.showViewer(viewerUrl);

  assert.equal(frame.hidden, false);
  assert.equal(frame.src, viewerUrl.href);
  assert.equal(errorPanel.hidden, true);
  assert.equal(errorMessage.textContent, "");
  assert.equal(warningPanel.hidden, true);
  assert.equal(warningMessage.textContent, "");
  assert.deepEqual(loadOptions, { once: true });
  assert.equal(focusCalls, 0);
  loadListener();
  assert.equal(focusCalls, 1);
});

test("official PDF.js distribution is pinned and byte-for-byte inventoried", async () => {
  const vendorRoot = resolveExtensionPath("viewer/pdfjs");
  const provenance = JSON.parse(
    await readFile(path.join(vendorRoot, "PROVENANCE.json"), "utf8"),
  );

  assert.deepEqual(provenance, {
    name: "Mozilla PDF.js",
    version: "6.1.200",
    tag: "v6.1.200",
    commit: "6353acefe5007cd4899247a8c4e83cb7c9435a54",
    releaseUrl: "https://github.com/mozilla/pdf.js/releases/tag/v6.1.200",
    asset: {
      name: "pdfjs-6.1.200-dist.zip",
      url: "https://github.com/mozilla/pdf.js/releases/download/v6.1.200/pdfjs-6.1.200-dist.zip",
      sha256: "9e1584d768ed099aa4be27ea423f89a038c2005f1ee417ea4f35ba4591ec1846",
    },
    license: "Apache-2.0",
    runtimeFileCount: 399,
    runtimeTreeSha256: "be648426d109d5407c0c25eaf0e48d017cc97c05d02baac84453272507e7cb65",
    excludedReleaseFiles: [
      "build/pdf.mjs.map",
      "build/pdf.sandbox.mjs.map",
      "build/pdf.worker.mjs.map",
      "web/compressed.tracemonkey-pldi-09.pdf",
      "web/debugger.css",
      "web/debugger.mjs",
      "web/viewer.mjs.map",
    ],
  });
  assert.deepEqual(await vendorTreeDigest(vendorRoot), {
    fileCount: provenance.runtimeFileCount,
    digest: provenance.runtimeTreeSha256,
  });
});

test("PDF.js viewer runtime, controls, and complete supporting assets are packaged", async () => {
  const requiredFiles = [
    "viewer/pdfjs/LICENSE",
    "viewer/pdfjs/build/pdf.mjs",
    "viewer/pdfjs/build/pdf.sandbox.mjs",
    "viewer/pdfjs/build/pdf.worker.mjs",
    "viewer/pdfjs/web/viewer.html",
    "viewer/pdfjs/web/viewer.css",
    "viewer/pdfjs/web/viewer.mjs",
    "viewer/pdfjs/web/cmaps/LICENSE",
    "viewer/pdfjs/web/iccs/LICENSE",
    "viewer/pdfjs/web/images/toolbarButton-pageDown.svg",
    "viewer/pdfjs/web/images/toolbarButton-zoomIn.svg",
    "viewer/pdfjs/web/locale/locale.json",
    "viewer/pdfjs/web/locale/en-US/viewer.ftl",
    "viewer/pdfjs/web/standard_fonts/LICENSE_FOXIT",
    "viewer/pdfjs/web/standard_fonts/LICENSE_LIBERATION",
    "viewer/pdfjs/web/wasm/LICENSE_OPENJPEG",
    "viewer/pdfjs/web/wasm/openjpeg.wasm",
    "viewer/pdfjs/web/wasm/qcms_bg.wasm",
  ];
  for (const file of requiredFiles) {
    await assertPackagedFile(file);
  }

  const vendorWebRoot = resolveExtensionPath("viewer/pdfjs/web");
  const vendorViewer = await readFile(path.join(vendorWebRoot, "viewer.html"), "utf8");
  const locales = await readdir(path.join(vendorWebRoot, "locale"), {
    withFileTypes: true,
  });
  const controls = [
    "previous",
    "next",
    "pageNumber",
    "numPages",
    "zoomOutButton",
    "zoomInButton",
    "scaleSelect",
    "viewFindButton",
    "printButton",
    "downloadButton",
    "secondaryOpenFile",
  ];

  for (const id of controls) {
    assert.match(vendorViewer, new RegExp(`id="${id}"`));
  }
  assert.equal(
    locales.filter((entry) => entry.isDirectory()).length,
    113,
    "all upstream locales must be packaged",
  );
  assert.equal((await relativeFiles(path.join(vendorWebRoot, "cmaps"))).length, 169);
  assert.equal((await relativeFiles(path.join(vendorWebRoot, "images"))).length, 78);
  assert.equal((await relativeFiles(path.join(vendorWebRoot, "standard_fonts"))).length, 16);
  assert.equal((await relativeFiles(path.join(vendorWebRoot, "wasm"))).length, 13);
});

test("PDF.js runtime and worker resources resolve through exact packaged paths", async () => {
  const vendorViewer = await readFile(
    resolveExtensionPath("viewer/pdfjs/web/viewer.html"),
    "utf8",
  );
  const vendorRuntime = await readFile(
    resolveExtensionPath("viewer/pdfjs/web/viewer.mjs"),
    "utf8",
  );

  assert.match(vendorViewer, /src="\.\.\/build\/pdf\.mjs" type="module"/);
  assert.match(vendorViewer, /src="viewer\.mjs" type="module"/);
  assert.match(vendorViewer, /href="locale\/locale\.json"/);
  assert.match(vendorViewer, /href="viewer\.css"/);
  assert.match(vendorRuntime, /workerSrc:\s*\{\s*value: "\.\.\/build\/pdf\.worker\.mjs"/);
  assert.match(vendorRuntime, /sandboxBundleSrc = \{\s*value: "\.\.\/build\/pdf\.sandbox\.mjs"/);
  assert.match(vendorRuntime, /cMapUrl:\s*\{\s*value: "\.\.\/web\/cmaps\/"/);
  assert.match(vendorRuntime, /iccUrl:\s*\{\s*value: "\.\.\/web\/iccs\/"/);
  assert.match(vendorRuntime, /standardFontDataUrl:\s*\{\s*value: "\.\.\/web\/standard_fonts\/"/);
  assert.match(vendorRuntime, /wasmUrl:\s*\{\s*value: "\.\.\/web\/wasm\/"/);
});

test("app entry points have a complete packaged local static resource graph", async () => {
  const manifest = await readManifest();
  const appHtmlFiles = await discoverAppHtmlFiles(projectRoot);
  const graph = await validateStaticResourceGraph({
    projectRoot,
    entryFiles: [
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...appHtmlFiles,
    ],
  });

  assert.deepEqual(manifest.content_security_policy, expectedExtensionCsp);
  assert.deepEqual(manifest.host_permissions, ["file:///*"]);
  assert.equal(graph.includes("popup/popup-entry.mjs"), true);
  assert.equal(graph.includes("shared/local-pdf-url.mjs"), true);
  assert.equal(graph.includes("viewer/viewer-app.mjs"), true);

  const vendorHtmlPath = resolveExtensionPath("viewer/pdfjs/web/viewer.html");
  const vendorHtml = await readFile(vendorHtmlPath, "utf8");
  for (const resource of discoverHtmlResourceReferences(vendorHtml)) {
    assert.doesNotMatch(resource, /^(?:https?:)?\/\//i);
    if (resource === "#") {
      continue;
    }
    await assertRegularFile(path.resolve(path.dirname(vendorHtmlPath), resource), resource);
  }
});

test("third-party notices preserve PDF.js and bundled asset licenses", async () => {
  const notices = await readFile(resolveExtensionPath("THIRD_PARTY_NOTICES.md"), "utf8");
  const licenseContracts = [
    {
      path: "licenses/quickjs-MIT.txt",
      sha256: "598fd7fc928e4350abce36e337ba5a1346923c5c692f5be92c3d8e29ddd7c18d",
      notices: [
        /QuickJS Javascript Engine/,
        /Copyright \(c\) 2017-2021 Fabrice Bellard/,
        /Copyright \(c\) 2017-2021 Charlie Gordon/,
      ],
    },
    {
      path: "licenses/pdf.js.quickjs-MIT.txt",
      sha256: "7fdaed3d938f3dfce7189db07e74773c23789143a55db81a95d09dcbfda267b0",
      notices: [/MIT License/, /Copyright \(c\) 2026 Mozilla Foundation/],
    },
  ];

  assert.match(notices, /PDF\.js 6\.1\.200/);
  assert.match(notices, /Apache License 2\.0/);
  assert.match(notices, /Adobe CMap/i);
  assert.match(notices, /Foxit/i);
  assert.match(notices, /Liberation Fonts/i);
  assert.match(notices, /OpenJPEG/i);
  assert.match(notices, /JBIG2/i);
  assert.match(notices, /QCMS/i);
  assert.match(notices, /QuickJS MIT license\]\(licenses\/quickjs-MIT\.txt\)/);
  assert.match(notices, /pdf\.js\.quickjs MIT license\]\(licenses\/pdf\.js\.quickjs-MIT\.txt\)/);
  assert.match(notices, /v6\.1\.200.*6353acefe5007cd4899247a8c4e83cb7c9435a54/);
  assert.match(notices, /3d5e064e9dd67c70f7962836505a7fa067bf0a4e/);
  assert.match(notices, /b62f7cd527363ca2c1fe7467f274bc9acbf78c24/);

  for (const contract of licenseContracts) {
    const license = await readFile(resolveExtensionPath(contract.path), "utf8");
    assert.equal(createHash("sha256").update(license).digest("hex"), contract.sha256);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
    for (const notice of contract.notices) {
      assert.match(license, notice);
    }
  }
});
