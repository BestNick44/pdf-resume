// @ts-check

import {
  createPositionObservationSource,
  validPositionObservationMetadata,
  validPositionTrackingGeneration,
} from "../shared/position-update-messaging.mjs";
import { samePosition, validPosition } from "../shared/position.mjs";
import { BooksStorageDataError } from "../storage/books.mjs";
import {
  createPdfJsRenderOutcomeTracker,
  createPdfJsRestoreLifecycle,
  restorePdfJsPosition,
} from "./pdfjs-position-restore.mjs";
import { waitForPdfJsInitialization } from "./pdfjs-initialization.mjs";
import { createPositionSaveController } from "./position-save-controller.mjs";

/** @typedef {import("../types/pdfjs.d.ts").PdfJsApplication} PdfJsApplication */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsDocument} PdfJsDocument */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventBus} PdfJsEventBus */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsEventMap} PdfJsEventMap */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsFrame} PdfJsFrame */
/** @typedef {import("../types/pdfjs.d.ts").PdfJsWindow} PdfJsWindow */
/** @typedef {import("../types/storage.d.ts").BookRecord} BookRecord */
/** @typedef {import("../types/storage.d.ts").Position} Position */
/** @typedef {import("../types/storage.d.ts").PositionObservation} PositionObservation */
/** @typedef {import("../types/storage.d.ts").PositionObservationMetadata} PositionObservationMetadata */
/** @typedef {PdfJsApplication & { appConfig: { mainContainer: HTMLElement } }} PositionPdfJsApplication */
/** @typedef {ReturnType<typeof createPdfJsRenderOutcomeTracker>} RenderOutcomeTracker */
/** @typedef {ReturnType<typeof createPdfJsRestoreLifecycle>} RestoreLifecycle */
/** @typedef {ReturnType<typeof createPositionSaveController>} PositionSaveController */

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 *   requestAnimationFrame?: (callback: FrameRequestCallback) => number,
 *   cancelAnimationFrame?: (handle: number) => void,
 * }} PositionTrackingScheduler
 */

/** @typedef {{ viewerId: string, next: () => PositionObservationMetadata }} PositionObservationSource */
/** @typedef {{ book: BookRecord, trackingGeneration: string }} PositionTrackingState */

const DEFAULT_INITIAL_READ_RETRY_DELAYS = Object.freeze([250, 1_000, 4_000]);

/** @param {PositionPdfJsApplication} application */
function readViewerPosition(application) {
  return {
    currentPage: application.pdfViewer.currentPageNumber,
    scrollTop: application.appConfig.mainContainer.scrollTop,
  };
}

/** @param {readonly number[]} delays */
function validateRetryDelays(delays) {
  if (
    !Array.isArray(delays) ||
    delays.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new TypeError("initial read retry delays must be non-negative numbers");
  }
  return [...delays];
}

/**
 * @param {PositionObservationMetadata} observation
 * @param {string} trackingGeneration
 * @returns {PositionObservation}
 */
function registeredObservation(observation, trackingGeneration) {
  return {
    ...observation,
    intent: "registered",
    trackingGeneration,
  };
}

/**
 * @param {{
 *   fileUrl: string,
 *   frame: PdfJsFrame,
 *   hostDocument: Document,
 *   getPositionTrackingState: (fileUrl: string, viewerId: string) => Promise<PositionTrackingState | undefined>,
 *   recordObservation: (
 *     fileUrl: string,
 *     position: Position,
 *     observation: PositionObservation,
 *     options?: { handoff?: boolean },
 *   ) => Promise<Position | undefined> | undefined,
 *   scheduler?: PositionTrackingScheduler,
 *   clock?: { now: () => number },
 *   observationSource?: PositionObservationSource,
 *   initialReadRetryDelays?: readonly number[],
 *   restorePosition?: typeof restorePdfJsPosition,
 *   createRenderOutcomeTracker?: typeof createPdfJsRenderOutcomeTracker,
 *   createRestoreLifecycle?: typeof createPdfJsRestoreLifecycle,
 *   createSaveController?: typeof createPositionSaveController,
 *   reportError?: (error: unknown) => void,
 * }} [dependencies]
 */
export function createPdfJsPositionTracking({
  fileUrl,
  frame,
  hostDocument,
  getPositionTrackingState,
  recordObservation,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
  observationSource,
  initialReadRetryDelays = DEFAULT_INITIAL_READ_RETRY_DELAYS,
  restorePosition = restorePdfJsPosition,
  createRenderOutcomeTracker = createPdfJsRenderOutcomeTracker,
  createRestoreLifecycle = createPdfJsRestoreLifecycle,
  createSaveController = createPositionSaveController,
  reportError = (error) => console.error("Unable to restore PDF position.", error),
} = /** @type {never} */ ({})) {
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
    typeof getPositionTrackingState !== "function" ||
    typeof recordObservation !== "function" ||
    typeof restorePosition !== "function" ||
    typeof createRenderOutcomeTracker !== "function" ||
    typeof createRestoreLifecycle !== "function" ||
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
  const observations =
    observationSource ?? createPositionObservationSource({ clock });
  if (!observations || typeof observations.next !== "function") {
    throw new TypeError("observationSource must provide next");
  }
  const observationViewerId = validPositionObservationMetadata({
    viewerId: observations.viewerId,
    sequence: 1,
    observedAt: 0,
  }).viewerId;

  let generation = 0;
  /** @type {PositionPdfJsApplication | undefined} */
  let application;
  /** @type {PdfJsEventBus | undefined} */
  let eventBus;
  /** @type {((event: PdfJsEventMap["pagesinit"]) => void) | undefined} */
  let pagesInitListener;
  /** @type {((event: PdfJsEventMap["pagesdestroy"]) => void) | undefined} */
  let pagesDestroyListener;
  /** @type {PdfJsDocument | undefined} */
  let originalDocument;
  /** @type {PdfJsDocument | undefined} */
  let activatingDocument;
  /** @type {AbortController | undefined} */
  let activationAbort;
  /** @type {AbortController | undefined} */
  let initializationAbort;
  /** @type {RenderOutcomeTracker | undefined} */
  let renderOutcomes;
  /** @type {RestoreLifecycle | undefined} */
  let restoreLifecycle;
  /** @type {Position | undefined} */
  let restoringPosition;
  /** @type {{ position: Position, observation: PositionObservationMetadata } | undefined} */
  let restorationObservation;
  let restorationHandoffSent = false;
  /** @type {string | undefined} */
  let trackingGeneration;
  /** @type {{ documentIdentity: PdfJsDocument, expectedGeneration: number } | undefined} */
  let pendingTrackingRead;
  /** @type {{ resolve: (ready: boolean) => void, timer: ReturnType<typeof globalThis.setTimeout> } | undefined} */
  let readRetry;
  /** @type {PositionSaveController | undefined} */
  let controller;
  /** @type {{
   *   bus: PdfJsEventBus,
   *   container: HTMLElement,
   *   onPositionEvent: (event: PdfJsEventMap["pagechanging"] | PdfJsEventMap["updateviewarea"]) => void,
   *   onScroll: () => void,
   * } | undefined} */
  let positionListeners;
  /** @type {Promise<void>} */
  let setupPromise = Promise.resolve();
  /** @type {Set<{ controller: PositionSaveController, promise: Promise<void> | undefined }>} */
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

  /** @param {number} delay */
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

  /** @param {boolean} flush */
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
    /** @type {{ controller: PositionSaveController, promise: Promise<void> | undefined }} */
    const retirement = { controller: retired, promise: undefined };
    retiring.add(retirement);
    retirement.promise = retired
      .retire()
      .catch(() => {})
      .finally(() => {
        retired.destroy();
        retiring.delete(retirement);
      });
  }

  function removePositionListeners({ flush = false } = {}) {
    activationAbort?.abort();
    activationAbort = undefined;
    restoreLifecycle?.destroy();
    restoreLifecycle = undefined;
    restoringPosition = undefined;
    restorationObservation = undefined;
    restorationHandoffSent = false;
    trackingGeneration = undefined;
    pendingTrackingRead = undefined;
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
    initializationAbort?.abort();
    initializationAbort = undefined;
    removePositionListeners({ flush });
    renderOutcomes?.destroy();
    renderOutcomes = undefined;
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

  /**
   * @param {PdfJsDocument} documentIdentity
   * @param {number} expectedGeneration
   */
  function isCurrentDocument(documentIdentity, expectedGeneration) {
    return (
      generation === expectedGeneration &&
      application?.pdfDocument === documentIdentity &&
      originalDocument === documentIdentity
    );
  }

  /**
   * @param {PdfJsDocument} documentIdentity
   * @param {number} expectedGeneration
   */
  async function readTrackedBook(documentIdentity, expectedGeneration) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const activeRead = { documentIdentity, expectedGeneration };
        pendingTrackingRead = activeRead;
        try {
          return await getPositionTrackingState(fileUrl, observationViewerId);
        } finally {
          if (pendingTrackingRead === activeRead) {
            pendingTrackingRead = undefined;
          }
        }
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

  /**
   * @param {{
   *   activeApplication: PositionPdfJsApplication,
   *   bus: PdfJsEventBus,
   *   container: HTMLElement,
   *   currentPosition: Position,
   *   documentIdentity: PdfJsDocument,
   *   expectedGeneration: number,
   *   initialPosition: Position,
   * }} state
   */
  function armPositionTracking({
    activeApplication,
    bus,
    container,
    currentPosition,
    documentIdentity,
    expectedGeneration,
    initialPosition,
  }) {
    if (
      controller ||
      positionListeners ||
      !isCurrentDocument(documentIdentity, expectedGeneration)
    ) {
      return;
    }

    restoreLifecycle?.destroy();
    restoreLifecycle = undefined;
    restoringPosition = undefined;
    restorationHandoffSent = false;
    const activeTrackingGeneration = /** @type {string} */ (trackingGeneration);
    controller = createSaveController({
      fileUrl,
      initialPosition,
      /**
       * @param {string} fileUrl
       * @param {Position} position
       * @param {PositionObservationMetadata} observation
       */
      recordObservation(fileUrl, position, observation) {
        return /** @type {Promise<Position | undefined>} */ (
          recordObservation(
            fileUrl,
            position,
            registeredObservation(observation, activeTrackingGeneration),
          )
        );
      },
      scheduler,
      clock,
      observationSource: observations,
    });
    /**
     * @param {Position} [position]
     * @param {PositionObservationMetadata} [observation]
     */
    const capturePosition = (position, observation) => {
      if (!isCurrentDocument(documentIdentity, expectedGeneration)) {
        return;
      }
      controller?.observe(
        position ?? readViewerPosition(activeApplication),
        observation,
      );
    };
    /** @param {PdfJsEventMap["pagechanging"] | PdfJsEventMap["updateviewarea"]} [event] */
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
    const boundaryObservation =
      restorationObservation &&
      samePosition(restorationObservation.position, currentPosition)
        ? restorationObservation.observation
        : undefined;
    restorationObservation = undefined;
    capturePosition(currentPosition, boundaryObservation);
  }

  /**
   * @param {PdfJsDocument} documentIdentity
   * @param {number} expectedGeneration
   */
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
    /** @type {PositionPdfJsApplication | undefined} */
    let activeApplication;
    /** @type {PdfJsEventBus | undefined} */
    let bus;
    /** @type {HTMLElement | undefined} */
    let container;
    /** @type {RestoreLifecycle | undefined} */
    let lifecycle;
    /** @type {AbortController | undefined} */
    let restoreAbort;
    let restoreStarted = false;

    try {
      activeApplication = /** @type {PositionPdfJsApplication} */ (application);
      bus = /** @type {PdfJsEventBus} */ (eventBus);
      container = activeApplication.appConfig.mainContainer;
      const readyApplication = activeApplication;
      const readyBus = bus;
      const readyContainer = container;
      lifecycle = createRestoreLifecycle({
        container: readyContainer,
        eventBus: readyBus,
        interactionTarget: frame.contentWindow,
        pdfViewer: readyApplication.pdfViewer,
        readPosition: () => readViewerPosition(readyApplication),
        /** @param {Position} position */
        onGenuinePositionChange(position) {
          if (!isCurrentDocument(documentIdentity, expectedGeneration)) {
            return;
          }
          const positionValue = validPosition(position);
          if (
            restorationObservation &&
            samePosition(restorationObservation.position, positionValue)
          ) {
            return;
          }
          restorationObservation = {
            position: positionValue,
            observation: observations.next(),
          };
        },
        scheduler,
      });
      restoreLifecycle = lifecycle;
      const trackingState = await readTrackedBook(
        documentIdentity,
        expectedGeneration,
      );
      if (
        !trackingState ||
        !isCurrentDocument(documentIdentity, expectedGeneration)
      ) {
        return;
      }
      const book = trackingState.book;
      trackingGeneration = validPositionTrackingGeneration(
        trackingState.trackingGeneration,
      );

      restoringPosition = validPosition(book, "saved position");
      restoreAbort = new AbortController();
      activationAbort = restoreAbort;
      restoreStarted = true;
      await restorePosition({
        application: readyApplication,
        container: readyContainer,
        documentIdentity,
        eventBus: readyBus,
        interaction: lifecycle,
        isCurrent: () => isCurrentDocument(documentIdentity, expectedGeneration),
        renderOutcomes: /** @type {RenderOutcomeTracker} */ (renderOutcomes),
        savedPosition: book,
        scheduler,
        signal: restoreAbort.signal,
        /**
         * @param {Position} initialPosition
         * @param {Position} currentPosition
         */
        startTracking(initialPosition, currentPosition) {
          armPositionTracking({
            activeApplication: readyApplication,
            bus: readyBus,
            container: readyContainer,
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
        if (restoreStarted) {
          const currentPosition = readViewerPosition(
            /** @type {PositionPdfJsApplication} */ (activeApplication),
          );
          const hasBoundaryActivity =
            restorationObservation &&
            samePosition(restorationObservation.position, currentPosition);
          armPositionTracking({
            activeApplication: /** @type {PositionPdfJsApplication} */ (
              activeApplication
            ),
            bus: /** @type {PdfJsEventBus} */ (bus),
            container: /** @type {HTMLElement} */ (container),
            currentPosition,
            documentIdentity,
            expectedGeneration,
            initialPosition: hasBoundaryActivity
              ? /** @type {Position} */ (restoringPosition)
              : currentPosition,
          });
        }
      }
    } finally {
      if (!controller) {
        lifecycle?.destroy();
        if (restoreLifecycle === lifecycle) {
          restoreLifecycle = undefined;
          restoringPosition = undefined;
          restorationObservation = undefined;
          restorationHandoffSent = false;
        }
      }
      if (activationAbort === restoreAbort) {
        activationAbort = undefined;
      }
      if (activatingDocument === documentIdentity) {
        activatingDocument = undefined;
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
      setupPromise = activateDocument(documentIdentity, expectedGeneration);
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
      removeViewerListeners({ flush: true });
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
        timeoutErrorMessage: "PDF.js application initialization timed out.",
      })) ||
      generation !== expectedGeneration ||
      frame.contentWindow !== frameWindow ||
      !nextApplication.eventBus ||
      !nextApplication.pdfViewer ||
      !nextApplication.appConfig?.mainContainer
    ) {
      return;
    }

    application = /** @type {PositionPdfJsApplication} */ (nextApplication);
    eventBus = application.eventBus;
    renderOutcomes = createRenderOutcomeTracker({ eventBus });
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

  function flushLivePosition() {
    if (!controller || !application || application.pdfDocument !== originalDocument) {
      return;
    }
    void controller.flush(readViewerPosition(application));
  }

  function handoffLivePosition() {
    if (!application || application.pdfDocument !== originalDocument) {
      return;
    }
    const position = readViewerPosition(application);
    if (!trackingGeneration) {
      if (
        !pendingTrackingRead ||
        restorationHandoffSent ||
        !restoreLifecycle?.hasGenuineInteraction() ||
        !restorationObservation ||
        !samePosition(restorationObservation.position, position)
      ) {
        return;
      }
      restorationHandoffSent = true;
      try {
        recordObservation(
          fileUrl,
          position,
          {
            ...restorationObservation.observation,
            intent: "pending",
          },
          { handoff: true },
        );
      } catch {
        // The lifecycle sender cannot synchronously wait for or report durable storage.
      }
      return;
    }

    let handoff;
    if (controller) {
      handoff = controller.prepareHandoff(position);
      if (!handoff) {
        return;
      }
    } else {
      if (
        restorationHandoffSent ||
        !restoreLifecycle?.hasGenuineInteraction() ||
        (restoringPosition && samePosition(position, restoringPosition))
      ) {
        return;
      }
      restorationHandoffSent = true;
      handoff = {
        position,
        observation:
          restorationObservation &&
          samePosition(restorationObservation.position, position)
            ? restorationObservation.observation
            : observations.next(),
      };
    }
    try {
      recordObservation(
        fileUrl,
        handoff.position,
        registeredObservation(handoff.observation, trackingGeneration),
        { handoff: true },
      );
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
      await Promise.all([...retiring].map(({ promise }) => promise));
      return status;
    },

    destroy() {
      generation += 1;
      frame.removeEventListener("load", onFrameLoad);
      removeViewerListeners();
      for (const { controller: retired } of retiring) {
        retired.destroy();
      }
    },
  });
}
