export function createViewerView({
  frame,
  errorPanel,
  errorMessage,
  warningPanel,
  warningMessage,
}) {
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
      hideWarning();
      frame.hidden = true;
      errorMessage.textContent = message;
      errorPanel.hidden = false;
    },
    showViewer(viewerUrl) {
      errorMessage.textContent = "";
      errorPanel.hidden = true;
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
