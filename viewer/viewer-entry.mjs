import {
  buildPdfJsViewerUrl,
  parseViewerFileQuery,
  ViewerInputError,
} from "./viewer-url.mjs";

const errorPanel = document.querySelector("#viewerError");
const errorMessage = document.querySelector("#viewerErrorMessage");
const frame = document.querySelector("#pdfViewer");
let objectUrl;

function showError(message) {
  frame.hidden = true;
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

try {
  const fileUrl = parseViewerFileQuery(window.location.search);
  const response = await fetch(fileUrl.href, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Local file request failed (${response.status}).`);
  }

  const pdfBlob = await response.blob();
  const signatureBytes = await pdfBlob.slice(0, 1024).arrayBuffer();
  const signature = new TextDecoder("ascii").decode(signatureBytes);
  if (!signature.includes("%PDF-")) {
    throw new ViewerInputError();
  }

  objectUrl = URL.createObjectURL(pdfBlob);
  frame.addEventListener("load", () => frame.focus(), { once: true });
  frame.src = buildPdfJsViewerUrl(
    objectUrl,
    fileUrl,
    new URL("./pdfjs/web/viewer.html", import.meta.url),
  );
  frame.hidden = false;
} catch (error) {
  if (error instanceof ViewerInputError) {
    showError(error.message);
  } else {
    showError(
      "The local PDF could not be read. Enable “Allow access to file URLs” for pdf-resume and verify that the file still exists.",
    );
  }
}

window.addEventListener("pagehide", () => {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
  }
});
