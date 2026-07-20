import { BooksStorageDataError } from "../storage/books.mjs";
import { restorePdfJsPosition } from "./pdfjs-position-restore.mjs";
import { createPositionSaveController } from "./position-save-controller.mjs";

const DEFAULT_INITIAL_READ_RETRY_DELAYS = Object.freeze([250, 1_000, 4_000]);

function readViewerPosition(application) {
  return {
    currentPage: application.pdfViewer.currentPageNumber,
    scrollTop: application.appConfig.mainContainer.scrollTop,
  };
}

function validateRetryDelays(delays) {
  if (
    !Array.isArray(delays) ||
    delays.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new TypeError("initial read retry delays must be non-negative numbers");
  }
  return [...delays];
}

export function createPdfJsPositionTracking({
  fileUrl,
  frame,
  hostDocument,
  getBook,
  updatePosition,
  handoffPosition,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
  initialReadRetryDelays = DEFAULT_INITIAL_READ_RETRY_DELAYS,
  restorePosition = restorePdfJsPosition,
  createSaveController = createPositionSaveController,
  reportError = (error) => console.error("Unable to restore PDF position.", error),
}) {
  if (!frame || typeof frame.addEventListener !== "function") {
    throw new TypeError("frame must be an event target");
  }
  if (
    !hostDocument ||
    typeof hostDocument.addEventListener !== "function" ||
    typeof hostDocument.removeEventListener !== "function"
  ) {
    throw new TypeError("hostDocument must be an event target");
  }
  if (
    typeof getBook !== "function" ||
    typeof updatePosition !== "function" ||
    typeof handoffPosition !== "function" ||
    typeof restorePosition !== "function" ||
    typeof createSaveController !== "function" ||
    typeof reportError !== "function"
  ) {
    throw new TypeError("book storage, restore, tracking, and lifecycle operations are required");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  }
  const readRetryDelays = validateRetryDelays(initialReadRetryDelays);

  let generation = 0;
  let application;
  let eventBus;
  let pagesInitListener;
  let pagesDestroyListener;
  let originalDocument;
  let activatingDocument;
  let activationAbort;
  let readRetry;
  let controller;
  let positionListeners;
  let setupPromise = Promise.resolve();
  const retiring = new Set();

  function cancelReadRetry() {
    if (!readRetry) {
      return;
    }
    const pending = readRetry;
    readRetry = undefined;
    scheduler.clearTimeout(pending.timer);
    pending.resolve(false);
  }

  function waitForReadRetry(delay) {
    return new Promise((resolve) => {
      const pending = {
        resolve,
        timer: scheduler.setTimeout(() => {
          if (readRetry === pending) {
            readRetry = undefined;
          }
          resolve(true);
        }, delay),
      };
      readRetry = pending;
    });
  }

  function retireController(flush) {
    const retired = controller;
    controller = undefined;
    if (!retired) {
      return;
    }
    if (!flush) {
      retired.destroy();
      return;
    }
    const retirement = retired
      .flush()
      .catch(() => {})
      .finally(() => {
        retired.destroy();
        retiring.delete(retirement);
      });
    retiring.add(retirement);
  }

  function removePositionListeners({ flush = false } = {}) {
    activationAbort?.abort();
    activationAbort = undefined;
    if (positionListeners) {
      const { bus, container, onPositionEvent, onScroll } = positionListeners;
      bus.off("pagechanging", onPositionEvent);
      bus.off("updateviewarea", onPositionEvent);
      container.removeEventListener("scroll", onScroll);
      hostDocument.removeEventListener("visibilitychange", onVisibilityChange);
      positionListeners = undefined;
    }
    cancelReadRetry();
    retireController(flush);
  }

  function removeViewerListeners({ flush = false } = {}) {
    removePositionListeners({ flush });
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
    activatingDocument = undefined;
  }

  function isCurrentDocument(documentIdentity, expectedGeneration) {
    return (
      generation === expectedGeneration &&
      application?.pdfDocument === documentIdentity &&
      originalDocument === documentIdentity
    );
  }

  async function readTrackedBook(documentIdentity, expectedGeneration) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await getBook(fileUrl);
      } catch (error) {
        const stale = !isCurrentDocument(documentIdentity, expectedGeneration);
        if (error instanceof BooksStorageDataError || attempt >= readRetryDelays.length || stale) {
          if (!stale) {
            reportError(error);
          }
          return undefined;
        }
        if (!(await waitForReadRetry(readRetryDelays[attempt]))) {
          return undefined;
        }
        if (!isCurrentDocument(documentIdentity, expectedGeneration)) {
          return undefined;
        }
      }
    }
  }

  function armPositionTracking({
    activeApplication,
    bus,
    container,
    currentPosition,
    documentIdentity,
    expectedGeneration,
    initialPosition,
  }) {
    if (controller || positionListeners || !isCurrentDocument(documentIdentity, expectedGeneration)) {
      return;
    }

    controller = createSaveController({
      fileUrl,
      initialPosition,
      updatePosition,
      scheduler,
      clock,
    });
    const capturePosition = (position) => {
      if (!isCurrentDocument(documentIdentity, expectedGeneration)) {
        return;
      }
      controller?.observe(position ?? readViewerPosition(activeApplication));
    };
    const onPositionEvent = ({ source } = {}) => {
      if (source === activeApplication.pdfViewer) {
        capturePosition();
      }
    };
    const onScroll = () => capturePosition();
    bus.on("pagechanging", onPositionEvent);
    bus.on("updateviewarea", onPositionEvent);
    container.addEventListener("scroll", onScroll, { passive: true });
    hostDocument.addEventListener("visibilitychange", onVisibilityChange);
    positionListeners = { bus, container, onPositionEvent, onScroll };
    capturePosition(currentPosition);
  }

  async function activateDocument(documentIdentity, expectedGeneration) {
    if (
      !documentIdentity ||
      activatingDocument === documentIdentity ||
      controller ||
      !isCurrentDocument(documentIdentity, expectedGeneration)
    ) {
      return;
    }
    activatingDocument = documentIdentity;
    let restoreAbort;

    try {
      const book = await readTrackedBook(documentIdentity, expectedGeneration);
      if (!book || !isCurrentDocument(documentIdentity, expectedGeneration)) {
        return;
      }

      const activeApplication = application;
      const bus = eventBus;
      const container = activeApplication.appConfig.mainContainer;
      restoreAbort = new AbortController();
      activationAbort = restoreAbort;
      await restorePosition({
        application: activeApplication,
        container,
        documentIdentity,
        eventBus: bus,
        isCurrent: () => isCurrentDocument(documentIdentity, expectedGeneration),
        savedPosition: book,
        scheduler,
        signal: restoreAbort.signal,
        startTracking(initialPosition, currentPosition) {
          armPositionTracking({
            activeApplication,
            bus,
            container,
            currentPosition,
            documentIdentity,
            expectedGeneration,
            initialPosition,
          });
        },
      });
    } catch (error) {
      if (isCurrentDocument(documentIdentity, expectedGeneration)) {
        reportError(error);
      }
    } finally {
      if (activationAbort === restoreAbort) {
        activationAbort = undefined;
      }
      if (activatingDocument === documentIdentity) {
        activatingDocument = undefined;
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
      setupPromise = activateDocument(documentIdentity, expectedGeneration);
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

  async function initializeFrame(expectedGeneration, frameWindow) {
    const nextApplication = frameWindow?.PDFViewerApplication;
    if (!nextApplication?.initializedPromise) {
      return;
    }
    await nextApplication.initializedPromise;
    if (
      generation !== expectedGeneration ||
      frame.contentWindow !== frameWindow ||
      !nextApplication.eventBus ||
      !nextApplication.pdfViewer ||
      !nextApplication.appConfig?.mainContainer
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
    removeViewerListeners({ flush: true });
    const expectedGeneration = generation;
    const frameWindow = frame.contentWindow;
    setupPromise = initializeFrame(expectedGeneration, frameWindow).catch(() => {});
  }

  function flushLivePosition() {
    if (!controller || !application || application.pdfDocument !== originalDocument) {
      return;
    }
    void controller.flush(readViewerPosition(application));
  }

  function handoffLivePosition() {
    if (!controller || !application || application.pdfDocument !== originalDocument) {
      return;
    }
    const position = readViewerPosition(application);
    if (!controller.needsSave(position)) {
      return;
    }
    try {
      handoffPosition(fileUrl, position);
    } catch {
      // The lifecycle sender cannot synchronously wait for or report durable storage.
    }
  }

  function onVisibilityChange() {
    if (hostDocument.visibilityState === "hidden") {
      flushLivePosition();
    }
  }

  frame.addEventListener("load", onFrameLoad);

  return Object.freeze({
    handoff() {
      handoffLivePosition();
    },

    async settled() {
      let pendingSetup;
      do {
        pendingSetup = setupPromise;
        await pendingSetup;
      } while (pendingSetup !== setupPromise);
      const status = await controller?.settled();
      await Promise.all([...retiring]);
      return status;
    },

    destroy() {
      generation += 1;
      frame.removeEventListener("load", onFrameLoad);
      removeViewerListeners();
    },
  });
}
