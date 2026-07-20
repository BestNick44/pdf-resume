const UNSAFE_TITLE_CHARACTERS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const URL_LIKE_TITLE = /^(?:blob|data|file|https?|javascript):/iu;
const ABSOLUTE_PATH_TITLE = /^(?:[a-z]:[\\/]|[\\/]{1,2})/iu;
const PDF_PATH_TITLE = /[\\/][^\\/]*\.pdf$/iu;

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

export function normalizePdfMetadataTitle(value) {
  if (typeof value !== "string" || UNSAFE_TITLE_CHARACTERS.test(value)) {
    return undefined;
  }

  const title = normalizeWhitespace(value.normalize("NFC"));
  if (
    !title ||
    URL_LIKE_TITLE.test(title) ||
    ABSOLUTE_PATH_TITLE.test(title) ||
    PDF_PATH_TITLE.test(title)
  ) {
    return undefined;
  }
  return title;
}

export function titleFromPdfMetadata(metadataResult) {
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

export function titleFromLocalPdfFilename(fileUrl) {
  const url = new URL(fileUrl);
  const encodedFilename = url.pathname.split("/").at(-1);
  const decodedFilename = decodeURIComponent(encodedFilename).normalize("NFC");
  const withoutExtension = decodedFilename.replace(/\.pdf$/iu, "");
  const cleaned = withoutExtension
    .replace(/_+/gu, " ")
    .replace(/-{2,}/gu, " ")
    .replace(/\s+[-–—]\s+/gu, " ")
    .replace(/^[\s._–—-]+|[\s._–—-]+$/gu, "");
  return (
    normalizeWhitespace(cleaned) ||
    normalizeWhitespace(withoutExtension) ||
    "untitled"
  );
}

export function resolveAutomaticBookTitle(metadataResult, fileUrl) {
  return titleFromPdfMetadata(metadataResult) ?? titleFromLocalPdfFilename(fileUrl);
}
