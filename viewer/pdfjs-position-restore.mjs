import { samePosition, validPosition } from "../shared/position.mjs";

const PDF_JS_RENDERING_FINISHED = 3;
const PDF_JS_INITIAL_VIEW_TIMEOUT_MILLISECONDS = 10_000;
const USER_INTERACTION_EVENTS = [
  "click",
  "keydown",
  "pointerdown",
  "pointerup",
  "touchstart",
  "wheel",
];

function actualPageCount(application, documentIdentity) {
  const documentPages = documentIdentity?.numPages;
  if (Number.isInteger(documentPages) && documentPages > 0) {
    return documentPages;
  }
  const viewerPages = application.pdfViewer.pagesCount;
  return Number.isInteger(viewerPages) && viewerPages > 0 ? viewerPages : undefined;
}

function waitForTargetPage({ eventBus, pageNumber, pdfViewer, signal, navigate }) {
  const targetPage = pdfViewer.getPageView?.(pageNumber - 1);
  if (!targetPage) {
    return Promise.reject(new Error(`PDF.js page ${pageNumber} is unavailable.`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      eventBus.off("pagerendered", onPageRendered);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(!signal.aborted);
      }
    }

    function onAbort() {
      finish();
    }

    function onPageRendered(event) {
      if (event?.pageNumber !== pageNumber || event.source !== targetPage) {
        return;
      }
      finish(event.error || undefined);
    }

    eventBus.on("pagerendered", onPageRendered);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }

    navigate();
    if (targetPage.renderingState === PDF_JS_RENDERING_FINISHED) {
      finish();
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

function waitForInitialView({ application, eventBus, scheduler, signal }) {
  if (application.isInitialViewSet) {
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    function finish(error, ready = true) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
      eventBus.off("documentinit", onDocumentInit);
      eventBus.off("updateviewarea", onViewAreaUpdate);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(ready);
      }
    }

    function onAbort() {
      finish(undefined, false);
    }

    function onDocumentInit({ source } = {}) {
      if (source === application) {
        finish();
      }
    }

    function onViewAreaUpdate({ source } = {}) {
      if (source === application.pdfViewer && application.isInitialViewSet) {
        finish();
      }
    }

    eventBus.on("documentinit", onDocumentInit);
    eventBus.on("updateviewarea", onViewAreaUpdate);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(undefined, false);
      return;
    }
    timer = scheduler.setTimeout(() => {
      if (application.isInitialViewSet) {
        finish();
      } else {
        finish(new Error("PDF.js initial view did not become ready."));
      }
    }, PDF_JS_INITIAL_VIEW_TIMEOUT_MILLISECONDS);
  });
}

function waitForPages(pdfViewer, scheduler, signal) {
  const pagesPromise = pdfViewer.pagesPromise;
  if (!pagesPromise || typeof pagesPromise.then !== "function") {
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    function finish(error, ready = true) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve(ready);
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
      () => finish(),
      PDF_JS_INITIAL_VIEW_TIMEOUT_MILLISECONDS,
    );
    Promise.resolve(pagesPromise).then(
      () => finish(),
      (error) => finish(error),
    );
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

export function createPdfJsRestoreLifecycle({
  interactionTarget,
  readPosition,
  scheduler = globalThis,
} = {}) {
  if (
    !interactionTarget ||
    typeof interactionTarget.addEventListener !== "function" ||
    typeof interactionTarget.removeEventListener !== "function"
  ) {
    throw new TypeError("PDF.js interaction target must be an event target");
  }
  if (typeof readPosition !== "function") {
    throw new TypeError("restore lifecycle must be able to read the live position");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("restore lifecycle scheduler is required");
  }

  const requestFrame =
    typeof scheduler.requestAnimationFrame === "function"
      ? scheduler.requestAnimationFrame.bind(scheduler)
      : (callback) => scheduler.setTimeout(callback, 16);
  const cancelFrame =
    typeof scheduler.cancelAnimationFrame === "function"
      ? scheduler.cancelAnimationFrame.bind(scheduler)
      : scheduler.clearTimeout.bind(scheduler);
  let destroyed = false;
  let frame;
  let genuinePositionChange = false;
  let positionBeforeInteraction;

  function changedSinceInteraction() {
    return Boolean(
      positionBeforeInteraction &&
        !samePosition(positionBeforeInteraction, validPosition(readPosition())),
    );
  }

  function onInteractionCapture(event) {
    if (event?.isTrusted !== true) {
      return;
    }
    positionBeforeInteraction ??= validPosition(readPosition());
    if (frame === undefined) {
      frame = requestFrame(() => {
        frame = undefined;
        genuinePositionChange ||= changedSinceInteraction();
        positionBeforeInteraction = undefined;
      });
    }
  }

  for (const type of USER_INTERACTION_EVENTS) {
    interactionTarget.addEventListener(type, onInteractionCapture, true);
  }

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      if (frame !== undefined) {
        cancelFrame(frame);
        frame = undefined;
      }
      positionBeforeInteraction = undefined;
      for (const type of USER_INTERACTION_EVENTS) {
        interactionTarget.removeEventListener(type, onInteractionCapture, true);
      }
    },

    hasGenuineInteraction() {
      return genuinePositionChange || changedSinceInteraction();
    },
  });
}

export async function restorePdfJsPosition({
  application,
  container,
  documentIdentity,
  eventBus,
  interaction,
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
  if (
    !interaction ||
    typeof interaction.hasGenuineInteraction !== "function" ||
    typeof isCurrent !== "function" ||
    typeof startTracking !== "function"
  ) {
    throw new TypeError("document lifecycle, interaction, and tracker operations are required");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  }

  const position = validPosition(savedPosition, "saved position");
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
    if (
      !(await waitForInitialView({
        application,
        eventBus,
        scheduler,
        signal: active.signal,
      })) ||
      !(await waitForPages(application.pdfViewer, scheduler, active.signal)) ||
      !(await waitForLayout(scheduler, active.signal)) ||
      !isCurrent()
    ) {
      return undefined;
    }

    const pagesCount = actualPageCount(application, documentIdentity);
    const fallbackPage = application.pdfViewer.currentPageNumber;
    const pageNumber = pagesCount
      ? Math.min(position.currentPage, pagesCount)
      : Number.isInteger(fallbackPage) && fallbackPage > 0
        ? fallbackPage
        : 1;
    const bounds = layoutBounds(container);
    const restoredPosition = {
      currentPage: pageNumber,
      scrollTop: bounds
        ? Math.min(position.scrollTop, bounds.maximumScrollTop)
        : position.scrollTop,
    };

    if (interaction.hasGenuineInteraction()) {
      const handoffPosition = currentPosition(application, container, pagesCount);
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

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

    if (interaction.hasGenuineInteraction()) {
      if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
        return undefined;
      }
      const handoffPosition = currentPosition(application, container, pagesCount);
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
      return undefined;
    }
    if (interaction.hasGenuineInteraction()) {
      const handoffPosition = currentPosition(application, container, pagesCount);
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    if (bounds) {
      container.scrollTop = restoredPosition.scrollTop;
    }
    restoredPosition.scrollTop = currentPosition(
      application,
      container,
      pagesCount,
    ).scrollTop;

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
