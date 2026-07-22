// @ts-check

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

/** @typedef {import("../types/pdfjs.d.ts").PdfJsFrame} PdfJsFrame */
/** @typedef {import("../types/storage.d.ts").RecordObservationMessage} RecordObservationMessage */

/**
 * @typedef {{
 *   destroy: () => void,
 *   settled: () => Promise<void>,
 * }} MetadataHydration
 */

/**
 * @typedef {{
 *   destroy: () => void,
 *   handoff: () => void,
 *   settled: () => Promise<unknown>,
 * }} PositionTracking
 */

/**
 * @typedef {{
 *   showError: (message: string) => void,
 *   showFileAccessInstructions: () => void,
 *   showViewer: (viewerUrl: URL) => void,
 *   showWarning: (message: string, error?: unknown) => void,
 * }} ViewerView
 */

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 * }} ViewerTimerScheduler
 */

const RESTORE_WARNING =
  "The saved reading position could not be restored. You can keep reading this PDF.";
const METADATA_WARNING =
  "The book title and page count could not be saved. You can keep reading this PDF.";
const STARTUP_ERROR =
  "The PDF viewer could not be initialized. Reload this page to try again.";

/**
 * @param {{
 *   hostDocument?: Document,
 *   hostWindow?: Window,
 *   fetchPdf?: typeof globalThis.fetch,
 *   createObjectUrl?: (blob: Blob) => string,
 *   revokeObjectUrl?: (url: string) => void,
 *   isFileSchemeAccessAllowed?: () => boolean | Promise<boolean>,
 *   sendMessage?: (message: RecordObservationMessage) => unknown,
 *   getBookOperation?: typeof getBook,
 *   getPositionTrackingStateOperation?: typeof getPositionTrackingState,
 *   hydrateMetadataOperation?: typeof hydrateMetadata,
 *   bootViewerOperation?: typeof bootViewer,
 *   createMetadataHydration?: typeof createPdfJsMetadataHydration,
 *   createPositionTracking?: typeof createPdfJsPositionTracking,
 *   createView?: (elements: {
 *     errorPanel: HTMLElement,
 *     errorMessage: HTMLElement,
 *     fileAccessInstructions: HTMLElement,
 *     frame: HTMLIFrameElement,
 *     warningPanel: HTMLElement,
 *     warningMessage: HTMLElement,
 *   }) => ViewerView,
 *   metadataHydrationScheduler?: ViewerTimerScheduler,
 *   positionTrackingScheduler?: ViewerTimerScheduler & {
 *     requestAnimationFrame?: (callback: FrameRequestCallback) => number,
 *     cancelAnimationFrame?: (handle: number) => void,
 *   },
 *   positionTrackingClock?: { now: () => number },
 *   pdfJsViewerUrl?: URL,
 * }} [dependencies]
 */
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
  // PDF.js owns this iframe global; this is its single cast into app-owned code.
  const frame = /** @type {PdfJsFrame} */ (
    hostDocument.querySelector("#pdfViewer")
  );
  const view = createView({
    errorPanel: /** @type {HTMLElement} */ (
      hostDocument.querySelector("#viewerError")
    ),
    errorMessage: /** @type {HTMLElement} */ (
      hostDocument.querySelector("#viewerErrorMessage")
    ),
    fileAccessInstructions: /** @type {HTMLElement} */ (
      hostDocument.querySelector("#viewerFileAccessInstructions")
    ),
    frame,
    warningPanel: /** @type {HTMLElement} */ (
      hostDocument.querySelector("#viewerWarning")
    ),
    warningMessage: /** @type {HTMLElement} */ (
      hostDocument.querySelector("#viewerWarningMessage")
    ),
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
  const activeViewer = viewer;

  /** @type {MetadataHydration | undefined} */
  let metadataHydration;
  /** @type {PositionTracking | undefined} */
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
          revokeObjectUrl(activeViewer.objectUrl);
        }
      }
    }
  }

  function onPageHide() {
    /** @type {PositionTracking} */ (positionTracking).handoff();
    destroy();
  }

  try {
    const positionUpdates = createPositionUpdateClient({ sendMessage });
    metadataHydration = createMetadataHydration({
      fileUrl: activeViewer.fileUrl,
      frame,
      getBook: getBookOperation,
      hydrateMetadata: hydrateMetadataOperation,
      reportError(error) {
        view.showWarning(METADATA_WARNING, error);
      },
      scheduler: metadataHydrationScheduler,
    });
    positionTracking = createPositionTracking({
      fileUrl: activeViewer.fileUrl,
      frame,
      hostDocument,
      clock: positionTrackingClock,
      getPositionTrackingState: getPositionTrackingStateOperation,
      recordObservation: positionUpdates.recordObservation,
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

  return Object.freeze({
    destroy,
    metadataHydration,
    positionTracking,
    viewer: activeViewer,
  });
}
