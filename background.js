import { canonicalizeLocalPdfUrl } from "./shared/local-pdf-url.mjs";
import { createPositionUpdateMessageHandler } from "./shared/position-update-messaging.mjs";
import { getBook, updatePosition } from "./storage/books.mjs";

const runtime = globalThis.chrome?.runtime;
const tabs = globalThis.chrome?.tabs;
const onBeforeNavigate = globalThis.chrome?.webNavigation?.onBeforeNavigate;

function tabMatchesNavigation(tab, fileUrl) {
  const candidateUrl = tab.pendingUrl ?? tab.url;
  try {
    return canonicalizeLocalPdfUrl(candidateUrl).href === fileUrl;
  } catch {
    return false;
  }
}

async function redirectTrackedLocalPdf(details) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) {
    return;
  }

  let fileUrl;
  try {
    fileUrl = canonicalizeLocalPdfUrl(details.url).href;
  } catch {
    return;
  }

  try {
    if (!(await getBook(fileUrl))) {
      return;
    }
    const tab = await tabs.get(details.tabId);
    if (!tabMatchesNavigation(tab, fileUrl)) {
      return;
    }
    const viewerPath = `viewer.html?file=${encodeURIComponent(fileUrl)}`;
    await tabs.update(details.tabId, { url: runtime.getURL(viewerPath) });
  } catch {
    // A stale tab or unavailable storage should leave the current navigation untouched.
  }
}

if (runtime?.onMessage?.addListener && runtime.id) {
  runtime.onMessage.addListener(
    createPositionUpdateMessageHandler({ extensionId: runtime.id, updatePosition }),
  );
}

if (runtime?.id && tabs?.get && tabs?.update && onBeforeNavigate?.addListener) {
  onBeforeNavigate.addListener(redirectTrackedLocalPdf, {
    url: [{ schemes: ["file"] }],
  });
}
