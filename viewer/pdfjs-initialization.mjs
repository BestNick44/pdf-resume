// @ts-check

/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 * }} TimerScheduler
 */

const PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS = 10_000;

/**
 * @param {{
 *   initializedPromise?: PromiseLike<unknown>,
 *   scheduler?: TimerScheduler,
 *   signal?: AbortSignal,
 *   timeoutErrorMessage?: string,
 * }} [options]
 * @returns {Promise<boolean>}
 */
export function waitForPdfJsInitialization({
  initializedPromise,
  scheduler,
  signal,
  timeoutErrorMessage,
} = {}) {
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("PDF.js initialization scheduler is required");
  }
  if (
    !signal ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("PDF.js initialization signal must be an AbortSignal");
  }
  if (
    typeof timeoutErrorMessage !== "string" ||
    timeoutErrorMessage.length === 0
  ) {
    throw new TypeError(
      "PDF.js initialization timeout error message is required",
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
    let timer;

    /**
     * @param {unknown} [error]
     * @param {boolean} [initialized]
     */
    function finish(error, initialized = true) {
      if (settled) {
        return;
      }
      settled = true;
      /** @type {TimerScheduler} */ (scheduler).clearTimeout(
        /** @type {ReturnType<TimerScheduler["setTimeout"]>} */ (timer),
      );
      /** @type {AbortSignal} */ (signal).removeEventListener("abort", onAbort);
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
      () => finish(new Error(timeoutErrorMessage)),
      PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS,
    );
    Promise.resolve(initializedPromise).then(
      () => finish(),
      (error) => finish(error),
    );
  });
}
