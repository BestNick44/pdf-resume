// @ts-check

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ignoredDirectoryNames = new Set([".git", "node_modules"]);
const appVendorDirectory = path.join("viewer", "pdfjs");

/**
 * @typedef {object} FileDiscoveryOptions
 * @property {Set<string>} [extensions]
 * @property {Set<string>} [excludedDirectories]
 * @property {string} [root]
 */

/**
 * @typedef {object} RepositoryDiscoveryOptions
 * @property {Set<string>} [extensions]
 * @property {boolean} [excludeAppVendor]
 */

/** @typedef {{ type: "identifier" | "punctuation" | "string", value: string }} JavaScriptToken */

/** @param {string} filePath */
function portablePath(filePath) {
  return filePath.split(path.sep).join("/");
}

/**
 * @param {string} directory
 * @param {FileDiscoveryOptions} [options]
 * @returns {Promise<string[]>}
 */
async function walkRegularFiles(
  directory,
  { extensions, excludedDirectories = new Set(), root = directory } = {},
) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".brave-")) {
      continue;
    }

    const entryPath = path.join(directory, entry.name);
    const relativePath = path.relative(root, entryPath);
    if (entry.isDirectory()) {
      if (
        !ignoredDirectoryNames.has(entry.name) &&
        !excludedDirectories.has(relativePath)
      ) {
        files.push(
          ...(await walkRegularFiles(entryPath, {
            extensions,
            excludedDirectories,
            root,
          })),
        );
      }
    } else if (
      entry.isFile() &&
      (!extensions || extensions.has(path.extname(entry.name)))
    ) {
      files.push(entryPath);
    }
  }

  return files;
}

/**
 * @param {string} projectRoot
 * @param {RepositoryDiscoveryOptions} [options]
 */
export async function discoverRepositoryFiles(
  projectRoot,
  { extensions, excludeAppVendor = false } = {},
) {
  const excludedDirectories = excludeAppVendor
    ? new Set([appVendorDirectory])
    : new Set();
  return walkRegularFiles(projectRoot, {
    extensions,
    excludedDirectories,
    root: projectRoot,
  });
}

/** @param {string} projectRoot */
export async function discoverAppJavaScriptFiles(projectRoot) {
  return discoverRepositoryFiles(projectRoot, {
    extensions: new Set([".js", ".mjs"]),
    excludeAppVendor: true,
  });
}

/** @param {string} projectRoot */
export async function discoverAppHtmlFiles(projectRoot) {
  return discoverRepositoryFiles(projectRoot, {
    extensions: new Set([".html"]),
    excludeAppVendor: true,
  });
}

/** @param {string} testRoot */
export async function discoverTestSuites(testRoot) {
  const files = await walkRegularFiles(testRoot, {
    extensions: new Set([".mjs"]),
  });
  const suites = files.filter((filePath) => filePath.endsWith(".test.mjs"));

  if (suites.length === 0) {
    throw new Error(`No *.test.mjs suites found recursively under ${testRoot}`);
  }

  return suites;
}

/**
 * @param {string} filePath
 * @param {string} [label]
 */
export async function assertRegularFile(filePath, label = filePath) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    throw new Error(`${label} must be a packaged regular file`, { cause: error });
  }

  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a packaged regular file`);
  }
}

/**
 * @param {string} source
 * @param {number} startIndex
 */
function readQuotedJavaScriptString(source, startIndex) {
  const quote = source[startIndex];
  let value = "";
  let index = startIndex + 1;

  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return { endIndex: index + 1, value };
    }
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === "\n" || escaped === "\r") {
      index += escaped === "\r" && source[index + 2] === "\n" ? 3 : 2;
      continue;
    }

    /** @type {Record<string, string>} */
    const escapes = {
      "0": "\0",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    value += escapes[escaped] ?? escaped;
    index += 2;
  }

  throw new Error("Unterminated JavaScript string while discovering module imports");
}

/** @param {string} source */
function javaScriptTokens(source) {
  /** @type {JavaScriptToken[]} */
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const stringToken = readQuotedJavaScriptString(source, index);
      tokens.push({ type: "string", value: stringToken.value });
      index = stringToken.endIndex;
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === "`") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[\w$]/u.test(source[index])) {
        index += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, index) });
      continue;
    }

    tokens.push({ type: "punctuation", value: character });
    index += 1;
  }

  return tokens;
}

/** @param {string} source */
export function discoverStaticModuleSpecifiers(source) {
  const tokens = javaScriptTokens(source);
  const specifiers = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier" || !["import", "export"].includes(token.value)) {
      continue;
    }

    const previousToken = tokens[index - 1];
    if (
      token.value === "import" &&
      previousToken?.type === "punctuation" &&
      previousToken.value === "."
    ) {
      continue;
    }

    const nextToken = tokens[index + 1];
    if (token.value === "import" && nextToken?.type === "string") {
      specifiers.push(nextToken.value);
      continue;
    }
    if (
      token.value === "import" &&
      nextToken?.type === "punctuation" &&
      nextToken.value === "("
    ) {
      const specifierToken = tokens[index + 2];
      const followingToken = tokens[index + 3];
      if (
        specifierToken?.type === "string" &&
        followingToken?.type === "punctuation" &&
        [")", ","].includes(followingToken.value)
      ) {
        specifiers.push(specifierToken.value);
      }
      continue;
    }
    if (
      token.value === "import" &&
      nextToken?.type === "punctuation" &&
      nextToken.value === "."
    ) {
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor];
      if (candidate.type === "punctuation" && candidate.value === ";") {
        break;
      }
      if (
        cursor > index + 1 &&
        candidate.type === "identifier" &&
        ["import", "export"].includes(candidate.value)
      ) {
        break;
      }
      if (
        candidate.type === "identifier" &&
        candidate.value === "from" &&
        tokens[cursor + 1]?.type === "string"
      ) {
        specifiers.push(tokens[cursor + 1].value);
        break;
      }
    }
  }

  return specifiers;
}

/** @param {string} source */
export function discoverImportMetaUrlReferences(source) {
  const tokens = javaScriptTokens(source);
  const references = [];
  const expectedTail = [
    ["punctuation", ","],
    ["identifier", "import"],
    ["punctuation", "."],
    ["identifier", "meta"],
    ["punctuation", "."],
    ["identifier", "url"],
    ["punctuation", ")"],
  ];

  for (let index = 0; index < tokens.length - 10; index += 1) {
    if (
      tokens[index].type !== "identifier" ||
      tokens[index].value !== "new" ||
      tokens[index + 1]?.type !== "identifier" ||
      tokens[index + 1]?.value !== "URL" ||
      tokens[index + 2]?.type !== "punctuation" ||
      tokens[index + 2]?.value !== "(" ||
      tokens[index + 3]?.type !== "string"
    ) {
      continue;
    }

    const tailMatches = expectedTail.every(
      ([type, value], offset) =>
        tokens[index + 4 + offset]?.type === type &&
        tokens[index + 4 + offset]?.value === value,
    );
    if (tailMatches) {
      references.push(tokens[index + 3].value);
    }
  }

  return references;
}

const htmlNamedCharacterReferences = new Map([
  ["AMP", "&"],
  ["GT", ">"],
  ["LT", "<"],
  ["QUOT", '"'],
  ["amp", "&"],
  ["apos", "'"],
  ["bsol", "\\"],
  ["colon", ":"],
  ["copy", "©"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", "\u00a0"],
  ["num", "#"],
  ["percnt", "%"],
  ["period", "."],
  ["quest", "?"],
  ["quot", '"'],
  ["semi", ";"],
  ["sol", "/"],
]);
const htmlLegacyNamedCharacterReferences = new Set([
  "AMP",
  "GT",
  "LT",
  "QUOT",
  "amp",
  "gt",
  "lt",
  "quot",
]);
const htmlNumericCharacterReferenceReplacements = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

/**
 * @param {string} digits
 * @param {number} radix
 */
function decodeHtmlNumericCharacterReference(digits, radix) {
  let codePoint = Number.parseInt(digits, radix);
  if (
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    codePoint = 0xfffd;
  } else {
    codePoint = htmlNumericCharacterReferenceReplacements.get(codePoint) ?? codePoint;
  }
  return String.fromCodePoint(codePoint);
}

/** @param {string} value */
function decodeHtmlCharacterReferences(value) {
  let decodedValue = "";
  let index = 0;

  while (index < value.length) {
    const referenceStart = value.indexOf("&", index);
    if (referenceStart === -1) {
      decodedValue += value.slice(index);
      break;
    }
    decodedValue += value.slice(index, referenceStart);

    let cursor = referenceStart + 1;
    if (value[cursor] === "#") {
      cursor += 1;
      let radix = 10;
      if (value[cursor] === "x" || value[cursor] === "X") {
        radix = 16;
        cursor += 1;
      }

      const digitsStart = cursor;
      const digitPattern = radix === 16 ? /[\da-f]/iu : /\d/u;
      while (digitPattern.test(value[cursor] ?? "")) {
        cursor += 1;
      }
      if (cursor !== digitsStart) {
        decodedValue += decodeHtmlNumericCharacterReference(
          value.slice(digitsStart, cursor),
          radix,
        );
        index = value[cursor] === ";" ? cursor + 1 : cursor;
        continue;
      }
    } else if (/[a-z]/iu.test(value[cursor] ?? "")) {
      cursor += 1;
      while (/[a-z\d]/iu.test(value[cursor] ?? "")) {
        cursor += 1;
      }

      const name = value.slice(referenceStart + 1, cursor);
      const reference = `&${name}`;
      if (value[cursor] === ";") {
        const decodedReference = htmlNamedCharacterReferences.get(name);
        if (decodedReference === undefined) {
          throw new Error(
            `Unsupported HTML named character reference ${reference}; in resource attribute`,
          );
        }
        decodedValue += decodedReference;
        index = cursor + 1;
        continue;
      }

      const nextCharacter = value[cursor];
      if (
        htmlLegacyNamedCharacterReferences.has(name) &&
        nextCharacter !== "=" &&
        !/[a-z\d]/iu.test(nextCharacter ?? "")
      ) {
        decodedValue += htmlNamedCharacterReferences.get(name);
        index = cursor;
        continue;
      }

      const legacyReferenceIsBlocked = [
        ...htmlLegacyNamedCharacterReferences,
      ].some((legacyName) => {
        if (!value.startsWith(legacyName, referenceStart + 1)) {
          return false;
        }
        const legacyNextCharacter = value[
          referenceStart + legacyName.length + 1
        ];
        return (
          legacyNextCharacter === "=" ||
          /[a-z\d]/iu.test(legacyNextCharacter ?? "")
        );
      });
      if (!legacyReferenceIsBlocked && nextCharacter !== "=") {
        throw new Error(
          `Unsupported semicolonless HTML named character reference ${reference} in resource attribute`,
        );
      }

      decodedValue += value.slice(referenceStart, cursor);
      index = cursor;
      continue;
    }

    decodedValue += "&";
    index = referenceStart + 1;
  }

  return decodedValue;
}

/**
 * @param {string} source
 * @param {number} startIndex
 */
function findHtmlCommentEnd(source, startIndex) {
  let index = startIndex + 4;
  let state = "start";

  while (index < source.length) {
    const character = source[index];
    if (state === "start") {
      if (character === ">") {
        return index + 1;
      }
      state = character === "-" ? "start-dash" : "comment";
    } else if (state === "start-dash") {
      if (character === ">") {
        return index + 1;
      }
      state = character === "-" ? "end" : "comment";
    } else if (state === "comment") {
      if (character === "-") {
        state = "end-dash";
      }
    } else if (state === "end-dash") {
      state = character === "-" ? "end" : "comment";
    } else if (state === "end") {
      if (character === ">") {
        return index + 1;
      }
      if (character === "!") {
        state = "end-bang";
      } else if (character !== "-") {
        state = "comment";
      }
    } else {
      if (character === ">") {
        return index + 1;
      }
      state = character === "-" ? "end-dash" : "comment";
    }
    index += 1;
  }

  return source.length;
}

/**
 * @param {string} source
 * @param {number} startIndex
 */
function findHtmlTagEnd(source, startIndex) {
  let index = startIndex;
  let state = "before-attribute-name";

  while (index < source.length) {
    const character = source[index];

    if (state === "before-attribute-name") {
      if (/[\t\n\f\r ]/u.test(character)) {
        index += 1;
      } else if (character === "/") {
        state = "self-closing";
        index += 1;
      } else if (character === ">") {
        return index;
      } else if (character === "=") {
        state = "attribute-name";
        index += 1;
      } else {
        state = "attribute-name";
      }
    } else if (state === "attribute-name") {
      if (/[\t\n\f\r ]/u.test(character)) {
        state = "after-attribute-name";
        index += 1;
      } else if (character === "/") {
        state = "after-attribute-name";
      } else if (character === "=") {
        state = "before-attribute-value";
        index += 1;
      } else if (character === ">") {
        return index;
      } else {
        index += 1;
      }
    } else if (state === "after-attribute-name") {
      if (/[\t\n\f\r ]/u.test(character)) {
        index += 1;
      } else if (character === "/") {
        state = "self-closing";
        index += 1;
      } else if (character === "=") {
        state = "before-attribute-value";
        index += 1;
      } else if (character === ">") {
        return index;
      } else {
        state = "attribute-name";
      }
    } else if (state === "before-attribute-value") {
      if (/[\t\n\f\r ]/u.test(character)) {
        index += 1;
      } else if (character === '"') {
        state = "double-quoted-attribute-value";
        index += 1;
      } else if (character === "'") {
        state = "single-quoted-attribute-value";
        index += 1;
      } else if (character === ">") {
        return index;
      } else {
        state = "unquoted-attribute-value";
      }
    } else if (state === "double-quoted-attribute-value") {
      if (character === '"') {
        state = "after-quoted-attribute-value";
      }
      index += 1;
    } else if (state === "single-quoted-attribute-value") {
      if (character === "'") {
        state = "after-quoted-attribute-value";
      }
      index += 1;
    } else if (state === "unquoted-attribute-value") {
      if (/[\t\n\f\r ]/u.test(character)) {
        state = "before-attribute-name";
        index += 1;
      } else if (character === ">") {
        return index;
      } else {
        index += 1;
      }
    } else if (state === "after-quoted-attribute-value") {
      if (/[\t\n\f\r ]/u.test(character)) {
        state = "before-attribute-name";
        index += 1;
      } else if (character === "/") {
        state = "self-closing";
        index += 1;
      } else if (character === ">") {
        return index;
      } else {
        state = "before-attribute-name";
      }
    } else if (character === ">") {
      return index;
    } else {
      state = "before-attribute-name";
    }
  }

  return -1;
}

const htmlTextElementStates = new Map([
  ["iframe", "raw-text"],
  ["noembed", "raw-text"],
  ["noframes", "raw-text"],
  ["noscript", "raw-text"],
  ["plaintext", "plaintext"],
  ["script", "script-data"],
  ["style", "raw-text"],
  ["textarea", "rcdata"],
  ["title", "rcdata"],
  ["xmp", "raw-text"],
]);

/**
 * @param {string} source
 * @param {number} startIndex
 * @param {string} tagName
 */
function findHtmlTextElementEnd(source, startIndex, tagName) {
  let index = startIndex;

  while (index < source.length) {
    const tagStart = source.indexOf("<", index);
    if (tagStart === -1) {
      return source.length;
    }

    const nameStart = tagStart + 2;
    const nameEnd = nameStart + tagName.length;
    const isMatchingClosingTag =
      source[tagStart + 1] === "/" &&
      source.slice(nameStart, nameEnd).toLowerCase() === tagName &&
      /[\t\n\f\r />]/u.test(source[nameEnd] ?? "");
    if (!isMatchingClosingTag) {
      index = tagStart + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(source, nameEnd);
    return tagEnd === -1 ? source.length : tagEnd + 1;
  }

  return source.length;
}

/**
 * @param {string} source
 * @param {number} startIndex
 * @param {number} endIndex
 * @param {string} attributeName
 */
function htmlAttributeValue(source, startIndex, endIndex, attributeName) {
  let index = startIndex;

  while (index < endIndex) {
    while (index < endIndex && /\s/u.test(source[index])) {
      index += 1;
    }
    if (source[index] === "/") {
      index += 1;
      continue;
    }

    const nameStart = index;
    while (
      index < endIndex &&
      !/[\s"'=<>\x60/]/u.test(source[index])
    ) {
      index += 1;
    }
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index).toLowerCase();

    while (index < endIndex && /\s/u.test(source[index])) {
      index += 1;
    }
    if (source[index] !== "=") {
      continue;
    }
    index += 1;
    while (index < endIndex && /\s/u.test(source[index])) {
      index += 1;
    }

    let value;
    if (source[index] === '"' || source[index] === "'") {
      const quote = source[index];
      const valueStart = index + 1;
      index = source.indexOf(quote, valueStart);
      if (index === -1 || index > endIndex) {
        return undefined;
      }
      value = source.slice(valueStart, index);
      index += 1;
    } else {
      const valueStart = index;
      while (index < endIndex && !/\s/u.test(source[index])) {
        index += 1;
      }
      value = source.slice(valueStart, index);
    }

    if (name === attributeName) {
      return decodeHtmlCharacterReferences(value);
    }
  }

  return undefined;
}

/** @param {string} value */
function discoverSrcsetReferences(value) {
  const references = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && (/[\t\n\f\r ]/u.test(value[index]) || value[index] === ",")) {
      index += 1;
    }
    if (index === value.length) {
      break;
    }

    const urlStart = index;
    while (index < value.length && !/[\t\n\f\r ]/u.test(value[index])) {
      index += 1;
    }
    let reference = value.slice(urlStart, index);
    if (reference.endsWith(",")) {
      reference = reference.replace(/,+$/u, "");
      if (reference !== "") {
        references.push(reference);
      }
      continue;
    }
    references.push(reference);

    let insideParentheses = false;
    while (index < value.length) {
      const character = value[index];
      if (character === "(") {
        insideParentheses = true;
      } else if (character === ")") {
        insideParentheses = false;
      } else if (character === "," && !insideParentheses) {
        index += 1;
        break;
      }
      index += 1;
    }
  }

  return references;
}

/** @param {string} source */
export function discoverHtmlResourceReferences(source) {
  const references = [];
  const resourceAttributes = new Map([
    ["audio", ["src"]],
    ["embed", ["src"]],
    ["iframe", ["src"]],
    ["img", ["src", "srcset"]],
    ["input", ["src"]],
    ["link", ["href"]],
    ["object", ["data"]],
    ["script", ["src"]],
    ["source", ["src", "srcset"]],
    ["track", ["src"]],
    ["video", ["src", "poster"]],
  ]);
  let index = 0;

  while (index < source.length) {
    const tagStart = source.indexOf("<", index);
    if (tagStart === -1) {
      break;
    }
    if (source.startsWith("<!--", tagStart)) {
      index = findHtmlCommentEnd(source, tagStart);
      continue;
    }

    const nameStart = tagStart + 1;
    if (!/[a-z]/iu.test(source[nameStart] ?? "")) {
      index = nameStart;
      continue;
    }
    let nameEnd = nameStart + 1;
    while (/[\w-]/u.test(source[nameEnd] ?? "")) {
      nameEnd += 1;
    }

    const tagName = source.slice(nameStart, nameEnd).toLowerCase();
    if (tagName === "base") {
      throw new Error(
        "HTML <base> elements are unsupported by static resource validation",
      );
    }

    const tagEnd = findHtmlTagEnd(source, nameEnd);
    if (tagEnd === -1) {
      break;
    }
    const attributeNames = resourceAttributes.get(tagName);
    for (const attributeName of attributeNames ?? []) {
      const reference = htmlAttributeValue(
        source,
        nameEnd,
        tagEnd,
        attributeName,
      );
      if (reference === undefined) {
        continue;
      }
      if (attributeName === "srcset") {
        references.push(...discoverSrcsetReferences(reference));
      } else {
        references.push(reference);
      }
    }

    const textElementState = htmlTextElementStates.get(tagName);
    if (textElementState === "plaintext") {
      break;
    }
    index =
      textElementState === undefined
        ? tagEnd + 1
        : findHtmlTextElementEnd(source, tagEnd + 1, tagName);
  }

  return references;
}

/** @param {string} source */
export function discoverCssResourceReferences(source) {
  const references = [];
  const resourcePattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"')]+))\s*\)/gi;
  const importPattern = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

  for (const match of source.matchAll(resourcePattern)) {
    references.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of source.matchAll(importPattern)) {
    references.push(match[1] ?? match[2]);
  }

  return references;
}

/**
 * @param {string} projectRoot
 * @param {string} containingFile
 * @param {string} reference
 * @param {{ moduleSpecifier?: boolean }} [options]
 */
function resolveLocalReference(
  projectRoot,
  containingFile,
  reference,
  { moduleSpecifier = false } = {},
) {
  const relativeContainingFile = portablePath(path.relative(projectRoot, containingFile));
  if (moduleSpecifier && !reference.startsWith(".") && !reference.startsWith("/")) {
    throw new Error(
      `${relativeContainingFile} uses non-local module specifier ${reference}`,
    );
  }
  if (reference === "" || reference.startsWith("#") || reference.startsWith("data:")) {
    return undefined;
  }

  const pathReference = reference.split(/[?#]/u, 1)[0].replaceAll("\\", "/");
  if (/^[a-z][a-z\d+.-]*:/i.test(pathReference) || pathReference.startsWith("//")) {
    throw new Error(
      `${relativeContainingFile} references non-local resource ${reference}`,
    );
  }

  let decodedReference;
  try {
    decodedReference = decodeURIComponent(pathReference).replaceAll("\\", "/");
  } catch (error) {
    throw new Error(`Invalid encoded resource path ${reference}`, { cause: error });
  }
  if (decodedReference.startsWith("//")) {
    throw new Error(
      `${relativeContainingFile} references non-local resource ${reference}`,
    );
  }

  const resolvedPath = decodedReference.startsWith("/")
    ? path.resolve(projectRoot, `.${decodedReference}`)
    : path.resolve(path.dirname(containingFile), decodedReference);
  if (
    resolvedPath !== projectRoot &&
    !resolvedPath.startsWith(`${projectRoot}${path.sep}`)
  ) {
    throw new Error(`${reference} must stay inside the extension`);
  }
  return resolvedPath;
}

/**
 * @param {{ projectRoot: string, entryFiles: string[] }} options
 */
export async function validateStaticResourceGraph({ projectRoot, entryFiles }) {
  const pending = entryFiles.map((entryFile) =>
    path.isAbsolute(entryFile) ? entryFile : path.resolve(projectRoot, entryFile),
  );
  /** @type {Set<string>} */
  const visited = new Set();

  while (pending.length > 0) {
    const filePath = /** @type {string} */ (pending.shift());
    const relativePath = portablePath(path.relative(projectRoot, filePath));
    if (visited.has(relativePath)) {
      continue;
    }

    await assertRegularFile(filePath, relativePath);
    visited.add(relativePath);

    if (
      relativePath === portablePath(appVendorDirectory) ||
      relativePath.startsWith(`${portablePath(appVendorDirectory)}/`)
    ) {
      continue;
    }

    const extension = path.extname(filePath);
    if (![".css", ".html", ".js", ".mjs"].includes(extension)) {
      continue;
    }

    const source = await readFile(filePath, "utf8");
    /** @type {string[]} */
    let resourceReferences = [];
    /** @type {string[]} */
    let moduleSpecifiers = [];
    if (extension === ".html") {
      resourceReferences = discoverHtmlResourceReferences(source);
    } else if (extension === ".css") {
      resourceReferences = discoverCssResourceReferences(source);
    } else {
      moduleSpecifiers = discoverStaticModuleSpecifiers(source);
      resourceReferences = discoverImportMetaUrlReferences(source);
    }

    for (const reference of moduleSpecifiers) {
      const modulePath = /** @type {string} */ (
        resolveLocalReference(projectRoot, filePath, reference, {
          moduleSpecifier: true,
        })
      );
      pending.push(modulePath);
    }
    for (const reference of resourceReferences) {
      const resourcePath = resolveLocalReference(projectRoot, filePath, reference);
      if (resourcePath) {
        pending.push(resourcePath);
      }
    }
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}
