// @ts-check

import { resolveAutomaticBookTitle } from "../shared/book-title.mjs";
import { waitForPdfJsInitialization } from "./pdfjs-initialization.mjs";

/** @typedef {import("../types/pdfjs.d.ts").PdfJsApplication} PdfJsApplication */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsDocument} PdfJsDocument */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventBus} PdfJsEventBus */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventMap} PdfJsEventMap */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsFrame} PdfJsFrame */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsWindow} PdfJsWindow */
/** @typedef {import("../types/storage.d.ts").BookRecord} BookRecord */

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 * }} TimeoutScheduler
 */

/**
 * @param {{
 *   fileUrl: string,
 *   frame: PdfJsFrame,
 *   getBook: (fileUrl: string) => Promise<BookRecord | undefined>,
 *   hydrateMetadata: (
 *     fileUrl: string,
 *     patch: { title: string, totalPages: number },
 *     options?: { signal?: AbortSignal },
 *   ) => Promise<BookRecord | undefined>,
 *   scheduler?: TimeoutScheduler,
 *   resolveTitle?: (metadata: unknown, fileUrl: string) => string,
 *   reportError?: (error: unknown) => void,
 * }} [dependencies]
 */
export function createPdfJsMetadataHydration({
  fileUrl,
  frame,
  getBook,
  hydrateMetadata,
  scheduler = globalThis,
  resolveTitle = resolveAutomaticBookTitle,
  reportError = (error) => console.error("Unable to read PDF metadata.", error),
} = /** @type {never} */ ({})) {
  if (!frame || typeof frame.addEventListener !== "function") {
    throw new TypeError("frame must be an event target");
  }
  if (
    typeof getBook !== "function" ||
    typeof hydrateMetadata !== "function" ||
    typeof resolveTitle !== "function" ||
    typeof reportError !== "function"
  ) {
    throw new TypeError("metadata extraction, storage, and error operations are required");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  }

  let generation = 0;
  /** @type {PdfJsApplication | undefined} */
  let application;
  /** @type {PdfJsEventBus | undefined} */
  let eventBus;
  /** @type {AbortController | undefined} */
  let initializationAbort;
  /** @type {AbortController | undefined} */
  let hydrationAbort;
  /** @type {((event: PdfJsEventMap["pagesdestroy"]) => void) | undefined} */
  let pagesDestroyListener;
  /** @type {((event: PdfJsEventMap["pagesinit"]) => void) | undefined} */
  let pagesInitListener;
  /** @type {PdfJsDocument | undefined} */
  let originalDocument;
  /** @type {Promise<void>} */
  let setupPromise = Promise.resolve();

  /**
   * @param {PdfJsDocument} documentIdentity
   * @param {number} expectedGeneration
   */
  function isCurrent(documentIdentity, expectedGeneration) {
    return (
      generation === expectedGeneration &&
      application?.pdfDocument === documentIdentity &&
      originalDocument === documentIdentity
    );
  }

  function removeViewerListeners() {
    initializationAbort?.abort();
    initializationAbort = undefined;
    hydrationAbort?.abort();
    hydrationAbort = undefined;
    if (eventBus && pagesInitListener) {
      eventBus.off("pagesinit", pagesInitListener);
    }
    if (eventBus && pagesDestroyListener) {
      eventBus.off("pagesdestroy", pagesDestroyListener);
    }
    application = undefined;
    eventBus = undefined;
    pagesInitListener = undefined;
    pagesDestroyListener = undefined;
    originalDocument = undefined;
  }

  /**
   * @param {PdfJsDocument} documentIdentity
   * @param {number} expectedGeneration
   * @param {AbortSignal} signal
   */
  async function hydrateDocument(documentIdentity, expectedGeneration, signal) {
    try {
      const book = await getBook(fileUrl);
      if (!book || book.totalPages !== 0 || !isCurrent(documentIdentity, expectedGeneration)) {
        return;
      }

      const totalPages = documentIdentity.numPages;
      if (!Number.isInteger(totalPages) || totalPages <= 0) {
        throw new Error("PDF.js returned an invalid page count.");
      }
      const metadata = await documentIdentity.getMetadata();
      if (!isCurrent(documentIdentity, expectedGeneration) || signal.aborted) {
        return;
      }
      const title = resolveTitle(metadata, fileUrl);
      if (!title) {
        throw new Error("The local PDF filename does not contain a usable title.");
      }
      await hydrateMetadata(
        fileUrl,
        { title, totalPages },
        { signal },
      );
    } catch (error) {
      if (isCurrent(documentIdentity, expectedGeneration) && !signal.aborted) {
        reportError(error);
      }
    }
  }

  /**
   * @param {number} expectedGeneration
   * @param {PdfJsEventMap["pagesinit"]} [event]
   */
  function handlePagesInit(expectedGeneration, { source } = {}) {
    if (
      generation !== expectedGeneration ||
      !application?.pdfDocument ||
      (source && source !== application.pdfViewer)
    ) {
      return;
    }
    const documentIdentity = application.pdfDocument;
    if (!originalDocument) {
      originalDocument = documentIdentity;
      const active = new AbortController();
      hydrationAbort = active;
      setupPromise = hydrateDocument(documentIdentity, expectedGeneration, active.signal).finally(
        () => {
          if (hydrationAbort === active) {
            hydrationAbort = undefined;
          }
        },
      );
      return;
    }
    if (documentIdentity !== originalDocument) {
      removeViewerListeners();
    }
  }

  /**
   * @param {number} expectedGeneration
   * @param {PdfJsEventMap["pagesdestroy"]} [event]
   */
  function handlePagesDestroy(expectedGeneration, { source } = {}) {
    if (generation === expectedGeneration && source === application?.pdfViewer) {
      removeViewerListeners();
    }
  }

  /**
   * @param {number} expectedGeneration
   * @param {PdfJsWindow | null} frameWindow
   * @param {AbortSignal} signal
   */
  async function initializeFrame(expectedGeneration, frameWindow, signal) {
    const nextApplication = frameWindow?.PDFViewerApplication;
    if (!nextApplication?.initializedPromise) {
      return;
    }
    if (
      !(await waitForPdfJsInitialization({
        initializedPromise: nextApplication.initializedPromise,
        scheduler,
        signal,
        timeoutErrorMessage: "PDF.js metadata initialization timed out.",
      })) ||
      generation !== expectedGeneration ||
      frame.contentWindow !== frameWindow ||
      !nextApplication.eventBus ||
      !nextApplication.pdfViewer
    ) {
      return;
    }

    application = /** @type {PdfJsApplication} */ (nextApplication);
    eventBus = application.eventBus;
    pagesInitListener = (event) => handlePagesInit(expectedGeneration, event);
    pagesDestroyListener = (event) => handlePagesDestroy(expectedGeneration, event);
    eventBus.on("pagesinit", pagesInitListener);
    eventBus.on("pagesdestroy", pagesDestroyListener);
    if (application.pdfDocument && application.pdfViewer.pagesCount > 0) {
      handlePagesInit(expectedGeneration, { source: application.pdfViewer });
    }
  }

  function onFrameLoad() {
    generation += 1;
    removeViewerListeners();
    const expectedGeneration = generation;
    const frameWindow = frame.contentWindow;
    const pendingInitialization = new AbortController();
    initializationAbort = pendingInitialization;
    setupPromise = initializeFrame(
      expectedGeneration,
      frameWindow,
      pendingInitialization.signal,
    )
      .catch((error) => {
        if (generation === expectedGeneration) {
          reportError(error);
        }
      })
      .finally(() => {
        if (initializationAbort === pendingInitialization) {
          initializationAbort = undefined;
        }
      });
  }

  frame.addEventListener("load", onFrameLoad);
  if (frame.contentDocument?.readyState === "complete") {
    onFrameLoad();
  }

  return Object.freeze({
    async settled() {
      let pendingSetup;
      do {
        pendingSetup = setupPromise;
        await pendingSetup;
      } while (pendingSetup !== setupPromise);
    },

    destroy() {
      generation += 1;
      frame.removeEventListener("load", onFrameLoad);
      removeViewerListeners();
    },
  });
}
