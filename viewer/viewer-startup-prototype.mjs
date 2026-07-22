// @ts-check

/**
 * Issue #30 prototype instrumentation. This observes only app-owned access to
 * PDF.js's public application promise and event bus.
 *
 * @param {import("../types/pdfjs.d.ts").PdfJsFrame} frame
 * @param {{ performance?: Performance, target?: Window }} [dependencies]
 */
export function installViewerStartupPrototypeMeasurements(
  frame,
  {
    performance = globalThis.performance,
    target = globalThis.window,
  } = {},
) {
  /** @type {(value: Readonly<{ initializedMilliseconds: number, firstPageRenderedMilliseconds: number }>) => void} */
  let resolveReady;
  /** @type {(reason?: unknown) => void} */
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const state = {
    initializedMilliseconds: /** @type {number | null} */ (null),
    firstPageRenderedMilliseconds: /** @type {number | null} */ (null),
    ready,
  };

  if (typeof frame.addEventListener !== "function") {
    return state;
  }

  frame.addEventListener(
    "load",
    async () => {
      try {
        const application = frame.contentWindow?.PDFViewerApplication;
        if (!application?.initializedPromise) {
          throw new Error("PDF.js application was unavailable after iframe load.");
        }
        await application.initializedPromise;
        state.initializedMilliseconds = performance.now();
        if (!application.eventBus) {
          throw new Error("PDF.js event bus was unavailable after initialization.");
        }
        const eventBus = application.eventBus;
        /** @param {import("../types/pdfjs.d.ts").PdfJsEventMap["pagerendered"]} event */
        function onPageRendered(event) {
          if (event.error || state.firstPageRenderedMilliseconds !== null) {
            return;
          }
          state.firstPageRenderedMilliseconds = performance.now();
          eventBus.off("pagerendered", onPageRendered);
          resolveReady(
            Object.freeze({
              initializedMilliseconds: /** @type {number} */ (
                state.initializedMilliseconds
              ),
              firstPageRenderedMilliseconds:
                state.firstPageRenderedMilliseconds,
            }),
          );
        }
        eventBus.on("pagerendered", onPageRendered);
      } catch (error) {
        rejectReady(error);
      }
    },
    { once: true },
  );

  Object.defineProperty(target, "__viewerStartupPrototype", {
    configurable: true,
    value: state,
  });
  return state;
}
