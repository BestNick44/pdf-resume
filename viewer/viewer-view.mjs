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
    showViewer(viewerUrl) {
      errorMessage.textContent = "";
      errorPanel.hidden = true;
      hideFileAccessInstructions();
      hideWarning();
      frame.addEventListener("load", () => frame.focus(), { once: true });
      frame.src = viewerUrl.href;
      frame.hidden = false;
    },
    showWarning(message) {
      warningMessage.textContent = message;
      warningPanel.hidden = false;
    },
  };
}
