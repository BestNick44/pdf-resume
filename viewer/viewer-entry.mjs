import { bootViewer } from "./viewer-boot.mjs";
import { createViewerView } from "./viewer-view.mjs";

const objectUrl = await bootViewer({
  search: window.location.search,
  fetchPdf: fetch,
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  pdfJsViewerUrl: new URL("./pdfjs/web/viewer.html", import.meta.url),
  view: createViewerView({
    errorPanel: document.querySelector("#viewerError"),
    errorMessage: document.querySelector("#viewerErrorMessage"),
    frame: document.querySelector("#pdfViewer"),
  }),
});

window.addEventListener("pagehide", () => {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
});
