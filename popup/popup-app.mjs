import { titleFromLocalPdfFilename } from "../shared/book-title.mjs";
import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";

const ACTIVE_TAB_QUERY = Object.freeze({ active: true, currentWindow: true });
const TRACK_ACTION = "Track this book";
const RETRY_OPEN_ACTION = "Retry opening viewer";

function candidateFromTabs(tabs) {
  if (!Array.isArray(tabs) || tabs.length !== 1) {
    return undefined;
  }

  const [tab] = tabs;
  if (!Number.isInteger(tab?.id) || typeof tab.url !== "string") {
    return undefined;
  }

  try {
    const fileUrl = canonicalizeLocalPdfUrl(tab.url).href;
    return {
      fileUrl,
      filename: titleFromLocalPdfFilename(fileUrl),
      tabId: tab.id,
    };
  } catch {
    return undefined;
  }
}

export function createPopupApp({
  queryActiveTab,
  getTab,
  updateTab,
  getRuntimeUrl,
  getBook,
  trackBook,
  view,
} = {}) {
  if (
    typeof queryActiveTab !== "function" ||
    typeof getTab !== "function" ||
    typeof updateTab !== "function" ||
    typeof getRuntimeUrl !== "function" ||
    typeof getBook !== "function" ||
    typeof trackBook !== "function" ||
    !view
  ) {
    throw new TypeError("popup app requires tab, runtime, storage, and view dependencies");
  }

  let candidate;
  let canActivate = false;
  let destroyed = false;
  let pending;
  let started = false;

  function render(method, details) {
    if (!destroyed) {
      view[method](details);
    }
  }

  function showReadyCandidate() {
    canActivate = true;
    render("showUntracked", {
      filename: candidate.filename,
      actionLabel: TRACK_ACTION,
    });
  }

  async function runActivation() {
    canActivate = false;
    let stage = "revalidate";
    render("showPending", {
      filename: candidate.filename,
      message: candidate.persisted ? "Opening tracked book…" : "Tracking this book…",
    });

    try {
      const currentTab = await getTab(candidate.tabId);
      const currentCandidate = candidateFromTabs([currentTab]);
      if (!currentCandidate || currentCandidate.fileUrl !== candidate.fileUrl) {
        throw new Error("The original tab no longer shows this local PDF.");
      }

      if (!candidate.persisted) {
        stage = "storage";
        await trackBook(candidate.fileUrl, { title: candidate.filename });
        candidate.persisted = true;
      }

      stage = "redirect";
      const viewerPath = `viewer.html?file=${encodeURIComponent(candidate.fileUrl)}`;
      const viewerUrl = getRuntimeUrl(viewerPath);
      await updateTab(candidate.tabId, { url: viewerUrl });
      render("showSuccess", {
        filename: candidate.filename,
        message: "Book tracked. Opening the viewer…",
      });
    } catch {
      const persisted = Boolean(candidate.persisted);
      const message = persisted
        ? "This book is tracked, but the original PDF tab could not be opened in the viewer. Return that tab to the same PDF and retry."
        : stage === "revalidate"
          ? "The original tab no longer shows this local PDF. No book was tracked."
          : "This book could not be tracked. No changes were made. Try again.";
      canActivate = true;
      render("showError", {
        filename: candidate.filename,
        actionLabel: persisted ? RETRY_OPEN_ACTION : TRACK_ACTION,
        message,
        persisted,
      });
    }
  }

  function activate() {
    if (!candidate || !canActivate || pending || destroyed) {
      return pending;
    }
    pending = runActivation().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function start() {
    if (started || destroyed) {
      return;
    }
    started = true;
    render("showLoading");

    try {
      candidate = candidateFromTabs(await queryActiveTab(ACTIVE_TAB_QUERY));
      if (!candidate) {
        render("showIneligible");
        return;
      }

      const existing = await getBook(candidate.fileUrl);
      if (existing) {
        candidate.persisted = true;
        canActivate = false;
        render("showTracked", {
          filename: candidate.filename,
          message: "This book is already tracked.",
        });
        return;
      }

      candidate.persisted = false;
      showReadyCandidate();
    } catch {
      candidate = undefined;
      render("showError", {
        message: "The popup could not read the active tab or tracked books. Close it and try again.",
      });
    }
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    canActivate = false;
    view.destroy?.();
  }

  view.setActivationHandler(activate);
  return Object.freeze({ activate, destroy, start });
}
