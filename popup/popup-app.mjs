// @ts-check

import { titleFromLocalPdfFilename } from "../shared/book-title.mjs";
import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";
import { parseViewerFileQuery } from "../viewer/viewer-url.mjs";

/** @typedef {import("../types/storage.d.ts").BookRecord} BookRecord */
/** @typedef {import("../types/storage.d.ts").BookWithCompletion} BookWithCompletion */
/** @typedef {ReturnType<typeof import("./popup-view.mjs").createPopupView>} PopupView */
/** @typedef {{ fileUrl: string, filename: string, tabId: number, persisted?: boolean }} PopupCandidate */
/** @typedef {{ tabId: number, url?: string, pendingUrl?: string }} CapturedTabNavigation */
/** @typedef {NonNullable<NonNullable<Parameters<PopupView["showLibrary"]>[0]>["books"]>[number]} LibraryBookDetails */
/** @typedef {{ busy?: boolean, customTitleDraft?: string, error?: string, fileAccessRequired?: boolean, status?: string }} TrackedStatus */
/** @typedef {TrackedStatus & { title: string, customTitle: string | null, currentPage: number, totalPages: number, pagesRemaining: number | null, progressPercent: number | null, completionAction?: "complete" | "reading" }} TrackedBookDetails */
/** @typedef {{ filename: string, actionLabel: string }} UntrackedDetails */
/** @typedef {{ filename: string, message: string }} PendingDetails */
/** @typedef {{ filename?: string, message: string, actionLabel?: string, persisted?: boolean }} ErrorDetails */
/** @typedef {{ filename: string }} FileAccessDetails */
/** @typedef {{ books: LibraryBookDetails[], completedBooks?: LibraryBookDetails[], busy?: boolean, error?: string, status?: string }} LibraryDetails */
/** @typedef {{ title: string, message: string }} RemovedDetails */
/** @typedef {{ filename: string, message: string }} SuccessDetails */
/**
 * @typedef {{
 *   queryActiveTab: (query: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>,
 *   getTab: (tabId: number) => Promise<chrome.tabs.Tab>,
 *   updateTab: (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => Promise<chrome.tabs.Tab | undefined>,
 *   getRuntimeUrl: (path: string) => string,
 *   isFileSchemeAccessAllowed: () => Promise<boolean>,
 *   completeBook: (fileUrl: string) => Promise<BookWithCompletion | undefined>,
 *   getBookWithCompletion: (fileUrl: string) => Promise<BookWithCompletion | undefined>,
 *   listBooksWithCompletion: () => Promise<Array<{ fileUrl: string, book: BookRecord, completedAt: number | null }>>,
 *   markBookReading: (fileUrl: string) => Promise<BookWithCompletion | undefined>,
 *   removeBook: (fileUrl: string) => Promise<boolean>,
 *   trackBook: (fileUrl: string, patch: Pick<BookRecord, "title">) => Promise<BookRecord>,
 *   updateCustomTitle: (fileUrl: string, customTitle: string | null) => Promise<BookRecord | undefined>,
 *   view: PopupView,
 * }} PopupDependencies
 */
/**
 * @typedef {{
 *   showError: ErrorDetails,
 *   showFileAccessInstructions: FileAccessDetails,
 *   showIneligible: undefined,
 *   showLibrary: LibraryDetails,
 *   showLoading: undefined,
 *   showPending: PendingDetails,
 *   showRemoved: RemovedDetails,
 *   showSuccess: SuccessDetails,
 *   showTracked: TrackedBookDetails,
 *   showUntracked: UntrackedDetails,
 * }} PopupRenderDetails
 */

const ACTIVE_TAB_QUERY = Object.freeze({ active: true, currentWindow: true });
const TRACK_ACTION = "Track this book";
const RETRY_OPEN_ACTION = "Retry opening viewer";

/**
 * @param {string} tabUrl
 * @param {(path: string) => string} getRuntimeUrl
 */
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

/**
 * @param {unknown} tabs
 * @param {(path: string) => string} getRuntimeUrl
 * @returns {PopupCandidate | undefined}
 */
function candidateFromTabs(tabs, getRuntimeUrl) {
  if (!Array.isArray(tabs) || tabs.length !== 1) {
    return undefined;
  }

  const [tab] = /** @type {Array<{ id?: unknown, url?: unknown }>} */ (tabs);
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
    tabId: /** @type {number} */ (tab.id),
  };
}

/** @param {BookRecord} book */
function displayTotalPages(book) {
  return book.totalPages >= book.currentPage ? book.totalPages : 0;
}

/**
 * @param {number} currentPage
 * @param {number} totalPages
 */
function progressPercent(currentPage, totalPages) {
  return totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : null;
}

/**
 * @param {BookRecord} book
 * @param {number | null} completedAt
 * @param {TrackedStatus} [status]
 * @returns {TrackedBookDetails}
 */
function trackedBookDetails(book, completedAt, status = {}) {
  const totalPages = displayTotalPages(book);
  const completionAction =
    completedAt !== null
      ? "reading"
      : totalPages > 0 && book.currentPage === totalPages
        ? "complete"
        : null;
  return {
    title: book.customTitle ?? book.title,
    customTitle: book.customTitle,
    currentPage: book.currentPage,
    totalPages,
    pagesRemaining: totalPages > 0 ? totalPages - book.currentPage : null,
    progressPercent: progressPercent(book.currentPage, totalPages),
    ...(completionAction ? { completionAction } : {}),
    ...status,
  };
}

/**
 * @param {{ fileUrl: string, book: BookRecord }} entry
 * @returns {LibraryBookDetails}
 */
function libraryBookDetails({ fileUrl, book }) {
  const totalPages = displayTotalPages(book);
  return {
    fileUrl,
    title: book.customTitle ?? book.title,
    currentPage: book.currentPage,
    totalPages,
    progressPercent: progressPercent(book.currentPage, totalPages),
  };
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {string} fileUrl
 */
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

/**
 * @param {chrome.tabs.Tab} tab
 * @param {PopupCandidate} candidate
 * @param {(path: string) => string} getRuntimeUrl
 */
function tabMatchesCandidate(tab, candidate, getRuntimeUrl) {
  const currentCandidate = candidateFromTabs([tab], getRuntimeUrl);
  return (
    currentCandidate?.fileUrl === candidate.fileUrl && pendingUrlMatches(tab, candidate.fileUrl)
  );
}

/**
 * @param {chrome.tabs.Tab & { id: number }} tab
 * @returns {CapturedTabNavigation}
 */
function captureTabNavigation(tab) {
  return {
    tabId: tab.id,
    url: tab.url,
    pendingUrl: tab.pendingUrl,
  };
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {CapturedTabNavigation} capturedTab
 */
function tabMatchesCapturedNavigation(tab, capturedTab) {
  return tab?.id === capturedTab.tabId &&
    tab.url === capturedTab.url &&
    tab.pendingUrl === capturedTab.pendingUrl;
}

/** @param {PopupDependencies} dependencies */
export function createPopupApp({
  queryActiveTab,
  getTab,
  updateTab,
  getRuntimeUrl,
  isFileSchemeAccessAllowed,
  completeBook,
  getBookWithCompletion,
  listBooksWithCompletion,
  markBookReading,
  removeBook,
  trackBook,
  updateCustomTitle,
  view,
} = /** @type {PopupDependencies} */ ({})) {
  if (
    typeof queryActiveTab !== "function" ||
    typeof getTab !== "function" ||
    typeof updateTab !== "function" ||
    typeof getRuntimeUrl !== "function" ||
    typeof isFileSchemeAccessAllowed !== "function" ||
    typeof completeBook !== "function" ||
    typeof getBookWithCompletion !== "function" ||
    typeof listBooksWithCompletion !== "function" ||
    typeof markBookReading !== "function" ||
    typeof removeBook !== "function" ||
    typeof trackBook !== "function" ||
    typeof updateCustomTitle !== "function" ||
    !view
  ) {
    throw new TypeError("popup app requires tab, runtime, storage, and view dependencies");
  }

  /** @type {PopupCandidate | undefined} */
  let candidate;
  let canActivate = false;
  /** @type {number | null} */
  let completedAt = null;
  let destroyed = false;
  /** @type {LibraryBookDetails[] | undefined} */
  let libraryBooks;
  /** @type {LibraryBookDetails[]} */
  let completedLibraryBooks = [];
  /** @type {Map<string, BookRecord>} */
  let libraryBookRecords = new Map();
  /** @type {Map<string, number | null>} */
  let libraryCompletionRecords = new Map();
  /** @type {CapturedTabNavigation | undefined} */
  let libraryTab;
  let needsFileAccessInstructions = false;
  /** @type {Promise<void> | undefined} */
  let pending;
  let started = false;
  /** @type {BookRecord | undefined} */
  let trackedBook;

  /**
   * @template {keyof PopupRenderDetails} Method
   * @param {Method} method
   * @param {PopupRenderDetails[Method]} [details]
   */
  function render(method, details) {
    if (!destroyed) {
      /** @type {(details?: PopupRenderDetails[Method]) => void} */ (
        view[method]
      )(details);
    }
  }

  /**
   * @param {TrackedStatus} [status]
   * @returns {TrackedBookDetails}
   */
  function currentTrackedBookDetails(status = {}) {
    return trackedBookDetails(
      /** @type {BookRecord} */ (trackedBook),
      completedAt,
      {
        ...status,
        ...(needsFileAccessInstructions ? { fileAccessRequired: true } : {}),
      },
    );
  }

  function showReadyCandidate() {
    canActivate = true;
    render("showUntracked", {
      filename: /** @type {PopupCandidate} */ (candidate).filename,
      actionLabel: TRACK_ACTION,
    });
  }

  function currentLibraryDetails(status = {}) {
    return {
      books: /** @type {LibraryBookDetails[]} */ (libraryBooks),
      ...(completedLibraryBooks.length > 0
        ? { completedBooks: completedLibraryBooks }
        : {}),
      ...status,
    };
  }

  async function loadLibraryBooks() {
    const entries = await listBooksWithCompletion();
    libraryBooks = entries
      .filter(({ completedAt: entryCompletedAt }) => entryCompletedAt === null)
      .map(libraryBookDetails);
    completedLibraryBooks = entries
      .filter(({ completedAt: entryCompletedAt }) => entryCompletedAt !== null)
      .map(libraryBookDetails);
    libraryBookRecords = new Map(
      entries.map(({ fileUrl, book }) => [fileUrl, book]),
    );
    libraryCompletionRecords = new Map(
      entries.map(({ fileUrl, completedAt: entryCompletedAt }) => [
        fileUrl,
        entryCompletedAt,
      ]),
    );
    return currentLibraryDetails();
  }

  async function runActivation() {
    canActivate = false;
    let stage = "permission";
    render("showPending", {
      filename: /** @type {PopupCandidate} */ (candidate).filename,
      message: /** @type {PopupCandidate} */ (candidate).persisted
        ? "Opening tracked book…"
        : "Tracking this book…",
    });

    try {
      if (!(await isFileSchemeAccessAllowed())) {
        render("showFileAccessInstructions", {
          filename: /** @type {PopupCandidate} */ (candidate).filename,
        });
        return;
      }

      stage = "revalidate";
      const currentTab = await getTab(
        /** @type {PopupCandidate} */ (candidate).tabId,
      );
      if (
        !tabMatchesCandidate(
          currentTab,
          /** @type {PopupCandidate} */ (candidate),
          getRuntimeUrl,
        )
      ) {
        throw new Error("The original tab no longer shows this local PDF.");
      }

      if (!/** @type {PopupCandidate} */ (candidate).persisted) {
        stage = "permission";
        if (!(await isFileSchemeAccessAllowed())) {
          render("showFileAccessInstructions", {
            filename: /** @type {PopupCandidate} */ (candidate).filename,
          });
          return;
        }

        stage = "revalidate";
        const persistenceCandidate = await getTab(
          /** @type {PopupCandidate} */ (candidate).tabId,
        );
        if (
          !tabMatchesCandidate(
            persistenceCandidate,
            /** @type {PopupCandidate} */ (candidate),
            getRuntimeUrl,
          )
        ) {
          throw new Error("The original tab no longer shows this local PDF.");
        }
        stage = "storage";
        await trackBook(/** @type {PopupCandidate} */ (candidate).fileUrl, {
          title: /** @type {PopupCandidate} */ (candidate).filename,
        });
        /** @type {PopupCandidate} */ (candidate).persisted = true;
      }

      stage = "permission";
      if (!(await isFileSchemeAccessAllowed())) {
        render("showFileAccessInstructions", {
          filename: /** @type {PopupCandidate} */ (candidate).filename,
        });
        return;
      }

      stage = "redirect";
      const viewerPath = `viewer.html?file=${encodeURIComponent(
        /** @type {PopupCandidate} */ (candidate).fileUrl,
      )}`;
      const viewerUrl = getRuntimeUrl(viewerPath);
      const redirectCandidate = await getTab(
        /** @type {PopupCandidate} */ (candidate).tabId,
      );
      if (
        !tabMatchesCandidate(
          redirectCandidate,
          /** @type {PopupCandidate} */ (candidate),
          getRuntimeUrl,
        )
      ) {
        throw new Error("The original tab no longer shows this local PDF.");
      }
      const redirectedTab = await updateTab(
        /** @type {PopupCandidate} */ (candidate).tabId,
        { url: viewerUrl },
      );
      if (redirectedTab === undefined) {
        throw new Error("The original tab could not be opened in the viewer.");
      }
      render("showSuccess", {
        filename: /** @type {PopupCandidate} */ (candidate).filename,
        message: "Book tracked. Opening the viewer…",
      });
    } catch {
      const persisted = Boolean(
        /** @type {PopupCandidate} */ (candidate).persisted,
      );
      const message = persisted
        ? "This book is tracked, but the original PDF tab could not be opened in the viewer. Return that tab to the same PDF and retry."
        : stage === "revalidate"
          ? "The original tab no longer shows this local PDF. No book was tracked."
          : "This book could not be tracked. No changes were made. Try again.";
      canActivate = true;
      render("showError", {
        filename: /** @type {PopupCandidate} */ (candidate).filename,
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

  /**
   * @param {string | null} customTitle
   * @param {string} customTitleDraft
   */
  async function runRename(customTitle, customTitleDraft) {
    render(
      "showTracked",
      currentTrackedBookDetails({
        busy: true,
        customTitleDraft,
        status: "Saving title…",
      }),
    );
    try {
      const updated = await updateCustomTitle(
        /** @type {PopupCandidate} */ (candidate).fileUrl,
        customTitle,
      );
      if (!updated) {
        const title =
          /** @type {BookRecord} */ (trackedBook).customTitle ??
          /** @type {BookRecord} */ (trackedBook).title;
        trackedBook = undefined;
        /** @type {PopupCandidate} */ (candidate).persisted = false;
        render("showRemoved", { title, message: "This book is no longer tracked." });
        return;
      }
      trackedBook = updated;
      render(
        "showTracked",
        currentTrackedBookDetails({ status: "Title saved." }),
      );
    } catch {
      render(
        "showTracked",
        currentTrackedBookDetails({
          customTitleDraft,
          error: "The title could not be saved. Try again.",
          status: "Unable to save title",
        }),
      );
    }
  }

  /** @param {unknown} customTitle */
  function rename(customTitle) {
    if (!candidate || !trackedBook || pending || destroyed || typeof customTitle !== "string") {
      return pending;
    }
    const normalizedTitle = customTitle.trim() || null;
    if (normalizedTitle === trackedBook.customTitle) {
      return undefined;
    }
    pending = runRename(normalizedTitle, customTitle).finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function runCompletionChange() {
    const movingToReading = completedAt !== null;
    render(
      "showTracked",
      currentTrackedBookDetails({
        busy: true,
        status: movingToReading ? "Moving to reading…" : "Completing book…",
      }),
    );
    try {
      const updated = await (movingToReading ? markBookReading : completeBook)(
        /** @type {PopupCandidate} */ (candidate).fileUrl,
      );
      if (!updated) {
        const title =
          /** @type {BookRecord} */ (trackedBook).customTitle ??
          /** @type {BookRecord} */ (trackedBook).title;
        trackedBook = undefined;
        completedAt = null;
        /** @type {PopupCandidate} */ (candidate).persisted = false;
        render("showRemoved", { title, message: "This book is no longer tracked." });
        return;
      }
      trackedBook = updated.book;
      completedAt = updated.completedAt;
      render(
        "showTracked",
        currentTrackedBookDetails({
          status: movingToReading ? "Moved to reading." : "Book completed.",
        }),
      );
    } catch {
      render(
        "showTracked",
        currentTrackedBookDetails({
          error: movingToReading
            ? "This book could not be moved to reading. Try again."
            : "This book could not be completed. Try again.",
          status: movingToReading
            ? "Unable to move book to reading"
            : "Unable to complete book",
        }),
      );
    }
  }

  function changeCompletion() {
    const isOnFinalPage =
      trackedBook &&
      trackedBook.totalPages > 0 &&
      trackedBook.currentPage === trackedBook.totalPages;
    if (
      !candidate ||
      !trackedBook ||
      (completedAt === null && !isOnFinalPage) ||
      pending ||
      destroyed
    ) {
      return pending;
    }
    pending = runCompletionChange().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  async function runUntrack() {
    const title =
      /** @type {BookRecord} */ (trackedBook).customTitle ??
      /** @type {BookRecord} */ (trackedBook).title;
    render(
      "showTracked",
      currentTrackedBookDetails({ busy: true, status: "Untracking…" }),
    );
    try {
      await removeBook(/** @type {PopupCandidate} */ (candidate).fileUrl);
      trackedBook = undefined;
      completedAt = null;
      render("showRemoved", { title, message: "This book is no longer tracked." });
    } catch {
      render(
        "showTracked",
        currentTrackedBookDetails({
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

  async function runSwitchBooks() {
    render(
      "showTracked",
      currentTrackedBookDetails({ busy: true, status: "Loading library…" }),
    );
    try {
      const currentTab = await getTab(
        /** @type {PopupCandidate} */ (candidate).tabId,
      );
      libraryTab = captureTabNavigation(
        /** @type {chrome.tabs.Tab & { id: number }} */ (currentTab),
      );
      const library = await loadLibraryBooks();
      render("showLibrary", library);
    } catch {
      render(
        "showTracked",
        currentTrackedBookDetails({
          error: "The library could not be loaded. Try again.",
          status: "Unable to load library",
        }),
      );
    }
  }

  function switchBooks() {
    if (!candidate || !trackedBook || !libraryTab || pending || destroyed) {
      return pending;
    }
    pending = runSwitchBooks().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  /** @param {LibraryBookDetails} book */
  async function runOpenBook(book) {
    render(
      "showLibrary",
      currentLibraryDetails({
        busy: true,
        status: `Opening ${book.title}…`,
      }),
    );
    try {
      if (!(await isFileSchemeAccessAllowed())) {
        render("showFileAccessInstructions", { filename: book.title });
        return;
      }

      const currentTab = await getTab(
        /** @type {CapturedTabNavigation} */ (libraryTab).tabId,
      );
      if (
        !tabMatchesCapturedNavigation(
          currentTab,
          /** @type {CapturedTabNavigation} */ (libraryTab),
        )
      ) {
        throw new Error("the original tab has navigated elsewhere");
      }
      if (!(await isFileSchemeAccessAllowed())) {
        render("showFileAccessInstructions", { filename: book.title });
        return;
      }

      const viewerPath = `viewer.html?file=${encodeURIComponent(book.fileUrl)}`;
      const finalTab = await getTab(
        /** @type {CapturedTabNavigation} */ (libraryTab).tabId,
      );
      if (
        !tabMatchesCapturedNavigation(
          finalTab,
          /** @type {CapturedTabNavigation} */ (libraryTab),
        )
      ) {
        throw new Error("the original tab has navigated elsewhere");
      }
      const openedTab = await updateTab(
        /** @type {CapturedTabNavigation} */ (libraryTab).tabId,
        { url: getRuntimeUrl(viewerPath) },
      );
      if (openedTab === undefined) {
        throw new Error("the tracked book could not be opened in the viewer");
      }
      candidate = {
        fileUrl: book.fileUrl,
        filename: titleFromLocalPdfFilename(book.fileUrl),
        tabId: /** @type {CapturedTabNavigation} */ (libraryTab).tabId,
        persisted: true,
      };
      trackedBook = /** @type {BookRecord} */ (
        libraryBookRecords.get(book.fileUrl)
      );
      completedAt = libraryCompletionRecords.get(book.fileUrl) ?? null;
      needsFileAccessInstructions = false;
      render("showTracked", currentTrackedBookDetails());
    } catch {
      render(
        "showLibrary",
        currentLibraryDetails({
          error: `${book.title} could not be opened. Try again.`,
          status: "Unable to open book",
        }),
      );
    }
  }

  /** @param {string} fileUrl */
  function openBook(fileUrl) {
    const book = [...(libraryBooks ?? []), ...completedLibraryBooks].find(
      (entry) => entry.fileUrl === fileUrl,
    );
    if (!book || pending || destroyed) {
      return pending;
    }
    pending = runOpenBook(book).finally(() => {
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
      const tabs = await queryActiveTab(ACTIVE_TAB_QUERY);
      const [activeTab] = Array.isArray(tabs) ? tabs : [];
      if (Number.isInteger(activeTab?.id)) {
        libraryTab = captureTabNavigation(
          /** @type {chrome.tabs.Tab & { id: number }} */ (activeTab),
        );
      }
      candidate = candidateFromTabs(tabs, getRuntimeUrl);
      if (!candidate) {
        if (!libraryTab) {
          render("showIneligible");
          return;
        }
        const library = await loadLibraryBooks();
        render("showLibrary", library);
        return;
      }

      const [existing, fileAccessAllowed] = await Promise.all([
        getBookWithCompletion(candidate.fileUrl),
        isFileSchemeAccessAllowed(),
      ]);
      if (existing) {
        candidate.persisted = true;
        canActivate = false;
        trackedBook = existing.book;
        completedAt = existing.completedAt;
        needsFileAccessInstructions = !fileAccessAllowed;
        render("showTracked", currentTrackedBookDetails());
        return;
      }

      candidate.persisted = false;
      if (!fileAccessAllowed) {
        render("showFileAccessInstructions", { filename: candidate.filename });
        return;
      }
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
  view.setCompletionHandler?.(changeCompletion);
  view.setOpenBookHandler(openBook);
  view.setRenameHandler(rename);
  view.setSwitchBooksHandler?.(switchBooks);
  view.setUntrackHandler(untrack);
  return Object.freeze({
    activate,
    changeCompletion,
    destroy,
    openBook,
    rename,
    start,
    switchBooks,
    untrack,
  });
}
