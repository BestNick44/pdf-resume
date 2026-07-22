// @ts-check

import { samePosition, validPosition } from "../shared/position.mjs";

/** @typedef {import("../types/pdfjs.d.ts").PdfJsApplication} PdfJsApplication */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsDocument} PdfJsDocument */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventBus} PdfJsEventBus */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventMap} PdfJsEventMap */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsPdfViewer} PdfJsPdfViewer */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsPageView} PdfJsPageView */
/** @typedef {import("../types/storage.d.ts").Position} Position */
/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 * }} TimerScheduler
 */
/** @typedef {TimerScheduler & Partial<Pick<typeof globalThis, "requestAnimationFrame" | "cancelAnimationFrame">>} FrameScheduler */
/** @typedef {ReturnType<TimerScheduler["setTimeout"]> | number} FrameHandle */
/** @typedef {PdfJsEventMap[keyof PdfJsEventMap]} PdfJsSourceEvent */
/** @typedef {PdfJsEventMap["pagerendered"]} PdfJsPageRenderedEvent */
/** @typedef {{ pageNumber?: number, error?: unknown }} PdfJsRenderOutcome */
/** @typedef {{ outcomeFor: (pageView: PdfJsPageView) => PdfJsRenderOutcome | undefined }} PdfJsRenderOutcomes */
/** @typedef {{ hasGenuineInteraction: () => boolean, runWithoutObserving?: (operation: () => void) => void }} PdfJsRestoreInteraction */

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

/**
 * @param {PdfJsApplication} application
 * @param {PdfJsDocument | null | undefined} documentIdentity
 * @returns {number | undefined}
 */
function actualPageCount(application, documentIdentity) {
  const documentPages = documentIdentity?.numPages;
  if (
    Number.isInteger(documentPages) &&
    /** @type {number} */ (documentPages) > 0
  ) {
    return /** @type {number} */ (documentPages);
  }
  const viewerPages = application.pdfViewer.pagesCount;
  return Number.isInteger(viewerPages) && viewerPages > 0
    ? viewerPages
    : undefined;
}

/**
 * @param {{
 *   eventBus: PdfJsEventBus,
 *   pageNumber: number,
 *   pdfViewer: PdfJsPdfViewer,
 *   renderOutcomes: PdfJsRenderOutcomes,
 *   scheduler: TimerScheduler,
 *   signal: AbortSignal,
 *   navigate: () => void,
 * }} options
 * @returns {Promise<boolean>}
 */
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
    return Promise.reject(
      new Error(`PDF.js page ${pageNumber} is unavailable.`),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
    let timer;

    /** @param {unknown} [error] */
    function finish(error) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(
        /** @type {ReturnType<TimerScheduler["setTimeout"]>} */ (timer),
      );
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

    /** @param {PdfJsPageRenderedEvent} event */
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

/**
 * @param {FrameScheduler} scheduler
 * @returns {{
 *   requestFrame: (callback: FrameRequestCallback) => FrameHandle,
 *   cancelFrame: (handle: FrameHandle) => void,
 * }}
 */
function frameScheduling(scheduler) {
  /** @type {(callback: FrameRequestCallback) => FrameHandle} */
  const requestFrame =
    typeof scheduler.requestAnimationFrame === "function"
      ? scheduler.requestAnimationFrame.bind(scheduler)
      : (callback) =>
          scheduler.setTimeout(/** @type {() => void} */ (callback), 16);
  /** @type {(handle: FrameHandle) => void} */
  const cancelFrame =
    typeof scheduler.cancelAnimationFrame === "function"
      ? /** @type {(handle: FrameHandle) => void} */ (
          scheduler.cancelAnimationFrame.bind(scheduler)
        )
      : /** @type {(handle: FrameHandle) => void} */ (
          scheduler.clearTimeout.bind(scheduler)
        );
  return { requestFrame, cancelFrame };
}

/**
 * @param {FrameScheduler} scheduler
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
function waitForLayout(scheduler, signal) {
  return new Promise((resolve) => {
    const { requestFrame, cancelFrame } = frameScheduling(scheduler);
    /** @type {FrameHandle | undefined} */
    let frame;
    let settled = false;

    /** @param {boolean} ready */
    function finish(ready) {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    }

    function onAbort() {
      cancelFrame(/** @type {FrameHandle} */ (frame));
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

/**
 * @param {{
 *   application: PdfJsApplication,
 *   eventBus: PdfJsEventBus,
 *   scheduler: TimerScheduler,
 *   signal: AbortSignal,
 * }} options
 * @returns {Promise<boolean>}
 */
function waitForInitialView({ application, eventBus, scheduler, signal }) {
  if (application.isInitialViewSet) {
    return Promise.resolve(true);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
    let timer;

    /**
     * @param {unknown} [error]
     * @param {boolean} [ready]
     */
    function finish(error, ready = true) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(
        /** @type {ReturnType<TimerScheduler["setTimeout"]>} */ (timer),
      );
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

    /** @param {PdfJsSourceEvent} [event] */
    function onDocumentInit({ source } = {}) {
      if (source === application) {
        finish();
      }
    }

    /** @param {PdfJsSourceEvent} [event] */
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

/**
 * Holds the freshly applied restore against late PDF.js-driven navigation.
 *
 * PDF.js 6.1.200 exposes no signal meaning "the final possible initial view
 * has been applied": after `documentinit` it awaits
 * `Promise.race([pagesPromise, 10 s])` and may call `setInitialView` again for
 * unequal page sizes, and hash/OpenAction destinations resolve asynchronously
 * and can land later still. So instead of ordering the restore after all
 * built-in navigation, this defends it: any displacement that occurs without
 * genuine user interaction is re-asserted, until the earliest of genuine
 * interaction, `pagesPromise` settling plus one layout frame (the second
 * `setInitialView` pass runs in that promise's continuation), or the bounded
 * app-owned timeout. Resolves false only when the restore was torn down.
 *
 * @param {{
 *   container: HTMLElement,
 *   eventBus: PdfJsEventBus,
 *   interaction: PdfJsRestoreInteraction,
 *   pdfViewer: PdfJsPdfViewer,
 *   isDisplaced: () => boolean,
 *   reassert: () => void,
 *   scheduler: FrameScheduler,
 *   signal: AbortSignal,
 * }} options
 * @returns {Promise<boolean>}
 */
function defendRestoredPosition({
  container,
  eventBus,
  interaction,
  pdfViewer,
  isDisplaced,
  reassert,
  scheduler,
  signal,
}) {
  return new Promise((resolve) => {
    const { requestFrame, cancelFrame } = frameScheduling(scheduler);
    let settled = false;
    let reasserting = false;
    /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
    let capTimer;
    /** @type {FrameHandle | undefined} */
    let settleFrame;

    /** @param {boolean} defended */
    function finish(defended) {
      if (settled) {
        return;
      }
      settled = true;
      scheduler.clearTimeout(
        /** @type {ReturnType<TimerScheduler["setTimeout"]>} */ (capTimer),
      );
      if (settleFrame !== undefined) {
        cancelFrame(settleFrame);
      }
      eventBus.off("pagechanging", onPositionEvent);
      eventBus.off("updateviewarea", onPositionEvent);
      container.removeEventListener("scroll", holdPosition);
      signal.removeEventListener("abort", onAbort);
      resolve(defended);
    }

    function onAbort() {
      finish(false);
    }

    function holdPosition() {
      if (settled || reasserting) {
        return;
      }
      if (interaction.hasGenuineInteraction()) {
        finish(true);
        return;
      }
      if (!isDisplaced()) {
        return;
      }
      reasserting = true;
      try {
        reassert();
      } finally {
        reasserting = false;
      }
    }

    /** @param {PdfJsSourceEvent} [event] */
    function onPositionEvent({ source } = {}) {
      if (source === pdfViewer) {
        holdPosition();
      }
    }

    eventBus.on("pagechanging", onPositionEvent);
    eventBus.on("updateviewarea", onPositionEvent);
    container.addEventListener("scroll", holdPosition, { passive: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    capTimer = scheduler.setTimeout(
      () => finish(true),
      PDF_JS_INITIAL_VIEW_TIMEOUT_MILLISECONDS,
    );
    const pagesPromise = pdfViewer.pagesPromise;
    const pagesSettled =
      pagesPromise && typeof pagesPromise.then === "function"
        ? Promise.resolve(pagesPromise).then(
            () => {},
            () => {},
          )
        : Promise.resolve();
    pagesSettled.then(() => {
      if (settled) {
        return;
      }
      settleFrame = requestFrame(() => {
        settleFrame = undefined;
        holdPosition();
        finish(true);
      });
    });
  });
}

/**
 * @param {HTMLElement} container
 * @returns {{ maximumScrollTop: number } | undefined}
 */
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

/**
 * @param {PdfJsApplication} application
 * @param {HTMLElement} container
 * @param {number | undefined} pagesCount
 * @returns {Position}
 */
function currentPosition(application, container, pagesCount) {
  const viewerPage = application.pdfViewer.currentPageNumber;
  const currentPage =
    Number.isInteger(viewerPage) && viewerPage > 0 ? viewerPage : 1;
  const boundedPage = pagesCount
    ? Math.min(currentPage, pagesCount)
    : currentPage;
  const viewerScrollTop = container.scrollTop;
  const scrollTop =
    Number.isFinite(viewerScrollTop) && viewerScrollTop >= 0
      ? viewerScrollTop
      : 0;
  const bounds = layoutBounds(container);
  return {
    currentPage: boundedPage,
    scrollTop: bounds
      ? Math.min(scrollTop, bounds.maximumScrollTop)
      : scrollTop,
  };
}

/**
 * @param {{ eventBus?: PdfJsEventBus }} [options]
 */
export function createPdfJsRenderOutcomeTracker({ eventBus } = {}) {
  if (
    !eventBus ||
    typeof eventBus.on !== "function" ||
    typeof eventBus.off !== "function"
  ) {
    throw new TypeError("PDF.js render outcomes require an event bus");
  }

  /** @type {WeakMap<object, PdfJsRenderOutcome>} */
  const outcomes = new WeakMap();
  let destroyed = false;

  /** @param {PdfJsPageRenderedEvent} event */
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

    /** @param {PdfJsPageView} pageView */
    outcomeFor(pageView) {
      return outcomes.get(pageView);
    },
  });
}

/**
 * @param {{
 *   container?: HTMLElement,
 *   eventBus?: PdfJsEventBus,
 *   interactionTarget?: EventTarget | null,
 *   pdfViewer?: PdfJsPdfViewer,
 *   readPosition?: () => Position,
 *   onGenuinePositionChange?: (position: Position) => void,
 *   scheduler?: TimerScheduler,
 * }} [options]
 */
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
    throw new TypeError(
      "restore lifecycle must be able to read the live position",
    );
  }
  if (
    onGenuinePositionChange !== undefined &&
    typeof onGenuinePositionChange !== "function"
  ) {
    throw new TypeError(
      "restore lifecycle position observer must be a function",
    );
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
  /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
  let idleTimer;
  let ignoredPositionChanges = 0;
  let pointerActive = false;
  /** @type {Position | undefined} */
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

  /** @param {{ bounded?: boolean }} [options] */
  function beginIntent({ bounded = false } = {}) {
    positionBeforeInteraction ??= validPosition(
      /** @type {() => Position} */ (readPosition)(),
    );
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
    const position = validPosition(
      /** @type {() => Position} */ (readPosition)(),
    );
    if (samePosition(positionBeforeInteraction, position)) {
      return;
    }
    genuinePositionChange = true;
    onGenuinePositionChange?.(position);
  }

  /** @param {Event} event */
  function onTransientInteraction(event) {
    if (event?.isTrusted === true) {
      beginIntent({ bounded: true });
    }
  }

  /** @param {Event} event */
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

  /** @param {PdfJsSourceEvent} [event] */
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
  container.addEventListener("scroll", observePositionActivity, {
    passive: true,
  });

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      cancelIdleTimer();
      positionBeforeInteraction = undefined;
      for (const type of TRANSIENT_INTERACTION_EVENTS) {
        interactionTarget.removeEventListener(
          type,
          onTransientInteraction,
          true,
        );
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

    /**
     * @template T
     * @param {() => T} operation
     * @returns {T}
     */
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

/**
 * @param {{
 *   application: PdfJsApplication,
 *   container: HTMLElement,
 *   documentIdentity: PdfJsDocument,
 *   eventBus: PdfJsEventBus,
 *   interaction: PdfJsRestoreInteraction,
 *   isCurrent: () => boolean,
 *   renderOutcomes: PdfJsRenderOutcomes,
 *   savedPosition: Position,
 *   scheduler?: FrameScheduler,
 *   signal?: AbortSignal,
 *   startTracking: (initialPosition: Position, currentPosition: Position) => void,
 * }} options
 * @returns {Promise<Position | undefined>}
 */
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
    throw new TypeError(
      "PDF.js application, container, and event bus are required",
    );
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
  /** @param {PdfJsSourceEvent} [event] */
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
    // Readiness signal (amended issue #29): `documentinit`, or an initial view
    // that is already set. PDF.js dispatches `documentinit` immediately after
    // its primary `setInitialView` pass, so stored history / the OpenAction
    // hash has been dispatched by then. This deliberately does NOT wait for
    // `pagesPromise`: restore latency must scale with the target page, not the
    // total page count. Built-in navigation that lands after this signal is
    // handled by `defendRestoredPosition` below, not by waiting longer here.
    if (
      !(await waitForInitialView({
        application,
        eventBus,
        scheduler,
        signal: active.signal,
      })) ||
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
      const handoffPosition = currentPosition(
        application,
        container,
        pagesCount,
      );
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
      const handoffPosition = currentPosition(
        application,
        container,
        pagesCount,
      );
      clampRestoredPosition();
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    if (!(await waitForLayout(scheduler, active.signal)) || !isCurrent()) {
      return undefined;
    }
    if (interaction.hasGenuineInteraction()) {
      const handoffPosition = currentPosition(
        application,
        container,
        pagesCount,
      );
      clampRestoredPosition();
      startTracking(restoredPosition, handoffPosition);
      return handoffPosition;
    }

    const applyRestoredPosition = () => {
      if (application.pdfViewer.currentPageNumber !== pageNumber) {
        application.pdfViewer.currentPageNumber = pageNumber;
      }
      if (clampRestoredPosition()) {
        container.scrollTop = restoredPosition.scrollTop;
      }
      restoredPosition.scrollTop = currentPosition(
        application,
        container,
        pagesCount,
      ).scrollTop;
    };
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

    const defended = await defendRestoredPosition({
      container,
      eventBus,
      interaction,
      pdfViewer: application.pdfViewer,
      isDisplaced: () =>
        application.pdfViewer.currentPageNumber !== pageNumber ||
        container.scrollTop !== restoredPosition.scrollTop,
      reassert() {
        if (typeof interaction.runWithoutObserving === "function") {
          interaction.runWithoutObserving(applyRestoredPosition);
        } else {
          applyRestoredPosition();
        }
      },
      scheduler,
      signal: active.signal,
    });
    if (!defended || !isCurrent()) {
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
