// @ts-check

import {
  buildPdfJsViewerUrl,
  parseViewerFileQuery,
  ViewerInputError,
} from "./viewer-url.mjs";

/** @typedef {ReturnType<typeof import("./viewer-view.mjs").createViewerView>} ViewerView */
/** @typedef {{ fileUrl: string, objectUrl: string }} BootedViewer */

const READ_ERROR =
  "The local PDF could not be read. Verify that the file still exists and can be opened.";

/**
 * @param {{
 *   search: unknown,
 *   fetchPdf: typeof globalThis.fetch,
 *   createObjectUrl: (blob: Blob) => string,
 *   isFileSchemeAccessAllowed: () => boolean | PromiseLike<boolean>,
 *   pdfJsViewerUrl: URL,
 *   view: ViewerView,
 * }} options
 * @returns {Promise<BootedViewer | undefined>}
 */
export async function bootViewer({
  search,
  fetchPdf,
  createObjectUrl,
  isFileSchemeAccessAllowed,
  pdfJsViewerUrl,
  view,
}) {
  try {
    const fileUrl = parseViewerFileQuery(search);
    if (!(await isFileSchemeAccessAllowed())) {
      view.showFileAccessInstructions();
      return undefined;
    }

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
    return { fileUrl: fileUrl.href, objectUrl };
  } catch (error) {
    view.showError(
      error instanceof ViewerInputError ? error.message : READ_ERROR,
    );
  }
}
