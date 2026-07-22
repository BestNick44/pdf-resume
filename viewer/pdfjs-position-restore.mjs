import { samePosition, validPosition } from "../shared/position.mjs";

const PDF_JS_RENDERING_FINISHED = 3;
const PDF_JS_INITIAL_VIEW_TIMEOUT_MILLISECONDS = 10_000;
const PDF_JS_TARGET_PAGE_TIMEOUT_MILLISECONDS = 10_000;
const TRANSIENT_INTERACTION_IDLE_MILLISECONDS = 250;
const TRANSIENT_INTERACTION_EVENTS = ["click", "keydown", "wheel"];
const GESTURE_INTERACTION_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "touchstart",
  "touchend",
  "touchcancel",
];

function actualPageCount(application, documentIdentity) {
  const documentPages = documentIdentity?.numPages;
  if (Number.isInteger(documentPages) && documentPages > 0) {
    return documentPages;
  }
  const viewerPages = application.pdfViewer.pagesCount;
  return Number.isInteger(viewerPages) && viewerPages > 0 ? viewerPages : undefined;
}

function waitForTargetPage({
  eventBus,
  pageNumber,
  pdfViewer,
  renderOutcomes,
  scheduler,
  signal,
  navigate,
}) {
  const targetPage = pdfViewer.getPageView?.(pageNumber - 1);
  if (!targetPage) {
    return Promise.reject(new Error(`PDF.js page ${pageNumber} is unavailable.`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(timer);
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

    timer = scheduler.setTimeout(
      () =>
        finish(
          new Error(`PDF.js page ${pageNumber} did not finish rendering.`),
        ),
      PDF_JS_TARGET_PAGE_TIMEOUT_MILLISECONDS,
    );
    try {
      navigate();
      if (targetPage.renderingState === PDF_JS_RENDERING_FINISHED) {
        const outcome = renderOutcomes.outcomeFor(targetPage);
        finish(outcome?.pageNumber === pageNumber ? outcome.error : undefined);
      }
    } catch (error) {
      finish(error);
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

export function createPdfJsRenderOutcomeTracker({ eventBus } = {}) {
  if (
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function"
  ) {
    throw new TypeError("PDF.js render outcomes require an event bus");
  }

  const outcomes = new WeakMap();
  let destroyed = false;

  function onPageRendered(event) {
    if (!event?.source || typeof event.source !== "object") {
      return;
    }
    outcomes.set(event.source, {
      error: event.error || undefined,
      pageNumber: event.pageNumber,
    });
  }

  eventBus.on("pagerendered", onPageRendered);

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      eventBus.off("pagerendered", onPageRendered);
    },

    outcomeFor(pageView) {
      return outcomes.get(pageView);
    },
  });
}

export function createPdfJsRestoreLifecycle({
  container,
  eventBus,
  interactionTarget,
  pdfViewer,
  readPosition,
  onGenuinePositionChange,
  scheduler = globalThis,
} = {}) {
  if (
    !interactionTarget ||
    typeof interactionTarget.addEventListener !== "function" ||
    typeof interactionTarget.removeEventListener !== "function"
  ) {
    throw new TypeError("PDF.js interaction target must be an event target");
  }
  if (
    !container ||
    typeof container.addEventListener !== "function" ||
    typeof container.removeEventListener !== "function" ||
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function" ||
    !pdfViewer
  ) {
    throw new TypeError("restore lifecycle requires PDF.js position events");
  }
  if (typeof readPosition !== "function") {
    throw new TypeError("restore lifecycle must be able to read the live position");
  }
  if (
    onGenuinePositionChange !== undefined &&
    typeof onGenuinePositionChange !== "function"
  ) {
    throw new TypeError("restore lifecycle position observer must be a function");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("restore lifecycle scheduler is required");
  }

  let destroyed = false;
  let genuinePositionChange = false;
  let idleTimer;
  let ignoredPositionChanges = 0;
  let pointerActive = false;
  let positionBeforeInteraction;
  let touchActive = false;

  function intentActive() {
    return pointerActive || touchActive || idleTimer !== undefined;
  }

  function cancelIdleTimer() {
    if (idleTimer !== undefined) {
      scheduler.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function finishIdle() {
    idleTimer = undefined;
    if (!pointerActive && !touchActive) {
      positionBeforeInteraction = undefined;
    }
  }

  function scheduleIdle() {
    cancelIdleTimer();
    idleTimer = scheduler.setTimeout(
      finishIdle,
      TRANSIENT_INTERACTION_IDLE_MILLISECONDS,
    );
  }

  function beginIntent({ bounded = false } = {}) {
    positionBeforeInteraction ??= validPosition(readPosition());
    if (bounded) {
      scheduleIdle();
    } else {
      cancelIdleTimer();
    }
  }

  function observePositionActivity() {
    if (
      ignoredPositionChanges > 0 ||
      !intentActive() ||
      !positionBeforeInteraction
    ) {
      return;
    }
    const position = validPosition(readPosition());
    if (samePosition(positionBeforeInteraction, position)) {
      return;
    }
    genuinePositionChange = true;
    onGenuinePositionChange?.(position);
  }

  function onTransientInteraction(event) {
    if (event?.isTrusted === true) {
      beginIntent({ bounded: true });
    }
  }

  function onGestureInteraction(event) {
    if (event?.isTrusted !== true) {
      return;
    }
    switch (event.type) {
      case "pointerdown":
        pointerActive = true;
        beginIntent();
        break;
      case "touchstart":
        touchActive = true;
        beginIntent();
        break;
      case "pointerup":
      case "pointercancel":
        pointerActive = false;
        scheduleIdle();
        break;
      case "touchend":
      case "touchcancel":
        touchActive = false;
        scheduleIdle();
        break;
    }
  }

  function onViewAreaUpdate({ source } = {}) {
    if (source === pdfViewer) {
      observePositionActivity();
    }
  }

  for (const type of TRANSIENT_INTERACTION_EVENTS) {
    interactionTarget.addEventListener(type, onTransientInteraction, true);
  }
  for (const type of GESTURE_INTERACTION_EVENTS) {
    interactionTarget.addEventListener(type, onGestureInteraction, true);
  }
  eventBus.on("pagechanging", onViewAreaUpdate);
  eventBus.on("updateviewarea", onViewAreaUpdate);
  container.addEventListener("scroll", observePositionActivity, { passive: true });

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelIdleTimer();
      positionBeforeInteraction = undefined;
      for (const type of TRANSIENT_INTERACTION_EVENTS) {
        interactionTarget.removeEventListener(type, onTransientInteraction, true);
      }
      for (const type of GESTURE_INTERACTION_EVENTS) {
        interactionTarget.removeEventListener(type, onGestureInteraction, true);
      }
      eventBus.off("pagechanging", onViewAreaUpdate);
      eventBus.off("updateviewarea", onViewAreaUpdate);
      container.removeEventListener("scroll", observePositionActivity);
    },

    hasGenuineInteraction() {
      return genuinePositionChange;
    },

    runWithoutObserving(operation) {
      ignoredPositionChanges += 1;
      try {
        return operation();
      } finally {
        ignoredPositionChanges -= 1;
        if (!genuinePositionChange && intentActive()) {
          positionBeforeInteraction = validPosition(readPosition());
        }
      }
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
  renderOutcomes,
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
    !renderOutcomes ||
    typeof renderOutcomes.outcomeFor !== "function" ||
    typeof startTracking !== "function"
  ) {
    throw new TypeError(
      "document lifecycle, render outcomes, interaction, and tracker operations are required",
    );
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
    const restoredPosition = {
      currentPage: pageNumber,
      scrollTop: position.scrollTop,
    };
    const clampRestoredPosition = () => {
      const bounds = layoutBounds(container);
      restoredPosition.scrollTop = bounds
        ? Math.min(position.scrollTop, bounds.maximumScrollTop)
        : position.scrollTop;
      return bounds;
    };

    if (interaction.hasGenuineInteraction()) {
      clampRestoredPosition();
      const handoffPosition = currentPosition(application, container, pagesCount);
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    const pageReady = await waitForTargetPage({
      eventBus,
      pageNumber,
      pdfViewer: application.pdfViewer,
      renderOutcomes,
      scheduler,
      signal: active.signal,
      navigate() {
        const navigateToPage = () => {
          application.pdfViewer.currentPageNumber = pageNumber;
        };
        if (typeof interaction.runWithoutObserving === "function") {
          interaction.runWithoutObserving(navigateToPage);
        } else {
          navigateToPage();
        }
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
      clampRestoredPosition();
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
      return undefined;
    }
    if (interaction.hasGenuineInteraction()) {
      const handoffPosition = currentPosition(application, container, pagesCount);
      clampRestoredPosition();
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    const bounds = clampRestoredPosition();
    if (bounds) {
      const restoreScroll = () => {
        container.scrollTop = restoredPosition.scrollTop;
      };
      if (typeof interaction.runWithoutObserving === "function") {
        interaction.runWithoutObserving(restoreScroll);
      } else {
        restoreScroll();
      }
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
