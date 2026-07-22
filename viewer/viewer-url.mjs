// @ts-check

import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";

const INPUT_ERROR =
  "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.";

export class ViewerInputError extends Error {
  constructor() {
    super(INPUT_ERROR);
    this.name = "ViewerInputError";
  }
}

/**
 * @param {unknown} search
 * @returns {URL}
 */
export function parseViewerFileQuery(search) {
  if (typeof search !== "string" || !search.startsWith("?file=")) {
    throw new ViewerInputError();
  }

  const encodedUrl = search.slice("?file=".length);
  if (!encodedUrl || encodedUrl.includes("&")) {
    throw new ViewerInputError();
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(encodedUrl);
  } catch {
    throw new ViewerInputError();
  }

  if (encodeURIComponent(decodedUrl) !== encodedUrl) {
    throw new ViewerInputError();
  }

  try {
    return canonicalizeLocalPdfUrl(decodedUrl);
  } catch {
    throw new ViewerInputError();
  }
}

/**
 * @param {string} objectUrl
 * @param {URL} fileUrl
 * @param {URL} viewerUrl
 * @returns {URL}
 */
export function buildPdfJsViewerUrl(objectUrl, fileUrl, viewerUrl) {
  const filename = fileUrl.pathname.split("/").at(-1);
  const pdfJsUrl = new URL(viewerUrl);
  /** @type {{ search: string | URLSearchParams }} */ (pdfJsUrl).search =
    new URLSearchParams({ file: `${objectUrl}#${filename}` });
  return pdfJsUrl;
}
