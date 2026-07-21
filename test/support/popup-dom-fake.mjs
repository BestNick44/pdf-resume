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
  "#popupLibrary",
  "#libraryList",
]);

class FakePopupElement {
  constructor(tagName = "div") {
    this.attributes = {};
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.max = 0;
    this.tagName = tagName.toUpperCase();
    this.textContent = "";
    this.type = "";
    this.value = "";
  }

  set innerHTML(_value) {
    throw new Error("popup rendering must not use HTML parsing");
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append(...children) {
    this.children.push(...children);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  replaceChildren(...children) {
    this.children = [...children];
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
    hostDocument: {
      createElement: (tagName) => new FakePopupElement(tagName),
      querySelector: (selector) => elements[selector],
    },
  };
}
