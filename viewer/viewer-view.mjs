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
      frame.addEventListener("load", () => frame.focus(), { once: true });
      frame.src = viewerUrl.href;
      frame.hidden = false;
    },
    /** @param {string} message */
    showWarning(message) {
      warningMessage.textContent = message;
      warningPanel.hidden = false;
    },
  };
}
