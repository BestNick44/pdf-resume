import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";

const INPUT_ERROR = "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.";

export class ViewerInputError extends Error {
  constructor() {
    super(INPUT_ERROR);
    this.name = "ViewerInputError";
  }
}

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

export function buildPdfJsViewerUrl(objectUrl, fileUrl, viewerUrl) {
  const filename = fileUrl.pathname.split("/").at(-1);
  const pdfJsUrl = new URL(viewerUrl);
  pdfJsUrl.search = new URLSearchParams({ file: `${objectUrl}#${filename}` });
  return pdfJsUrl;
}
