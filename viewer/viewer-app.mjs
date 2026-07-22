import {
  getBook,
  getPositionTrackingState,
  hydrateMetadata,
} from "../storage/books.mjs";
import { createPositionUpdateClient } from "../shared/position-update-messaging.mjs";
import { createPdfJsMetadataHydration } from "./pdfjs-metadata-hydration.mjs";
import { createPdfJsPositionTracking } from "./pdfjs-position-tracking.mjs";
import { bootViewer } from "./viewer-boot.mjs";
import { createViewerView } from "./viewer-view.mjs";

const RESTORE_WARNING =
  "The saved reading position could not be restored. You can keep reading this PDF.";
const METADATA_WARNING =
  "The book title and page count could not be saved. You can keep reading this PDF.";
const STARTUP_ERROR =
  "The PDF viewer could not be initialized. Reload this page to try again.";

export async function startViewerApp({
  hostDocument = globalThis.document,
  hostWindow = globalThis.window,
  fetchPdf = globalThis.fetch,
  createObjectUrl = (blob) => globalThis.URL.createObjectURL(blob),
  revokeObjectUrl = (url) => globalThis.URL.revokeObjectURL(url),
  isFileSchemeAccessAllowed = () =>
    globalThis.chrome.extension.isAllowedFileSchemeAccess(),
  sendMessage = (message) => globalThis.chrome.runtime.sendMessage(message),
  getBookOperation = getBook,
  getPositionTrackingStateOperation = getPositionTrackingState,
  hydrateMetadataOperation = hydrateMetadata,
  bootViewerOperation = bootViewer,
  createMetadataHydration = createPdfJsMetadataHydration,
  createPositionTracking = createPdfJsPositionTracking,
  createView = createViewerView,
  metadataHydrationScheduler = globalThis,
  positionTrackingScheduler = globalThis,
  positionTrackingClock = { now: () => Date.now() },
  pdfJsViewerUrl = new URL("./pdfjs/web/viewer.html", import.meta.url),
} = {}) {
  const frame = hostDocument.querySelector("#pdfViewer");
  const view = createView({
    errorPanel: hostDocument.querySelector("#viewerError"),
    errorMessage: hostDocument.querySelector("#viewerErrorMessage"),
    fileAccessInstructions: hostDocument.querySelector("#viewerFileAccessInstructions"),
    frame,
    warningPanel: hostDocument.querySelector("#viewerWarning"),
    warningMessage: hostDocument.querySelector("#viewerWarningMessage"),
  });
  const viewer = await bootViewerOperation({
    search: hostWindow.location.search,
    fetchPdf,
    createObjectUrl,
    isFileSchemeAccessAllowed,
    pdfJsViewerUrl,
    view,
  });

  if (!viewer) {
    return undefined;
  }

  let metadataHydration;
  let positionTracking;
  let pageHideRegistrationAttempted = false;
  let destroyed = false;

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    try {
      if (pageHideRegistrationAttempted) {
        hostWindow.removeEventListener("pagehide", onPageHide);
      }
    } finally {
      try {
        metadataHydration?.destroy();
      } finally {
        try {
          positionTracking?.destroy();
        } finally {
          revokeObjectUrl(viewer.objectUrl);
        }
      }
    }
  }

  function onPageHide() {
    positionTracking.handoff();
    destroy();
  }

  try {
    const positionUpdates = createPositionUpdateClient({ sendMessage });
    metadataHydration = createMetadataHydration({
      fileUrl: viewer.fileUrl,
      frame,
      getBook: getBookOperation,
      hydrateMetadata: hydrateMetadataOperation,
      reportError(error) {
        view.showWarning(METADATA_WARNING, error);
      },
      scheduler: metadataHydrationScheduler,
    });
    positionTracking = createPositionTracking({
      fileUrl: viewer.fileUrl,
      frame,
      hostDocument,
      clock: positionTrackingClock,
      getPositionTrackingState: getPositionTrackingStateOperation,
      updatePosition: positionUpdates.updatePosition,
      handoffPendingPosition: positionUpdates.handoffPendingPosition,
      handoffPosition: positionUpdates.handoffPosition,
      reportError(error) {
        view.showWarning(RESTORE_WARNING, error);
      },
      scheduler: positionTrackingScheduler,
    });
    pageHideRegistrationAttempted = true;
    hostWindow.addEventListener("pagehide", onPageHide);
  } catch (error) {
    try {
      destroy();
    } finally {
      view.showError(STARTUP_ERROR);
    }
    throw error;
  }

  return Object.freeze({ destroy, metadataHydration, positionTracking, viewer });
}
