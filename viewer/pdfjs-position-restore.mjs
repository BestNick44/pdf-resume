const PDF_JS_RENDERING_FINISHED = 3;

function validSavedPosition(position) {
  if (
    !position ||
    !Number.isInteger(position.currentPage) ||
    position.currentPage < 1 ||
    !Number.isFinite(position.scrollTop) ||
    position.scrollTop < 0
  ) {
    throw new TypeError("saved position must contain a valid currentPage and scrollTop");
  }
  return {
    currentPage: position.currentPage,
    scrollTop: position.scrollTop,
  };
}

function actualPageCount(application, documentIdentity) {
  const documentPages = documentIdentity?.numPages;
  if (Number.isInteger(documentPages) && documentPages > 0) {
    return documentPages;
  }
  const viewerPages = application.pdfViewer.pagesCount;
  return Number.isInteger(viewerPages) && viewerPages > 0 ? viewerPages : undefined;
}

function isRendered(pdfViewer, pageNumber) {
  return pdfViewer.getPageView?.(pageNumber - 1)?.renderingState === PDF_JS_RENDERING_FINISHED;
}

function waitForTargetPage({ eventBus, pageNumber, pdfViewer, signal, navigate }) {
  return new Promise((resolve) => {
    let settled = false;

    function finish(ready) {
      if (settled) {
        return;
      }
      settled = true;
      eventBus.off("pagerendered", onPageRendered);
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    }

    function onAbort() {
      finish(false);
    }

    function onPageRendered(event) {
      if (event?.pageNumber === pageNumber) {
        finish(true);
      }
    }

    eventBus.on("pagerendered", onPageRendered);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }

    navigate();
    if (isRendered(pdfViewer, pageNumber)) {
      finish(true);
    }
  });
}

function waitForLayout(scheduler, signal) {
  return new Promise((resolve) => {
    const requestFrame =
      typeof scheduler.requestAnimationFrame === "function"
        ? scheduler.requestAnimationFrame.bind(scheduler)
        : (callback) => scheduler.setTimeout(callback, 16);
    const cancelFrame =
      typeof scheduler.cancelAnimationFrame === "function"
        ? scheduler.cancelAnimationFrame.bind(scheduler)
        : scheduler.clearTimeout.bind(scheduler);
    let frame;
    let settled = false;

    function finish(ready) {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    }

    function onAbort() {
      cancelFrame(frame);
      finish(false);
    }

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    frame = requestFrame(() => finish(true));
  });
}

function layoutBounds(container) {
  const { clientHeight, scrollHeight } = container;
  if (
    !Number.isFinite(clientHeight) ||
    clientHeight <= 0 ||
    !Number.isFinite(scrollHeight) ||
    scrollHeight < clientHeight
  ) {
    return undefined;
  }
  return { maximumScrollTop: Math.max(0, scrollHeight - clientHeight) };
}

function currentPosition(application, container, pagesCount) {
  const viewerPage = application.pdfViewer.currentPageNumber;
  const currentPage = Number.isInteger(viewerPage) && viewerPage > 0 ? viewerPage : 1;
  const boundedPage = pagesCount ? Math.min(currentPage, pagesCount) : currentPage;
  const viewerScrollTop = container.scrollTop;
  const scrollTop = Number.isFinite(viewerScrollTop) && viewerScrollTop >= 0 ? viewerScrollTop : 0;
  const bounds = layoutBounds(container);
  return {
    currentPage: boundedPage,
    scrollTop: bounds ? Math.min(scrollTop, bounds.maximumScrollTop) : scrollTop,
  };
}

export async function restorePdfJsPosition({
  application,
  container,
  documentIdentity,
  eventBus,
  isCurrent,
  savedPosition,
  scheduler = globalThis,
  signal,
  startTracking,
}) {
  if (
    !application?.pdfViewer ||
    !container ||
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function"
  ) {
    throw new TypeError("PDF.js application, container, and event bus are required");
  }
  if (typeof isCurrent !== "function" || typeof startTracking !== "function") {
    throw new TypeError("document lifecycle and tracker start operations are required");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  }

  const position = validSavedPosition(savedPosition);
  const active = new AbortController();
  const abort = () => active.abort();
  const onPagesDestroy = ({ source } = {}) => {
    if (source === application.pdfViewer) {
      active.abort();
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  eventBus.on("pagesdestroy", onPagesDestroy);

  try {
    if (signal?.aborted || !isCurrent()) {
      return undefined;
    }

    const pagesCount = actualPageCount(application, documentIdentity);
    const fallbackPage = application.pdfViewer.currentPageNumber;
    const pageNumber = pagesCount
      ? Math.min(position.currentPage, pagesCount)
      : Number.isInteger(fallbackPage) && fallbackPage > 0
        ? fallbackPage
        : 1;
    const pageReady = await waitForTargetPage({
      eventBus,
      pageNumber,
      pdfViewer: application.pdfViewer,
      signal: active.signal,
      navigate() {
        application.pdfViewer.currentPageNumber = pageNumber;
      },
    });
    if (!pageReady || !isCurrent()) {
      return undefined;
    }

    if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
      return undefined;
    }
    const bounds = layoutBounds(container);
    if (bounds) {
      container.scrollTop = Math.min(position.scrollTop, bounds.maximumScrollTop);
    }
    const restoredPosition = {
      currentPage: pageNumber,
      scrollTop: currentPosition(application, container, pagesCount).scrollTop,
    };

    if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
      return undefined;
    }
    const handoffPosition = currentPosition(application, container, pagesCount);
    startTracking(restoredPosition, handoffPosition);
    return handoffPosition;
  } finally {
    signal?.removeEventListener("abort", abort);
    eventBus.off("pagesdestroy", onPagesDestroy);
    active.abort();
  }
}
