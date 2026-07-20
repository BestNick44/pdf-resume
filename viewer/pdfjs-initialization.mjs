const PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS = 10_000;

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
  if (typeof timeoutErrorMessage !== "string" || timeoutErrorMessage.length === 0) {
    throw new TypeError("PDF.js initialization timeout error message is required");
  }

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
      () => finish(new Error(timeoutErrorMessage)),
      PDF_JS_INITIALIZATION_TIMEOUT_MILLISECONDS,
    );
    Promise.resolve(initializedPromise).then(
      () => finish(),
      (error) => finish(error),
    );
  });
}
