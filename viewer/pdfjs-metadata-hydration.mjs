import { resolveAutomaticBookTitle } from "./book-metadata.mjs";

const PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS = 10_000;

function waitForInitialization(initializedPromise, scheduler, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    function finish(error, initialized = true) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(initialized);
      }
    }

    function onAbort() {
      finish(undefined, false);
    }

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(undefined, false);
      return;
    }
    timer = scheduler.setTimeout(
      () => finish(new Error("PDF.js metadata initialization timed out.")),
      PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS,
    );
    Promise.resolve(initializedPromise).then(
      () => finish(),
      (error) => finish(error),
    );
  });
}

export function createPdfJsMetadataHydration({
  fileUrl,
  frame,
  getBook,
  hydrateMetadata,
  scheduler = globalThis,
  resolveTitle = resolveAutomaticBookTitle,
  reportError = (error) => console.error("Unable to read PDF metadata.", error),
} = {}) {
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
  let application;
  let eventBus;
  let initializationAbort;
  let hydrationAbort;
  let pagesDestroyListener;
  let pagesInitListener;
  let originalDocument;
  let setupPromise = Promise.resolve();

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

  function handlePagesDestroy(expectedGeneration, { source } = {}) {
    if (generation === expectedGeneration && source === application?.pdfViewer) {
      removeViewerListeners();
    }
  }

  async function initializeFrame(expectedGeneration, frameWindow, signal) {
    const nextApplication = frameWindow?.PDFViewerApplication;
    if (!nextApplication?.initializedPromise) {
      return;
    }
    if (
      !(await waitForInitialization(nextApplication.initializedPromise, scheduler, signal)) ||
      generation !== expectedGeneration ||
      frame.contentWindow !== frameWindow ||
      !nextApplication.eventBus ||
      !nextApplication.pdfViewer
    ) {
      return;
    }

    application = nextApplication;
    eventBus = nextApplication.eventBus;
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
