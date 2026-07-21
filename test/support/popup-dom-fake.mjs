const POPUP_SELECTORS = Object.freeze([
  "#popupMain",
  "#popupStatus",
  "#popupBook",
  "#bookFilename",
  "#popupMessage",
  "#popupError",
  "#trackButton",
  "#trackedDashboard",
  "#pageSummary",
  "#pagesRemaining",
  "#progressBar",
  "#progressPercent",
  "#renameForm",
  "#customTitle",
  "#renameButton",
  "#untrackButton",
]);

class FakePopupElement {
  constructor() {
    this.attributes = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.max = 0;
    this.textContent = "";
    this.value = "";
  }

  set innerHTML(_value) {
    throw new Error("popup rendering must not use HTML parsing");
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  click() {
    if (!this.disabled && !this.hidden) {
      this.listeners.get("click")?.({ type: "click" });
    }
  }

  submit() {
    let prevented = false;
    this.listeners.get("submit")?.({
      preventDefault() {
        prevented = true;
      },
      type: "submit",
    });
    return prevented;
  }
}

export function createPopupDocumentFake() {
  const elements = Object.fromEntries(
    POPUP_SELECTORS.map((selector) => [selector, new FakePopupElement()]),
  );
  return {
    elements,
    hostDocument: { querySelector: (selector) => elements[selector] },
  };
}
