import { createPositionSaveController } from "./position-save-controller.mjs";

function readViewerPosition(application) {
  return {
    currentPage: application.pdfViewer.currentPageNumber,
    scrollTop: application.appConfig.mainContainer.scrollTop,
  };
}

export function createPdfJsPositionTracking({
  fileUrl,
  frame,
  hostDocument,
  hostWindow,
  getBook,
  updatePosition,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
}) {
  if (!frame || typeof frame.addEventListener !== "function") {
    throw new TypeError("frame must be an event target");
  }
  if (typeof getBook !== "function" || typeof updatePosition !== "function") {
    throw new TypeError("book storage operations are required");
  }

  let generation = 0;
  let application;
  let eventBus;
  let pagesInitListener;
  let originalDocument;
  let activatingDocument;
  let controller;
  let positionListeners;
  let setupPromise = Promise.resolve();
  const retiring = new Set();

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
    const retirement = retired.flush().finally(() => {
      retired.destroy();
      retiring.delete(retirement);
    });
    retiring.add(retirement);
  }

  function removePositionListeners({ flush = false } = {}) {
    if (positionListeners) {
      const { bus, container, onPositionEvent, onScroll } = positionListeners;
      bus.off("pagechanging", onPositionEvent);
      bus.off("updateviewarea", onPositionEvent);
      container.removeEventListener("scroll", onScroll);
      positionListeners = undefined;
    }
    retireController(flush);
  }

  function removeViewerListeners({ flush = false } = {}) {
    removePositionListeners({ flush });
    if (eventBus && pagesInitListener) {
      eventBus.off("pagesinit", pagesInitListener);
    }
    application = undefined;
    eventBus = undefined;
    pagesInitListener = undefined;
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

    let book;
    try {
      book = await getBook(fileUrl);
    } catch {
      return;
    } finally {
      if (activatingDocument === documentIdentity) {
        activatingDocument = undefined;
      }
    }
    if (!book || !isCurrentDocument(documentIdentity, expectedGeneration)) {
      return;
    }

    const activeApplication = application;
    const bus = eventBus;
    const container = activeApplication.appConfig.mainContainer;
    controller = createPositionSaveController({
      fileUrl,
      initialPosition: book,
      updatePosition,
      scheduler,
      clock,
    });

    const capturePosition = () => {
      if (!isCurrentDocument(documentIdentity, expectedGeneration)) {
        return;
      }
      controller?.observe(readViewerPosition(activeApplication));
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
    positionListeners = { bus, container, onPositionEvent, onScroll };
  }

  function handlePagesInit(expectedGeneration) {
    if (generation !== expectedGeneration || !application?.pdfDocument) {
      return;
    }
    const documentIdentity = application.pdfDocument;
    if (!originalDocument) {
      originalDocument = documentIdentity;
      setupPromise = activateDocument(documentIdentity, expectedGeneration);
      return;
    }
    if (documentIdentity !== originalDocument) {
      removePositionListeners({ flush: true });
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
    pagesInitListener = () => handlePagesInit(expectedGeneration);
    eventBus.on("pagesinit", pagesInitListener);
    if (application.pdfDocument && application.pdfViewer.pagesCount > 0) {
      handlePagesInit(expectedGeneration);
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

  function onVisibilityChange() {
    if (hostDocument.visibilityState === "hidden") {
      flushLivePosition();
    }
  }

  frame.addEventListener("load", onFrameLoad);
  hostWindow.addEventListener("pagehide", flushLivePosition);
  hostDocument.addEventListener("visibilitychange", onVisibilityChange);

  return Object.freeze({
    async settled() {
      await setupPromise;
      await controller?.settled();
      await Promise.all([...retiring]);
    },

    destroy() {
      generation += 1;
      frame.removeEventListener("load", onFrameLoad);
      hostWindow.removeEventListener("pagehide", flushLivePosition);
      hostDocument.removeEventListener("visibilitychange", onVisibilityChange);
      removeViewerListeners();
    },
  });
}
