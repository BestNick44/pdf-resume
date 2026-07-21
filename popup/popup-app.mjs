import { titleFromLocalPdfFilename } from "../shared/book-title.mjs";
import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";
import { parseViewerFileQuery } from "../viewer/viewer-url.mjs";

const ACTIVE_TAB_QUERY = Object.freeze({ active: true, currentWindow: true });
const TRACK_ACTION = "Track this book";
const RETRY_OPEN_ACTION = "Retry opening viewer";

function fileUrlFromViewer(tabUrl, getRuntimeUrl) {
  const activeUrl = new URL(tabUrl);
  const viewerUrl = new URL(getRuntimeUrl("viewer.html"));
  if (
    activeUrl.protocol !== viewerUrl.protocol ||
    activeUrl.host !== viewerUrl.host ||
    activeUrl.pathname !== viewerUrl.pathname ||
    activeUrl.hash
  ) {
    throw new TypeError("tab is not the extension viewer");
  }
  return parseViewerFileQuery(activeUrl.search).href;
}

function candidateFromTabs(tabs, getRuntimeUrl) {
  if (!Array.isArray(tabs) || tabs.length !== 1) {
    return undefined;
  }

  const [tab] = tabs;
  if (!Number.isInteger(tab?.id) || typeof tab.url !== "string") {
    return undefined;
  }

  let fileUrl;
  try {
    fileUrl = canonicalizeLocalPdfUrl(tab.url).href;
  } catch {
    try {
      fileUrl = fileUrlFromViewer(tab.url, getRuntimeUrl);
    } catch {
      return undefined;
    }
  }

  return {
    fileUrl,
    filename: titleFromLocalPdfFilename(fileUrl),
    tabId: tab.id,
  };
}

function trackedBookDetails(book, status = {}) {
  const hasKnownTotal = book.totalPages > 0;
  return {
    title: book.customTitle ?? book.title,
    customTitle: book.customTitle,
    currentPage: book.currentPage,
    totalPages: book.totalPages,
    pagesRemaining: hasKnownTotal ? Math.max(book.totalPages - book.currentPage, 0) : null,
    progressPercent: hasKnownTotal
      ? Math.min(Math.round((book.currentPage / book.totalPages) * 100), 100)
      : null,
    ...status,
  };
}

function pendingUrlMatches(tab, fileUrl) {
  if (!tab.pendingUrl) {
    return true;
  }

  try {
    return canonicalizeLocalPdfUrl(tab.pendingUrl).href === fileUrl;
  } catch {
    return false;
  }
}

function tabMatchesCandidate(tab, candidate, getRuntimeUrl) {
  const currentCandidate = candidateFromTabs([tab], getRuntimeUrl);
  return (
    currentCandidate?.fileUrl === candidate.fileUrl && pendingUrlMatches(tab, candidate.fileUrl)
  );
}

export function createPopupApp({
  queryActiveTab,
  getTab,
  updateTab,
  getRuntimeUrl,
  getBook,
  removeBook,
  trackBook,
  updateCustomTitle,
  view,
} = {}) {
  if (
    typeof queryActiveTab !== "function" ||
    typeof getTab !== "function" ||
    typeof updateTab !== "function" ||
    typeof getRuntimeUrl !== "function" ||
    typeof getBook !== "function" ||
    typeof removeBook !== "function" ||
    typeof trackBook !== "function" ||
    typeof updateCustomTitle !== "function" ||
    !view
  ) {
    throw new TypeError("popup app requires tab, runtime, storage, and view dependencies");
  }

  let candidate;
  let canActivate = false;
  let destroyed = false;
  let pending;
  let started = false;
  let trackedBook;

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
      if (!tabMatchesCandidate(currentTab, candidate, getRuntimeUrl)) {
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
      const redirectCandidate = await getTab(candidate.tabId);
      if (!tabMatchesCandidate(redirectCandidate, candidate, getRuntimeUrl)) {
        throw new Error("The original tab no longer shows this local PDF.");
      }
      const redirectedTab = await updateTab(candidate.tabId, { url: viewerUrl });
      if (redirectedTab === undefined) {
        throw new Error("The original tab could not be opened in the viewer.");
      }
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

  async function runRename(customTitle) {
    render("showTracked", trackedBookDetails(trackedBook, { busy: true, status: "Saving title…" }));
    try {
      const updated = await updateCustomTitle(candidate.fileUrl, customTitle);
      if (!updated) {
        const title = trackedBook.customTitle ?? trackedBook.title;
        trackedBook = undefined;
        candidate.persisted = false;
        render("showRemoved", { title, message: "This book is no longer tracked." });
        return;
      }
      trackedBook = updated;
      render("showTracked", trackedBookDetails(trackedBook, { status: "Title saved." }));
    } catch {
      render(
        "showTracked",
        trackedBookDetails(trackedBook, {
          error: "The title could not be saved. Try again.",
          status: "Unable to save title",
        }),
      );
    }
  }

  function rename(customTitle) {
    if (!candidate || !trackedBook || pending || destroyed || typeof customTitle !== "string") {
      return pending;
    }
    const normalizedTitle = customTitle.trim() || null;
    if (normalizedTitle === trackedBook.customTitle) {
      return undefined;
    }
    pending = runRename(normalizedTitle).finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function runUntrack() {
    const title = trackedBook.customTitle ?? trackedBook.title;
    render("showTracked", trackedBookDetails(trackedBook, { busy: true, status: "Untracking…" }));
    try {
      await removeBook(candidate.fileUrl);
      trackedBook = undefined;
      render("showRemoved", { title, message: "This book is no longer tracked." });
    } catch {
      render(
        "showTracked",
        trackedBookDetails(trackedBook, {
          error: "This book could not be untracked. Try again.",
          status: "Unable to untrack",
        }),
      );
    }
  }

  function untrack() {
    if (!candidate || !trackedBook || pending || destroyed) {
      return pending;
    }
    pending = runUntrack().finally(() => {
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
      candidate = candidateFromTabs(await queryActiveTab(ACTIVE_TAB_QUERY), getRuntimeUrl);
      if (!candidate) {
        render("showIneligible");
        return;
      }

      const existing = await getBook(candidate.fileUrl);
      if (existing) {
        candidate.persisted = true;
        canActivate = false;
        trackedBook = existing;
        render("showTracked", trackedBookDetails(trackedBook));
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
  view.setRenameHandler(rename);
  view.setUntrackHandler(untrack);
  return Object.freeze({ activate, destroy, rename, start, untrack });
}
