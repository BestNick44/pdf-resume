import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertRegularFile,
  discoverAppJavaScriptFiles,
  discoverHtmlResourceReferences,
  discoverImportMetaUrlReferences,
  discoverStaticModuleSpecifiers,
  discoverTestSuites,
  validateStaticResourceGraph,
} from "../../scripts/project-discovery.mjs";

async function createFixture(t) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-resume-tooling-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

async function writeFixtureFile(root, relativePath, contents = "\n") {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

function relativePaths(root, files) {
  return files.map((filePath) => path.relative(root, filePath).split(path.sep).join("/"));
}

test("test suite discovery is recursive and rejects an empty suite", async (t) => {
  const fixtureRoot = await createFixture(t);
  const testRoot = path.join(fixtureRoot, "test");
  await mkdir(testRoot);

  await assert.rejects(
    discoverTestSuites(testRoot),
    /No \*\.test\.mjs suites found recursively/,
  );

  await writeFixtureFile(fixtureRoot, "test/top.test.mjs");
  await writeFixtureFile(fixtureRoot, "test/nested/deeper/contract.test.mjs");
  await writeFixtureFile(fixtureRoot, "test/nested/helper.mjs");

  assert.deepEqual(relativePaths(fixtureRoot, await discoverTestSuites(testRoot)), [
    "test/nested/deeper/contract.test.mjs",
    "test/top.test.mjs",
  ]);
});

test("app JavaScript discovery includes nested malformed code and excludes vendored PDF.js", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(fixtureRoot, "background.js");
  await writeFixtureFile(fixtureRoot, "scripts/nested/tool.mjs", "export const broken = ;\n");
  await writeFixtureFile(fixtureRoot, "test/deep/example.test.mjs");
  await writeFixtureFile(
    fixtureRoot,
    "viewer/pdfjs/build/malformed.mjs",
    "export const vendor = ;\n",
  );
  await writeFixtureFile(fixtureRoot, "node_modules/package/index.js");
  await writeFixtureFile(fixtureRoot, ".git/hooks/sample.js");
  await writeFixtureFile(fixtureRoot, ".brave-profile/generated.js");

  assert.deepEqual(
    relativePaths(fixtureRoot, await discoverAppJavaScriptFiles(fixtureRoot)),
    ["background.js", "scripts/nested/tool.mjs", "test/deep/example.test.mjs"],
  );
});

test("HTML and module discovery accepts all attribute quotes and static import forms", () => {
  const html = `
    <link rel="stylesheet" href='styles.css'>
    <script type=module src=entry.mjs></script>
    <img src="cover.svg">
  `;
  const moduleSource = `
    import defaultExport from "./default.mjs";
    import './side-effect.mjs';
    export { value } from "./named.mjs";
    export * from './all.mjs';
    void import("./dynamic.mjs");
    const moduleUrl = import.meta.url;
    const workerUrl = new URL('./worker.mjs', import.meta.url);
    // import "./commented-out.mjs";
  `;

  assert.deepEqual(discoverHtmlResourceReferences(html), [
    "styles.css",
    "entry.mjs",
    "cover.svg",
  ]);
  assert.deepEqual(discoverStaticModuleSpecifiers(moduleSource), [
    "./default.mjs",
    "./side-effect.mjs",
    "./named.mjs",
    "./all.mjs",
    "./dynamic.mjs",
  ]);
  assert.deepEqual(discoverImportMetaUrlReferences(moduleSource), ["./worker.mjs"]);
});

test("module discovery includes literal dynamic imports only", () => {
  const source = `
    import("./literal.mjs");
    import("./literal-with-options.mjs", { with: { type: "json" } });
    import(moduleSpecifier);
    import.meta.resolve("./resolved.mjs");
    loader.import("./member.mjs");
    loader?.import("./optional-member.mjs");
  `;

  assert.deepEqual(discoverStaticModuleSpecifiers(source), [
    "./literal.mjs",
    "./literal-with-options.mjs",
  ]);
});

test("HTML discovery honors quoted tag boundaries and exact attributes", () => {
  const html = `
    <!-- <script src="./commented-out.mjs"></script> -->
    <script title="a > b" SRC="./actual&amp;entry.mjs"></script>
    <img data-src="./deferred.png" alt='c > d'>
    <link HREF=styles.css rel=stylesheet>
  `;

  assert.deepEqual(discoverHtmlResourceReferences(html), [
    "./actual&entry.mjs",
    "styles.css",
  ]);
});

test("HTML discovery ends tags at malformed attribute-name quotes like Chromium", () => {
  const html =
    `<div '><script type="module" ` +
    `src="./missing-malformed-boundary.mjs"></script>'>`;

  assert.deepEqual(discoverHtmlResourceReferences(html), [
    "./missing-malformed-boundary.mjs",
  ]);
});

test("HTML discovery keeps malformed attribute names and unquoted values synchronized", () => {
  const cases = [
    [
      "single quote in an attribute name",
      `<div broken'name><script src="./after-single-name.mjs"></script>`,
      "./after-single-name.mjs",
    ],
    [
      "double quote in an attribute name",
      `<div broken"name><script src="./after-double-name.mjs"></script>`,
      "./after-double-name.mjs",
    ],
    [
      "equals sign as an attribute name",
      `<div =><script src="./after-equals-name.mjs"></script>`,
      "./after-equals-name.mjs",
    ],
    [
      "single quote in an unquoted value",
      `<div data-value=left'right><script src="./after-single-value.mjs"></script>`,
      "./after-single-value.mjs",
    ],
    [
      "double quote in an unquoted value",
      `<div data-value=left"right><script src="./after-double-value.mjs"></script>`,
      "./after-double-value.mjs",
    ],
    [
      "equals sign in an unquoted value",
      `<div data-value=left=right><script src="./after-equals-value.mjs"></script>`,
      "./after-equals-value.mjs",
    ],
  ];

  for (const [message, html, expectedReference] of cases) {
    assert.deepEqual(
      discoverHtmlResourceReferences(html),
      [expectedReference],
      message,
    );
  }
});

test("HTML discovery retains greater-than signs only inside quoted values", () => {
  const cases = [
    [
      "double-quoted value",
      `<script title="left > right" src="./after-double-quoted.mjs"></script>`,
      ["./after-double-quoted.mjs"],
    ],
    [
      "single-quoted value",
      `<script title='left > right' src="./after-single-quoted.mjs"></script>`,
      ["./after-single-quoted.mjs"],
    ],
    [
      "unterminated double-quoted value",
      `<div title="unterminated ><script src=./hidden-double.mjs></script>`,
      [],
    ],
    [
      "unterminated single-quoted value",
      `<div title='unterminated ><script src="./hidden-single.mjs"></script>`,
      [],
    ],
  ];

  for (const [message, html, expectedReferences] of cases) {
    assert.deepEqual(
      discoverHtmlResourceReferences(html),
      expectedReferences,
      message,
    );
  }
});

test("HTML discovery handles boolean attributes and whitespace around equals", () => {
  const cases = [
    [
      "boolean attribute",
      `<script async src="./after-boolean.mjs"></script>`,
      "./after-boolean.mjs",
    ],
    [
      "spaces around equals",
      `<script defer src = "./after-spaces.mjs"></script>`,
      "./after-spaces.mjs",
    ],
    [
      "HTML whitespace around equals",
      `<script defer\n src\t=\f'./after-html-whitespace.mjs'></script>`,
      "./after-html-whitespace.mjs",
    ],
  ];

  for (const [message, html, expectedReference] of cases) {
    assert.deepEqual(
      discoverHtmlResourceReferences(html),
      [expectedReference],
      message,
    );
  }
});

test("HTML discovery handles self-closing syntax and adjacent tags", () => {
  const cases = [
    [
      "self-closing wrapper",
      `<div/><script src="./after-self-closing.mjs"></script>`,
      ["./after-self-closing.mjs"],
    ],
    [
      "quoted value before self-closing syntax",
      `<div title="left > right"/><link href="./after-quoted-self-close.css">`,
      ["./after-quoted-self-close.css"],
    ],
    [
      "whitespace after self-closing slash",
      `<div / ><img src="./after-spaced-self-close.png">`,
      ["./after-spaced-self-close.png"],
    ],
    [
      "adjacent resource tags",
      `<img src="./first-adjacent.png"><link href="./second-adjacent.css">`,
      ["./first-adjacent.png", "./second-adjacent.css"],
    ],
  ];

  for (const [message, html, expectedReferences] of cases) {
    assert.deepEqual(
      discoverHtmlResourceReferences(html),
      expectedReferences,
      message,
    );
  }
});

test("HTML discovery applies attribute states at raw-text boundaries", () => {
  const cases = [
    [
      "malformed opening tag attribute name",
      `<script broken'><img src="./fake-opening.png"></script>` +
        `<link href="./after-opening.css">`,
      ["./after-opening.css"],
    ],
    [
      "malformed closing tag attribute name",
      `<script><img src="./fake-closing.png"></script '>` +
        `<script src="./after-closing.mjs"></script>`,
      ["./after-closing.mjs"],
    ],
    [
      "quoted greater-than sign on closing tag",
      `<style><img src="./fake-quoted.png"></style title="left > right">` +
        `<img src="./after-quoted-closing.png">`,
      ["./after-quoted-closing.png"],
    ],
    [
      "quote in unquoted opening tag value",
      `<style data-value=left'right><img src="./fake-unquoted.png"></style>` +
        `<link href="./after-unquoted.css">`,
      ["./after-unquoted.css"],
    ],
  ];

  for (const [message, html, expectedReferences] of cases) {
    assert.deepEqual(
      discoverHtmlResourceReferences(html),
      expectedReferences,
      message,
    );
  }
});

test("HTML discovery scans adjacent tags after ordinary no-attribute tags", () => {
  assert.deepEqual(
    discoverHtmlResourceReferences(
      '<head><script src="./entry.mjs"></script></head>',
    ),
    ["./entry.mjs"],
  );
  assert.deepEqual(
    discoverHtmlResourceReferences(
      '<main><img src="./cover.png" srcset="./cover-1.png 1x, ./cover-2.png 2x" /></main>',
    ),
    ["./cover.png", "./cover-1.png", "./cover-2.png"],
  );
  assert.throws(
    () =>
      discoverHtmlResourceReferences(
        '<head><base href="./assets/"></head><body><script src="./entry.mjs"></script></body>',
      ),
    /HTML <base> elements are unsupported by static resource validation/,
  );
});

test("HTML discovery leaves RCDATA only at a matching closing tag", () => {
  assert.deepEqual(
    discoverHtmlResourceReferences(
      `<title><div '</title><script src="./missing-after-title.mjs"></script>`,
    ),
    ["./missing-after-title.mjs"],
  );
  assert.deepEqual(
    discoverHtmlResourceReferences(
      [
        '<textarea><img src="./fake-textarea.png">',
        '</textarealike><img src="./fake-after-closing-substring.png">',
        '<div data-value="<tag"></TeXtArEa>',
        '<script src="./missing-after-textarea.mjs"></script>',
      ].join(""),
    ),
    ["./missing-after-textarea.mjs"],
  );
});

test("HTML discovery skips script and style text without skipping script src", () => {
  assert.deepEqual(
    discoverHtmlResourceReferences(
      [
        '<script src="./entry.mjs">const markup = "<img src=\'./fake-script.png\'";',
        '</scripture><img src="./fake-after-script-substring.png"></ScRiPt>',
        '<style>.example::before { content: "<link href=\'./fake-style.css\'"; }</style>',
        '<script src="./missing-after-raw-text.mjs"></script>',
      ].join(""),
    ),
    ["./entry.mjs", "./missing-after-raw-text.mjs"],
  );
});

test("HTML discovery handles standard raw-text elements and unterminated text", () => {
  for (const tagName of [
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "xmp",
  ]) {
    assert.deepEqual(
      discoverHtmlResourceReferences(
        `<${tagName}><img src="./fake-${tagName}.png"></${tagName}like><script src="./fake-after-${tagName}-substring.mjs"></${tagName.toUpperCase()}><link href="./after-${tagName}.css">`,
      ),
      [`./after-${tagName}.css`],
    );
  }

  assert.deepEqual(
    discoverHtmlResourceReferences(
      '<style><img src="./ignored-inside-style.png"><script src="./ignored-after-style.mjs"></script>',
    ),
    [],
  );
  assert.deepEqual(
    discoverHtmlResourceReferences(
      '<plaintext><script src="./ignored-after-plaintext.mjs"></script>',
    ),
    [],
  );
});

test("literal dynamic imports are traversed and rejected when missing", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "scripts/entry.mjs",
    'void import("./lazy.mjs");\n',
  );
  await writeFixtureFile(
    fixtureRoot,
    "scripts/lazy.mjs",
    'void import("./nested/present.mjs");\n',
  );
  await writeFixtureFile(
    fixtureRoot,
    "scripts/nested/present.mjs",
    "export const present = true;\n",
  );

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["scripts/entry.mjs"],
    }),
    [
      "scripts/entry.mjs",
      "scripts/lazy.mjs",
      "scripts/nested/present.mjs",
    ],
  );

  await writeFixtureFile(
    fixtureRoot,
    "scripts/lazy.mjs",
    'void import("./missing.mjs");\n',
  );
  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["scripts/entry.mjs"],
    }),
    /scripts\/missing\.mjs must be a packaged regular file/,
  );
});

test("quoted greater-than signs cannot hide missing HTML resources", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<script title="a > b" src="./missing&amp;entry.mjs"></script>\n',
  );

  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /missing&entry\.mjs must be a packaged regular file/,
  );
});

test("malformed attribute-name quotes cannot hide graph resources", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    `<div '><script type="module" ` +
      `src="./missing-malformed-boundary.mjs"></script>'>`,
  );

  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /missing-malformed-boundary\.mjs must be a packaged regular file/,
  );
});

test("RCDATA and raw-text states keep graph validation browser-aligned", async (t) => {
  const fixtureRoot = await createFixture(t);
  const missingCases = [
    [
      `<title><div '</title><script src="./missing-after-title.mjs"></script>`,
      "missing-after-title.mjs",
    ],
    [
      '<textarea><img src="./fake-textarea.png"></textarealike><img src="./fake-after-closing-substring.png"></TEXTAREA><script src="./missing-after-textarea.mjs"></script>',
      "missing-after-textarea.mjs",
    ],
    [
      '<script>const markup = "<img src=\'./fake-script.png\'";</scripture><img src="./fake-after-closing-substring.png"></script><link href="./missing-after-script.css">',
      "missing-after-script.css",
    ],
    [
      '<style>.example::before { content: "<script src=\'./fake-style.mjs\'"; }</style><img src="./missing-after-style.png">',
      "missing-after-style.png",
    ],
    [
      '<script src="./missing-opening-script.mjs">const markup = "<img src=\'./fake-script.png\'";</script>',
      "missing-opening-script.mjs",
    ],
  ];

  for (const [html, missingFile] of missingCases) {
    await writeFixtureFile(fixtureRoot, "index.html", html);
    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      new RegExp(`${missingFile.replace(".", "\\.")} must be a packaged regular file`),
    );
  }

  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<style><img src="./ignored-inside-style.png"><script src="./ignored-after-style.mjs"></script>',
  );
  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    ["index.html"],
  );
});

test("no-attribute wrappers cannot hide base elements from graph validation", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(fixtureRoot, "entry.mjs");
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<head><base href="./assets/"></head><body><script src="./entry.mjs"></script></body>',
  );

  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /HTML <base> elements are unsupported by static resource validation/,
  );
});

test("no-attribute wrappers cannot hide resources from graph validation", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<head><script src="./missing.mjs">',
  );

  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /missing\.mjs must be a packaged regular file/,
  );
});

test("HTML base elements fail closed before relative resources are validated", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(fixtureRoot, "entry.mjs");
  const baseElements = [
    '<base href="./assets/">',
    "<BASE HREF='./assets/'>",
    '<BaSe data-label="assets > scripts" href="./assets/">',
  ];

  for (const baseElement of baseElements) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `${baseElement}<script src="entry.mjs"></script>\n`,
    );

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      /HTML <base> elements are unsupported by static resource validation/,
    );
  }
});

test("malformed HTML comment endings cannot hide missing resources", async (t) => {
  const fixtureRoot = await createFixture(t);
  const cases = [
    ["<!-->", "missing-abrupt.mjs"],
    ["<!-- malformed --!>", "missing-bang.mjs"],
  ];

  for (const [comment, missingFile] of cases) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `${comment}<script src="./${missingFile}"></script>\n`,
    );
    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      new RegExp(`${missingFile.replace(".", "\\.")} must be a packaged regular file`),
    );
  }
});

test("semicolonless legacy entities are decoded before graph traversal", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<script src="./scripts&amp/missing.mjs"></script>\n',
  );
  await writeFixtureFile(fixtureRoot, "scripts&amp/missing.mjs");

  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /scripts&\/missing\.mjs must be a packaged regular file/,
  );
});

test("semicolonless legacy entity boundaries remain literal", async (t) => {
  const fixtureRoot = await createFixture(t);
  const references = [
    "literal&ampersand.mjs",
    "literal&amp=value.mjs",
    "literal&ltvalue.mjs",
    "literal&lt=value.mjs",
    "literal&gtvalue.mjs",
    "literal&gt=value.mjs",
    "literal&quotvalue.mjs",
    "literal&quot=value.mjs",
  ];

  for (const reference of references) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="./${reference}"></script>\n`,
    );
    await writeFixtureFile(fixtureRoot, reference);

    assert.deepEqual(
      await validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      ["index.html", reference],
    );
  }
});

test("common named entities are decoded before graph traversal", async (t) => {
  const fixtureRoot = await createFixture(t);
  const cases = [
    ["copyright&copy;.mjs", "copyright©.mjs"],
    ["space&nbsp;.mjs", "space\u00a0.mjs"],
  ];

  for (const [decoyFile, decodedFile] of cases) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="./${decoyFile}"></script>\n`,
    );
    await writeFixtureFile(fixtureRoot, decoyFile);

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      new RegExp(`${decodedFile.replace(".", "\\.")} must be a packaged regular file`),
    );
  }
});

test("semicolonless numeric entities are decoded before graph traversal", async (t) => {
  const fixtureRoot = await createFixture(t);
  const cases = [
    ["scripts&#47missing.mjs", "scripts/missing.mjs"],
    ["scripts&#x2fmissing-hex.mjs", "scripts/missing-hex.mjs"],
  ];

  for (const [reference, decodedFile] of cases) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="./${reference}"></script>\n`,
    );
    await writeFixtureFile(fixtureRoot, "scripts&");

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      new RegExp(`${decodedFile.replace(".", "\\.")} must be a packaged regular file`),
    );
  }
});

test("numeric entities apply HTML replacement behavior", async (t) => {
  const fixtureRoot = await createFixture(t);
  const cases = [
    ["invalid&#0.mjs", "invalid&", "invalid�.mjs"],
    ["legacy&#128;.mjs", "legacy&#128;.mjs", "legacy€.mjs"],
  ];

  for (const [reference, decoyFile, decodedFile] of cases) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="./${reference}"></script>\n`,
    );
    await writeFixtureFile(fixtureRoot, decoyFile);

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      new RegExp(`${decodedFile.replace(".", "\\.")} must be a packaged regular file`),
    );
  }
});

test("unsupported named entities fail closed", async (t) => {
  const fixtureRoot = await createFixture(t);
  const cases = [
    ["unsupported&AElig;.mjs", /Unsupported HTML named character reference &AElig;/],
    [
      "unsupported&cent.mjs",
      /Unsupported semicolonless HTML named character reference &cent/,
    ],
  ];

  for (const [reference, expectedError] of cases) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="./${reference}"></script>\n`,
    );
    await writeFixtureFile(fixtureRoot, reference);

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      expectedError,
    );
  }
});

test("backslash resource paths resolve like browser URL paths", async (t) => {
  const fixtureRoot = await createFixture(t);
  if (path.sep === "/") {
    await writeFixtureFile(fixtureRoot, "scripts\\entry.mjs");
  }
  const references = [
    "./scripts\\entry.mjs?cache=raw#boot",
    "./scripts&bsol;entry.mjs?cache=entity#boot",
  ];

  for (const reference of references) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="${reference}"></script>\n`,
    );

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      /scripts\/entry\.mjs must be a packaged regular file/,
    );
  }
});

test("leading network-style backslashes are non-local resources", async (t) => {
  const fixtureRoot = await createFixture(t);
  const references = ["\\\\host/entry.mjs", "&bsol;&bsol;host/entry.mjs"];

  for (const reference of references) {
    await writeFixtureFile(
      fixtureRoot,
      "index.html",
      `<script src="${reference}"></script>\n`,
    );

    await assert.rejects(
      validateStaticResourceGraph({
        projectRoot: fixtureRoot,
        entryFiles: ["index.html"],
      }),
      /references non-local resource/,
    );
  }

  await writeFixtureFile(
    fixtureRoot,
    "entry.mjs",
    'import "\\\\\\\\host/entry.mjs";\n',
  );
  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["entry.mjs"],
    }),
    /uses non-local module specifier \\\\host\/entry\.mjs/,
  );
});

test("ordinary forward-slash resource graphs remain valid", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    [
      '<!-- <base href="./ignored/"> -->',
      '<script src="./scripts/entry.mjs?first=1&amp;second=2#boot"></script>',
      '<img srcset="./images/cover.png 1x">',
      '<video poster="./images/poster.png"></video>',
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    fixtureRoot,
    "scripts/entry.mjs",
    'import "./dependency.mjs";\n',
  );
  await writeFixtureFile(fixtureRoot, "scripts/dependency.mjs");
  await writeFixtureFile(fixtureRoot, "images/cover.png");
  await writeFixtureFile(fixtureRoot, "images/poster.png");

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    [
      "images/cover.png",
      "images/poster.png",
      "index.html",
      "scripts/dependency.mjs",
      "scripts/entry.mjs",
    ],
  );
});

test("literal ampersands preserve query and fragment URL handling", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<script src="./asset&-literal.mjs?first=1&unknown=2#section"></script>\n',
  );
  await writeFixtureFile(fixtureRoot, "asset&-literal.mjs");

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    ["asset&-literal.mjs", "index.html"],
  );
});

test("srcset candidates and video posters enter the local resource graph", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    [
      '<img srcset="./images/cover-1.png 1x, data:image/png,./not-a-file.png 1.5x, ./images/cover-2.png 2x">',
      "<source srcset='./media/video-1.mp4 480w, ./media/video-2.mp4 960w'>",
      '<video src="./media/video.mp4" poster="./images/poster.jpg"></video>',
      "",
    ].join("\n"),
  );
  for (const resource of [
    "images/cover-1.png",
    "images/cover-2.png",
    "images/poster.jpg",
    "media/video-1.mp4",
    "media/video-2.mp4",
    "media/video.mp4",
  ]) {
    await writeFixtureFile(fixtureRoot, resource);
  }

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    [
      "images/cover-1.png",
      "images/cover-2.png",
      "images/poster.jpg",
      "index.html",
      "media/video-1.mp4",
      "media/video-2.mp4",
      "media/video.mp4",
    ],
  );

  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    '<img srcset="https://example.test/external.png 1x">\n',
  );
  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /references non-local resource https:\/\/example\.test\/external\.png/,
  );
});

test("member imports are excluded while literal dynamic imports remain transitive", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "scripts/entry.mjs",
    [
      'void import("./present.mjs", { with: { type: "javascript" } });',
      'loader.import("./missing.mjs");',
      "",
    ].join("\n"),
  );
  await writeFixtureFile(fixtureRoot, "scripts/present.mjs");

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["scripts/entry.mjs"],
    }),
    ["scripts/entry.mjs", "scripts/present.mjs"],
  );
});

test("static graph validation walks transitive modules and resources", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    "<link href='styles/main.css' rel=stylesheet><script src=scripts/entry.mjs type=module></script>\n",
  );
  await writeFixtureFile(
    fixtureRoot,
    "styles/main.css",
    "@import './theme.css';\nbody { background: url('../images/background.svg'); }\n",
  );
  await writeFixtureFile(fixtureRoot, "styles/theme.css");
  await writeFixtureFile(fixtureRoot, "images/background.svg", "<svg></svg>\n");
  await writeFixtureFile(fixtureRoot, "images/icon.svg", "<svg></svg>\n");
  await writeFixtureFile(
    fixtureRoot,
    "scripts/entry.mjs",
    "import './nested/first.mjs';\nnew URL('../images/icon.svg', import.meta.url);\n",
  );
  await writeFixtureFile(
    fixtureRoot,
    "scripts/nested/first.mjs",
    "export { value } from './second.mjs';\n",
  );
  await writeFixtureFile(fixtureRoot, "scripts/nested/second.mjs", "export const value = 1;\n");

  assert.deepEqual(
    await validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    [
      "images/background.svg",
      "images/icon.svg",
      "index.html",
      "scripts/entry.mjs",
      "scripts/nested/first.mjs",
      "scripts/nested/second.mjs",
      "styles/main.css",
      "styles/theme.css",
    ],
  );

  await writeFixtureFile(fixtureRoot, "scripts/bare.mjs", "import 'unpackaged-module';\n");
  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["scripts/bare.mjs"],
    }),
    /uses non-local module specifier unpackaged-module/,
  );
});

test("packaged entries and graph resources must be regular files", async (t) => {
  const fixtureRoot = await createFixture(t);
  await mkdir(path.join(fixtureRoot, "directory-entry"));
  await writeFixtureFile(fixtureRoot, "real-entry.mjs");
  await symlink("real-entry.mjs", path.join(fixtureRoot, "linked-entry.mjs"));
  await writeFixtureFile(
    fixtureRoot,
    "index.html",
    "<script src='directory-entry'></script>\n",
  );

  await assert.rejects(
    assertRegularFile(path.join(fixtureRoot, "directory-entry"), "directory-entry"),
    /directory-entry must be a packaged regular file/,
  );
  await assert.rejects(
    assertRegularFile(path.join(fixtureRoot, "linked-entry.mjs"), "linked-entry.mjs"),
    /linked-entry\.mjs must be a packaged regular file/,
  );
  await assert.rejects(
    validateStaticResourceGraph({
      projectRoot: fixtureRoot,
      entryFiles: ["index.html"],
    }),
    /directory-entry must be a packaged regular file/,
  );
});
