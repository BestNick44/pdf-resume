// @ts-check

import { parseViewerFileQuery, ViewerInputError } from "./viewer-url.mjs";

/** @typedef {ReturnType<typeof import("./viewer-view.mjs").createViewerView>} ViewerView */
/** @typedef {{ fileUrl: string, objectUrl?: string }} BootedViewer */

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

    view.showViewer(pdfJsViewerUrl);
    await view.openDocument(fileUrl.href, fileUrl.href);
    return { fileUrl: fileUrl.href };
  } catch (error) {
    view.showError(
      error instanceof ViewerInputError ? error.message : READ_ERROR,
    );
  }
}
