// @ts-check

/**
 * @param {{
 *   frame: HTMLIFrameElement,
 *   errorPanel: HTMLElement,
 *   errorMessage: HTMLElement,
 *   fileAccessInstructions: HTMLElement,
 *   warningPanel: HTMLElement,
 *   warningMessage: HTMLElement,
 * }} elements
 */
export function createViewerView({
  frame,
  errorPanel,
  errorMessage,
  fileAccessInstructions,
  warningPanel,
  warningMessage,
}) {
  /** @type {Promise<void> | undefined} */
  let frameLoaded;

  function hideFileAccessInstructions() {
    if (fileAccessInstructions) {
      fileAccessInstructions.hidden = true;
    }
  }

  function hideWarning() {
    if (warningMessage) {
      warningMessage.textContent = "";
    }
    if (warningPanel) {
      warningPanel.hidden = true;
    }
  }

  return {
    /** @param {string} message */
    showError(message) {
      hideFileAccessInstructions();
      hideWarning();
      frame.hidden = true;
      errorMessage.textContent = message;
      errorPanel.hidden = false;
    },
    showFileAccessInstructions() {
      hideWarning();
      frame.hidden = true;
      errorMessage.textContent = "";
      errorPanel.hidden = true;
      fileAccessInstructions.hidden = false;
    },
    /** @param {URL} viewerUrl */
    showViewer(viewerUrl) {
      errorMessage.textContent = "";
      errorPanel.hidden = true;
      hideFileAccessInstructions();
      hideWarning();
      frameLoaded = new Promise((resolve) => {
        frame.addEventListener(
          "load",
          () => {
            frame.focus();
            resolve();
          },
          { once: true },
        );
      });
      frame.src = viewerUrl.href;
      frame.hidden = false;
    },
    /**
     * @param {string} url
     * @param {string} originalUrl
     */
    async openDocument(url, originalUrl) {
      await frameLoaded;
      const frameWindow = /** @type {import("../types/pdfjs.d.ts").PdfJsWindow | null} */ (
        frame.contentWindow
      );
      const application = frameWindow?.PDFViewerApplication;
      if (!application?.initializedPromise || typeof application.open !== "function") {
        throw new Error("PDF.js application is unavailable.");
      }
      await application.initializedPromise;
      await application.open({ url, originalUrl });
    },
    /** @param {string} message */
    showWarning(message) {
      warningMessage.textContent = message;
      warningPanel.hidden = false;
    },
  };
}
