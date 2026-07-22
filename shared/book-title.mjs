// @ts-check

const UNSAFE_TITLE_CHARACTERS =
  /[\p{Cc}\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;
const URL_LIKE_TITLE = /^(?:blob|data|file|https?|javascript):/iu;
const ABSOLUTE_PATH_TITLE = /^(?:[a-z]:[\\/]|[\\/]{1,2})/iu;
const PDF_PATH_TITLE = /[\\/][^\\/]*\.pdf$/iu;
const TITLE_SEPARATOR_NOISE = /[\s._–—-]/gu;
const INVISIBLE_OR_CONTROL_FORMATTING = /[\p{Cc}\p{Cf}]/gu;

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function removeUnsafeFilenameFormatting(value) {
  return value.replace(INVISIBLE_OR_CONTROL_FORMATTING, (character) =>
    character === "\u200C" || character === "\u200D" ? character : "",
  );
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasMeaningfulTitleContent(value) {
  return (
    value
      .replace(TITLE_SEPARATOR_NOISE, "")
      .replace(INVISIBLE_OR_CONTROL_FORMATTING, "").length > 0
  );
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizePdfMetadataTitle(value) {
  if (typeof value !== "string" || UNSAFE_TITLE_CHARACTERS.test(value)) {
    return undefined;
  }

  const title = normalizeWhitespace(value.normalize("NFC"));
  if (
    !hasMeaningfulTitleContent(title) ||
    URL_LIKE_TITLE.test(title) ||
    ABSOLUTE_PATH_TITLE.test(title) ||
    PDF_PATH_TITLE.test(title)
  ) {
    return undefined;
  }
  return title;
}

/**
 * @param {unknown} metadataResult
 * @returns {string | undefined}
 */
function titleFromPdfMetadata(metadataResult) {
  if (
    metadataResult === null ||
    typeof metadataResult !== "object" ||
    Array.isArray(metadataResult)
  ) {
    return undefined;
  }
  const infoDescriptor = Object.getOwnPropertyDescriptor(metadataResult, "info");
  if (!infoDescriptor || !("value" in infoDescriptor)) {
    return undefined;
  }
  const info = infoDescriptor.value;
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    return undefined;
  }
  const title = Object.getOwnPropertyDescriptor(info, "Title");
  return title && "value" in title
    ? normalizePdfMetadataTitle(title.value)
    : undefined;
}

/**
 * @param {string} fileUrl
 * @returns {string}
 */
export function titleFromLocalPdfFilename(fileUrl) {
  const url = new URL(fileUrl);
  const encodedFilename = /** @type {string} */ (url.pathname.split("/").at(-1));
  const decodedFilename = removeUnsafeFilenameFormatting(
    decodeURIComponent(encodedFilename).normalize("NFC"),
  );
  const withoutExtension = decodedFilename.replace(/\.pdf$/iu, "");
  const cleaned = withoutExtension
    .replace(/_+/gu, " ")
    .replace(/-{2,}/gu, " ")
    .replace(/\s+[-–—]\s+/gu, " ")
    .replace(/^[\s._–—-]+|[\s._–—-]+$/gu, "");
  const title = normalizeWhitespace(cleaned);
  return hasMeaningfulTitleContent(title) ? title : "untitled";
}

/**
 * @param {unknown} metadataResult
 * @param {string} fileUrl
 * @returns {string}
 */
export function resolveAutomaticBookTitle(metadataResult, fileUrl) {
  return titleFromPdfMetadata(metadataResult) ?? titleFromLocalPdfFilename(fileUrl);
}
