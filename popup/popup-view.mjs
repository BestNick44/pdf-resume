// @ts-check

/** @typedef {{ title?: string, filename?: string }} BookDisplayDetails */
/** @typedef {{ fileUrl: string, title: string, currentPage: number, totalPages: number, progressPercent: number | null }} LibraryBookDetails */
/** @typedef {{ books?: LibraryBookDetails[], busy?: boolean, error?: string, status?: string }} LibraryDetails */
/** @typedef {{ actionLabel?: string, filename?: string, message?: string, persisted?: boolean }} ErrorDetails */
/** @typedef {{ filename?: string, message?: string, title?: string }} MessageDetails */
/** @typedef {{ actionLabel?: string, filename?: string }} UntrackedDetails */
/** @typedef {{ busy?: boolean, customTitle?: string | null, customTitleDraft?: string, currentPage?: number, error?: string, fileAccessRequired?: boolean, pagesRemaining?: number | null, progressPercent?: number | null, status?: string, title?: string, totalPages?: number }} TrackedDetails */
/** @typedef {() => void | Promise<void> | undefined} ActivationHandler */
/** @typedef {(fileUrl: string) => void | Promise<void> | undefined} OpenBookHandler */
/** @typedef {(customTitle: string) => void | Promise<void> | undefined} RenameHandler */
/** @typedef {() => void | Promise<void> | undefined} UntrackHandler */

/**
 * @param {Document} hostDocument
 * @param {string} selector
 * @returns {Element}
 */
function requireElement(hostDocument, selector) {
  const element = hostDocument.querySelector(selector);
  if (!element) {
    throw new Error(`popup element is missing: ${selector}`);
  }
  return element;
}

/** @param {number} pagesRemaining */
function remainingLabel(pagesRemaining) {
  return `${pagesRemaining} ${pagesRemaining === 1 ? "page" : "pages"} remaining`;
}

/** @param {{ hostDocument?: Document }} [dependencies] */
export function createPopupView({ hostDocument = globalThis.document } = {}) {
  const main = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupMain")
  );
  const status = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupStatus")
  );
  const fileAccessInstructions = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#fileAccessInstructions")
  );
  const book = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupBook")
  );
  const filename = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#bookFilename")
  );
  const message = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupMessage")
  );
  const error = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupError")
  );
  const action = /** @type {HTMLButtonElement} */ (
    requireElement(hostDocument, "#trackButton")
  );
  const dashboard = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#trackedDashboard")
  );
  const pageSummary = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#pageSummary")
  );
  const pagesRemaining = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#pagesRemaining")
  );
  const progress = /** @type {HTMLProgressElement} */ (
    requireElement(hostDocument, "#progressBar")
  );
  const progressPercent = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#progressPercent")
  );
  const renameForm = /** @type {HTMLFormElement} */ (
    requireElement(hostDocument, "#renameForm")
  );
  const customTitle = /** @type {HTMLInputElement} */ (
    requireElement(hostDocument, "#customTitle")
  );
  const renameButton = /** @type {HTMLButtonElement} */ (
    requireElement(hostDocument, "#renameButton")
  );
  const untrackButton = /** @type {HTMLButtonElement} */ (
    requireElement(hostDocument, "#untrackButton")
  );
  const library = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#popupLibrary")
  );
  const libraryList = /** @type {HTMLElement} */ (
    requireElement(hostDocument, "#libraryList")
  );
  /** @type {ActivationHandler | undefined} */
  let activationHandler;
  /** @type {OpenBookHandler | undefined} */
  let openBookHandler;
  /** @type {RenameHandler | undefined} */
  let renameHandler;
  /** @type {UntrackHandler | undefined} */
  let untrackHandler;

  function onActivate() {
    activationHandler?.();
  }

  /** @param {SubmitEvent} event */
  function onRename(event) {
    event.preventDefault();
    renameHandler?.(customTitle.value);
  }

  function onUntrack() {
    untrackHandler?.();
  }

  /** @param {{ busy?: boolean }} [state] */
  function reset({ busy = false } = {}) {
    main.setAttribute("aria-busy", String(busy));
    fileAccessInstructions.hidden = true;
    book.hidden = true;
    filename.textContent = "";
    dashboard.hidden = true;
    pageSummary.textContent = "";
    pagesRemaining.textContent = "";
    progress.hidden = false;
    progress.max = 100;
    progress.value = 0;
    progressPercent.textContent = "";
    customTitle.value = "";
    customTitle.disabled = busy;
    renameButton.disabled = busy;
    untrackButton.disabled = busy;
    library.hidden = true;
    libraryList.replaceChildren();
    message.hidden = true;
    message.textContent = "";
    error.hidden = true;
    error.textContent = "";
    action.hidden = true;
    action.disabled = busy;
    action.textContent = "";
  }

  /** @param {BookDisplayDetails} [details] */
  function showBook(details = {}) {
    book.hidden = false;
    filename.textContent = details.title ?? details.filename ?? "";
  }

  /** @param {string | undefined} label */
  function showAction(label) {
    if (!label) {
      return;
    }
    action.textContent = label;
    action.disabled = false;
    action.hidden = false;
  }

  /**
   * @param {LibraryBookDetails} details
   * @param {boolean | undefined} busy
   * @param {number} index
   */
  function createLibraryBook(details, busy, index) {
    const item = hostDocument.createElement("li");
    const button = hostDocument.createElement("button");
    const title = hostDocument.createElement("span");
    const summary = hostDocument.createElement("span");
    const progressRow = hostDocument.createElement("span");
    const progress = hostDocument.createElement("progress");
    const progressLabel = hostDocument.createElement("span");
    const progressLabelId = `library-progress-${index}`;
    const summaryText = `Page ${details.currentPage} of ${
      details.totalPages > 0 ? details.totalPages : "—"
    }`;

    item.className = "library-book";
    button.className = "library-book-button";
    button.type = "button";
    button.disabled = /** @type {boolean} */ (busy);
    button.setAttribute("aria-label", `Open ${details.title}, ${summaryText}`);
    button.addEventListener("click", () => openBookHandler?.(details.fileUrl));
    title.className = "library-book-title";
    title.textContent = details.title;
    summary.className = "library-book-summary";
    summary.textContent = summaryText;
    progressRow.className = "progress-row";
    progress.max = 100;
    progress.setAttribute("aria-label", `Reading progress for ${details.title}`);
    progressLabel.setAttribute("id", progressLabelId);
    if (details.progressPercent === null) {
      progress.hidden = true;
      progressLabel.textContent = "Progress unavailable";
      progressLabel.setAttribute(
        "aria-label",
        `Reading progress for ${details.title}: unavailable`,
      );
      button.setAttribute("aria-describedby", progressLabelId);
    } else {
      progress.value = details.progressPercent;
      progress.setAttribute("aria-describedby", progressLabelId);
      progressLabel.textContent = `${details.progressPercent}%`;
    }

    progressRow.append(progress, progressLabel);
    button.append(title, summary);
    item.append(button, progressRow);
    return item;
  }

  action.addEventListener("click", onActivate);
  renameForm.addEventListener("submit", onRename);
  untrackButton.addEventListener("click", onUntrack);

  return Object.freeze({
    destroy() {
      activationHandler = undefined;
      openBookHandler = undefined;
      renameHandler = undefined;
      untrackHandler = undefined;
      action.removeEventListener("click", onActivate);
      renameForm.removeEventListener("submit", onRename);
      untrackButton.removeEventListener("click", onUntrack);
    },

    /** @param {ActivationHandler} handler */
    setActivationHandler(handler) {
      activationHandler = handler;
    },

    /** @param {OpenBookHandler} handler */
    setOpenBookHandler(handler) {
      openBookHandler = handler;
    },

    /** @param {RenameHandler} handler */
    setRenameHandler(handler) {
      renameHandler = handler;
    },

    /** @param {UntrackHandler} handler */
    setUntrackHandler(handler) {
      untrackHandler = handler;
    },

    /** @param {ErrorDetails} [details] */
    showError(details = {}) {
      reset();
      status.textContent = details.persisted ? "Tracked book needs attention" : "Unable to track";
      if (details.filename) {
        showBook(details);
      }
      error.textContent = details.message ?? "The popup encountered an error.";
      error.hidden = false;
      showAction(details.actionLabel);
    },

    /** @param {BookDisplayDetails} [details] */
    showFileAccessInstructions(details = {}) {
      reset();
      status.textContent = "File access required";
      showBook(details);
      fileAccessInstructions.hidden = false;
    },

    showIneligible() {
      reset();
      status.textContent = "Nothing to track here";
      message.textContent = "Open an untracked local PDF to track it.";
      message.hidden = false;
    },

    /** @param {LibraryDetails} [details] */
    showLibrary(details = {}) {
      const books = details.books ?? [];
      reset({ busy: details.busy });
      status.textContent = details.status ?? "Your library";
      library.hidden = false;
      libraryList.replaceChildren(
        ...books.map((bookDetails, index) =>
          createLibraryBook(bookDetails, details.busy, index),
        ),
      );
      if (books.length === 0) {
        message.textContent = "No tracked books yet. Open a local PDF to add one.";
        message.hidden = false;
      }
      if (details.error) {
        error.textContent = details.error;
        error.hidden = false;
      }
    },

    showLoading() {
      reset({ busy: true });
      status.textContent = "Checking the active tab…";
    },

    /** @param {MessageDetails} [details] */
    showPending(details = {}) {
      reset({ busy: true });
      status.textContent = details.message ?? "Working…";
      showBook(details);
    },

    /** @param {MessageDetails} [details] */
    showRemoved(details = {}) {
      reset();
      status.textContent = "Book untracked";
      showBook(details);
      message.textContent = details.message ?? "This book is no longer tracked.";
      message.hidden = false;
    },

    /** @param {MessageDetails} [details] */
    showSuccess(details = {}) {
      reset();
      status.textContent = details.message ?? "Book tracked.";
      showBook(details);
    },

    /** @param {TrackedDetails} [details] */
    showTracked(details = {}) {
      reset({ busy: details.busy });
      status.textContent =
        details.status ?? (details.fileAccessRequired ? "File access required" : "Reading progress");
      showBook(details);
      dashboard.hidden = false;
      fileAccessInstructions.hidden = !details.fileAccessRequired;
      pageSummary.textContent = `Page ${details.currentPage} of ${
        /** @type {number} */ (details.totalPages) > 0 ? details.totalPages : "—"
      }`;
      if (/** @type {number} */ (details.totalPages) > 0) {
        pagesRemaining.textContent = remainingLabel(
          /** @type {number} */ (details.pagesRemaining),
        );
        progress.value = /** @type {number} */ (details.progressPercent);
        progressPercent.textContent = `${details.progressPercent}%`;
      } else {
        pagesRemaining.textContent = "Page count unavailable";
        progress.hidden = true;
        progressPercent.textContent = "Progress unavailable";
      }
      customTitle.value = details.customTitleDraft ?? details.customTitle ?? "";
      if (details.error) {
        error.textContent = details.error;
        error.hidden = false;
      }
    },

    /** @param {UntrackedDetails} [details] */
    showUntracked(details = {}) {
      reset();
      status.textContent = "Local PDF found";
      showBook(details);
      message.textContent = "Track this PDF to remember your reading position.";
      message.hidden = false;
      showAction(details.actionLabel);
    },
  });
}
