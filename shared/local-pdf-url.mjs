const LOCAL_PDF_URL_ERROR = "URL must be a valid local file:// PDF URL";

export function canonicalizeLocalPdfUrl(value) {
  if (typeof value !== "string") {
    throw new TypeError(LOCAL_PDF_URL_ERROR);
  }

  let fileUrl;
  try {
    fileUrl = new URL(value);
  } catch {
    throw new TypeError(LOCAL_PDF_URL_ERROR);
  }

  if (
    fileUrl.protocol !== "file:" ||
    fileUrl.hostname !== "" ||
    fileUrl.username ||
    fileUrl.password ||
    fileUrl.port
  ) {
    throw new TypeError(LOCAL_PDF_URL_ERROR);
  }

  let pathname;
  try {
    pathname = decodeURIComponent(fileUrl.pathname);
  } catch {
    throw new TypeError(LOCAL_PDF_URL_ERROR);
  }

  if (!/\.pdf$/i.test(pathname) || pathname.includes("\0")) {
    throw new TypeError(LOCAL_PDF_URL_ERROR);
  }

  return fileUrl;
}
