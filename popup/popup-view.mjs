function requireElement(hostDocument, selector) {
  const element = hostDocument.querySelector(selector);
  if (!element) {
    throw new Error(`popup element is missing: ${selector}`);
  }
  return element;
}

function remainingLabel(pagesRemaining) {
  return `${pagesRemaining} ${pagesRemaining === 1 ? "page" : "pages"} remaining`;
}

export function createPopupView({ hostDocument = globalThis.document } = {}) {
  const main = requireElement(hostDocument, "#popupMain");
  const status = requireElement(hostDocument, "#popupStatus");
  const fileAccessInstructions = requireElement(hostDocument, "#fileAccessInstructions");
  const book = requireElement(hostDocument, "#popupBook");
  const filename = requireElement(hostDocument, "#bookFilename");
  const message = requireElement(hostDocument, "#popupMessage");
  const error = requireElement(hostDocument, "#popupError");
  const action = requireElement(hostDocument, "#trackButton");
  const dashboard = requireElement(hostDocument, "#trackedDashboard");
  const pageSummary = requireElement(hostDocument, "#pageSummary");
  const pagesRemaining = requireElement(hostDocument, "#pagesRemaining");
  const progress = requireElement(hostDocument, "#progressBar");
  const progressPercent = requireElement(hostDocument, "#progressPercent");
  const renameForm = requireElement(hostDocument, "#renameForm");
  const customTitle = requireElement(hostDocument, "#customTitle");
  const renameButton = requireElement(hostDocument, "#renameButton");
  const untrackButton = requireElement(hostDocument, "#untrackButton");
  const library = requireElement(hostDocument, "#popupLibrary");
  const libraryList = requireElement(hostDocument, "#libraryList");
  let activationHandler;
  let openBookHandler;
  let renameHandler;
  let untrackHandler;

  function onActivate() {
    activationHandler?.();
  }

  function onRename(event) {
    event.preventDefault();
    renameHandler?.(customTitle.value);
  }

  function onUntrack() {
    untrackHandler?.();
  }

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

  function showBook(details = {}) {
    book.hidden = false;
    filename.textContent = details.title ?? details.filename ?? "";
  }

  function showAction(label) {
    if (!label) {
      return;
    }
    action.textContent = label;
    action.disabled = false;
    action.hidden = false;
  }

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
    button.disabled = busy;
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

    setActivationHandler(handler) {
      activationHandler = handler;
    },

    setOpenBookHandler(handler) {
      openBookHandler = handler;
    },

    setRenameHandler(handler) {
      renameHandler = handler;
    },

    setUntrackHandler(handler) {
      untrackHandler = handler;
    },

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

    showPending(details = {}) {
      reset({ busy: true });
      status.textContent = details.message ?? "Working…";
      showBook(details);
    },

    showRemoved(details = {}) {
      reset();
      status.textContent = "Book untracked";
      showBook(details);
      message.textContent = details.message ?? "This book is no longer tracked.";
      message.hidden = false;
    },

    showSuccess(details = {}) {
      reset();
      status.textContent = details.message ?? "Book tracked.";
      showBook(details);
    },

    showTracked(details = {}) {
      reset({ busy: details.busy });
      status.textContent =
        details.status ?? (details.fileAccessRequired ? "File access required" : "Reading progress");
      showBook(details);
      dashboard.hidden = false;
      fileAccessInstructions.hidden = !details.fileAccessRequired;
      pageSummary.textContent = `Page ${details.currentPage} of ${
        details.totalPages > 0 ? details.totalPages : "—"
      }`;
      if (details.totalPages > 0) {
        pagesRemaining.textContent = remainingLabel(details.pagesRemaining);
        progress.value = details.progressPercent;
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
