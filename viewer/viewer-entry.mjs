import { getBook, updatePosition } from "../storage/books.mjs";

import { createPdfJsPositionTracking } from "./pdfjs-position-tracking.mjs";
import { bootViewer } from "./viewer-boot.mjs";
import { createViewerView } from "./viewer-view.mjs";

const frame = document.querySelector("#pdfViewer");
const viewer = await bootViewer({
  search: window.location.search,
  fetchPdf: fetch,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  pdfJsViewerUrl: new URL("./pdfjs/web/viewer.html", import.meta.url),
  view: createViewerView({
    errorPanel: document.querySelector("#viewerError"),
    errorMessage: document.querySelector("#viewerErrorMessage"),
    frame,
  }),
});

const positionTracking = viewer
  ? createPdfJsPositionTracking({
      fileUrl: viewer.fileUrl,
      frame,
      hostDocument: document,
      hostWindow: window,
      getBook,
      updatePosition,
    })
  : undefined;

window.addEventListener("pagehide", () => {
  if (viewer) {
    URL.revokeObjectURL(viewer.objectUrl);
  }
  if (positionTracking) {
    void positionTracking.settled().finally(() => positionTracking.destroy());
  }
});
