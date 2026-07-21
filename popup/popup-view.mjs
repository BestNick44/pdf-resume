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
  let activationHandler;
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

  action.addEventListener("click", onActivate);
  renameForm.addEventListener("submit", onRename);
  untrackButton.addEventListener("click", onUntrack);

  return Object.freeze({
    destroy() {
      activationHandler = undefined;
      renameHandler = undefined;
      untrackHandler = undefined;
      action.removeEventListener("click", onActivate);
      renameForm.removeEventListener("submit", onRename);
      untrackButton.removeEventListener("click", onUntrack);
    },

    setActivationHandler(handler) {
      activationHandler = handler;
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

    showIneligible() {
      reset();
      status.textContent = "Nothing to track here";
      message.textContent = "Open an untracked local PDF to track it.";
      message.hidden = false;
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
      status.textContent = details.status ?? "Reading progress";
      showBook(details);
      dashboard.hidden = false;
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
      customTitle.value = details.customTitle ?? "";
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
