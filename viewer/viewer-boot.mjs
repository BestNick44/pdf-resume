import {
  buildPdfJsViewerUrl,
  parseViewerFileQuery,
  ViewerInputError,
} from "./viewer-url.mjs";

const READ_ERROR =
  "The local PDF could not be read. Enable “Allow access to file URLs” for pdf-resume and verify that the file still exists.";

export async function bootViewer({
  search,
  fetchPdf,
  createObjectUrl,
  pdfJsViewerUrl,
  view,
}) {
  try {
    const fileUrl = parseViewerFileQuery(search);
    const response = await fetchPdf(fileUrl.href, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Local file request failed (${response.status}).`);
    }

    const pdfBlob = await response.blob();
    const signatureBytes = await pdfBlob.slice(0, 1024).arrayBuffer();
    const signature = new TextDecoder("ascii").decode(signatureBytes);
    if (!signature.includes("%PDF-")) {
      throw new ViewerInputError();
    }

    const objectUrl = createObjectUrl(pdfBlob);
    view.showViewer(buildPdfJsViewerUrl(objectUrl, fileUrl, pdfJsViewerUrl));
    return objectUrl;
  } catch (error) {
    view.showError(error instanceof ViewerInputError ? error.message : READ_ERROR);
  }
}
