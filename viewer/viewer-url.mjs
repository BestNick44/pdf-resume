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

  let fileUrl;
  try {
    fileUrl = new URL(decodedUrl);
  } catch {
    throw new ViewerInputError();
  }

  if (
    fileUrl.protocol !== "file:" ||
    (fileUrl.hostname && fileUrl.hostname !== "localhost") ||
    fileUrl.username ||
    fileUrl.password ||
    fileUrl.port
  ) {
    throw new ViewerInputError();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(fileUrl.pathname);
  } catch {
    throw new ViewerInputError();
  }

  if (!/\.pdf$/i.test(pathname) || pathname.includes("\0")) {
    throw new ViewerInputError();
  }

  return fileUrl;
}

export function buildPdfJsViewerUrl(objectUrl, fileUrl, viewerUrl) {
  const filename = fileUrl.pathname.split("/").at(-1);
  const pdfJsUrl = new URL(viewerUrl);
  pdfJsUrl.search = new URLSearchParams({ file: `${objectUrl}#${filename}` });
  return pdfJsUrl;
}
