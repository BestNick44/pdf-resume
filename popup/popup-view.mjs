function requireElement(hostDocument, selector) {
  const element = hostDocument.querySelector(selector);
  if (!element) {
    throw new Error(`popup element is missing: ${selector}`);
  }
  return element;
}

export function createPopupView({ hostDocument = globalThis.document } = {}) {
  const main = requireElement(hostDocument, "#popupMain");
  const status = requireElement(hostDocument, "#popupStatus");
  const book = requireElement(hostDocument, "#popupBook");
  const filename = requireElement(hostDocument, "#bookFilename");
  const message = requireElement(hostDocument, "#popupMessage");
  const error = requireElement(hostDocument, "#popupError");
  const action = requireElement(hostDocument, "#trackButton");
  let activationHandler;

  function onActivate() {
    activationHandler?.();
  }

  function reset({ busy = false } = {}) {
    main.setAttribute("aria-busy", String(busy));
    book.hidden = true;
    filename.textContent = "";
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
    filename.textContent = details.filename ?? "";
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

  return Object.freeze({
    destroy() {
      activationHandler = undefined;
      action.removeEventListener("click", onActivate);
    },

    setActivationHandler(handler) {
      activationHandler = handler;
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

    showSuccess(details = {}) {
      reset();
      status.textContent = details.message ?? "Book tracked.";
      showBook(details);
    },

    showTracked(details = {}) {
      reset();
      status.textContent = "Already tracked";
      showBook(details);
      message.textContent = details.message ?? "This book is already tracked.";
      message.hidden = false;
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
