import { getBook } from "../storage/books.mjs";
import { createPositionUpdateClient } from "../shared/position-update-messaging.mjs";
import { createPdfJsPositionTracking } from "./pdfjs-position-tracking.mjs";
import { bootViewer } from "./viewer-boot.mjs";
import { createViewerView } from "./viewer-view.mjs";

const RESTORE_WARNING =
  "The saved reading position could not be restored. You can keep reading this PDF.";

export async function startViewerApp({
  hostDocument = globalThis.document,
  hostWindow = globalThis.window,
  fetchPdf = globalThis.fetch,
  createObjectUrl = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectUrl = (url) => globalThis.URL.revokeObjectURL(url),
  sendMessage = (message) => globalThis.chrome.runtime.sendMessage(message),
  getBookOperation = getBook,
  bootViewerOperation = bootViewer,
  createPositionTracking = createPdfJsPositionTracking,
  createView = createViewerView,
  positionTrackingScheduler = globalThis,
  positionTrackingClock = { now: () => Date.now() },
  pdfJsViewerUrl = new URL("./pdfjs/web/viewer.html", import.meta.url),
} = {}) {
  const frame = hostDocument.querySelector("#pdfViewer");
  const view = createView({
    errorPanel: hostDocument.querySelector("#viewerError"),
    errorMessage: hostDocument.querySelector("#viewerErrorMessage"),
    frame,
    warningPanel: hostDocument.querySelector("#viewerWarning"),
    warningMessage: hostDocument.querySelector("#viewerWarningMessage"),
  });
  const viewer = await bootViewerOperation({
    search: hostWindow.location.search,
    fetchPdf,
    createObjectUrl,
    pdfJsViewerUrl,
    view,
  });

  if (!viewer) {
    return undefined;
  }

  const positionUpdates = createPositionUpdateClient({ sendMessage });
  const positionTracking = createPositionTracking({
    fileUrl: viewer.fileUrl,
    frame,
    hostDocument,
    clock: positionTrackingClock,
    getBook: getBookOperation,
    updatePosition: positionUpdates.updatePosition,
    handoffPosition: positionUpdates.handoffPosition,
    reportError(error) {
      view.showWarning(RESTORE_WARNING, error);
    },
    scheduler: positionTrackingScheduler,
  });
  let destroyed = false;

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    hostWindow.removeEventListener("pagehide", onPageHide);
    positionTracking.destroy();
    revokeObjectUrl(viewer.objectUrl);
  }

  function onPageHide() {
    positionTracking.handoff();
    destroy();
  }

  hostWindow.addEventListener("pagehide", onPageHide);
  return Object.freeze({ destroy, positionTracking, viewer });
}
