export function createViewerView({ frame, errorPanel, errorMessage }) {
  return {
    showError(message) {
      frame.hidden = true;
      errorMessage.textContent = message;
      errorPanel.hidden = false;
    },
    showViewer(viewerUrl) {
      errorMessage.textContent = "";
      errorPanel.hidden = true;
      frame.addEventListener("load", () => frame.focus(), { once: true });
      frame.src = viewerUrl.href;
      frame.hidden = false;
    },
  };
}
