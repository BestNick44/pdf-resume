import assert from "node:assert/strict";
import test from "node:test";

import { restorePdfJsPosition } from "../viewer/pdfjs-position-restore.mjs";
import { createFakeScheduler } from "./support/fake-scheduler.mjs";

class FakeEventBus {
  listeners = new Map();

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  off(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

async function drainMicrotasks() {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRestoreHarness({
  clientHeight = 600,
  documentPages = 20,
  initialPage = 1,
  initialScrollTop = 0,
  initialViewReady = true,
  pagesReady = Promise.resolve(),
  renderedPages = [],
  scrollHeight = 4_000,
} = {}) {
  const time = createFakeScheduler();
  const eventBus = new FakeEventBus();
  const documentIdentity = { id: "document", numPages: documentPages };
  const pageViews = Array.from({ length: documentPages }, (_, index) => ({
    id: index + 1,
    renderingState: renderedPages.includes(index + 1) ? 3 : 0,
  }));
  let currentPageNumber = initialPage;
  let scrollTop = initialScrollTop;
  const container = {
    clientHeight,
    scrollHeight,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      scrollTop = value;
    },
  };
  const navigation = [];
  const pdfViewer = {
    get currentPageNumber() {
      return currentPageNumber;
    },
    set currentPageNumber(value) {
      navigation.push(value);
      currentPageNumber = value;
      // PDF.js page navigation scrolls to its own page default before the exact
      // canonical container offset can be restored.
      container.scrollTop = (value - 1) * 1_000;
      eventBus.dispatch("pagechanging", { pageNumber: value, source: pdfViewer });
    },
    getPageView(index) {
      return pageViews[index];
    },
    pagesCount: documentPages,
    pagesPromise: pagesReady,
  };
  const application = {
    appConfig: { mainContainer: container },
    eventBus,
    isInitialViewSet: initialViewReady,
    pdfDocument: documentIdentity,
    pdfViewer,
  };
  const baselines = [];
  const starts = [];
  const controller = new AbortController();
  let genuineInteraction = false;

  function start(savedPosition) {
    const promise = restorePdfJsPosition({
      application,
      container,
      documentIdentity,
      eventBus,
      interaction: {
        hasGenuineInteraction: () => genuineInteraction,
      },
      isCurrent: () => application.pdfDocument === documentIdentity,
      renderOutcomes: { outcomeFor: () => undefined },
      savedPosition,
      scheduler: time.scheduler,
      signal: controller.signal,
      startTracking(initialPosition, currentPosition) {
        baselines.push(initialPosition);
        starts.push(currentPosition);
      },
    });
    return promise;
  }

  async function render(pageNumber) {
    pageViews[pageNumber - 1].renderingState = 3;
    eventBus.dispatch("pagerendered", {
      pageNumber,
      source: pageViews[pageNumber - 1],
    });
    await drainMicrotasks();
  }

  async function advanceLayoutTurn() {
    time.advanceBy(16);
    await drainMicrotasks();
  }

  async function finishLayout() {
    await advanceLayoutTurn();
    await advanceLayoutTurn();
    await advanceLayoutTurn();
  }

  return {
    application,
    baselines,
    container,
    controller,
    documentIdentity,
    eventBus,
    advanceLayoutTurn,
    finishLayout,
    interact() {
      genuineInteraction = true;
    },
    navigation,
    render,
    start,
    starts,
    time,
  };
}

test("tracked position restores the exact canonical container offset before tracking starts", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 7, scrollTop: 2_345.5 });
  await drainMicrotasks();

  assert.deepEqual(harness.navigation, [], "PDF.js readiness must precede navigation");
  await harness.advanceLayoutTurn();
  assert.deepEqual(harness.navigation, [7]);
  assert.equal(harness.container.scrollTop, 6_000, "page navigation owns the initial offset");
  assert.deepEqual(harness.starts, [], "tracking must remain disarmed before rendering");

  await harness.render(7);
  assert.equal(harness.container.scrollTop, 6_000, "render alone is not layout readiness");
  await harness.advanceLayoutTurn();
  assert.equal(harness.container.scrollTop, 2_345.5);
  assert.deepEqual(harness.starts, [], "tracking waits for the restored scroll to settle");
  await harness.advanceLayoutTurn();
  await restored;

  assert.deepEqual(harness.starts, [{ currentPage: 7, scrollTop: 2_345.5 }]);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesdestroy"), 0);
});

test("late PDF.js initial-view changes finish before app-owned restore navigation", async () => {
  const pages = deferred();
  const harness = createRestoreHarness({
    initialViewReady: false,
    pagesReady: pages.promise,
  });
  const restored = harness.start({ currentPage: 7, scrollTop: 700 });
  await drainMicrotasks();

  assert.deepEqual(harness.navigation, []);
  harness.application.pdfViewer.currentPageNumber = 2;
  harness.application.isInitialViewSet = true;
  harness.eventBus.dispatch("documentinit", { source: harness.application });
  pages.promise.then(() => {
    harness.application.pdfViewer.currentPageNumber = 3;
  });
  pages.resolve();
  await drainMicrotasks();

  assert.deepEqual(harness.navigation, [2, 3], "restore waits through both initial views");
  await harness.advanceLayoutTurn();
  assert.deepEqual(harness.navigation, [2, 3, 7]);
  await harness.render(7);
  await harness.advanceLayoutTurn();
  await harness.advanceLayoutTurn();
  await restored;
  assert.equal(harness.application.pdfViewer.currentPageNumber, 7);
});

test("pages readiness is bounded for a huge or lazy document", async () => {
  const pages = deferred();
  const harness = createRestoreHarness({ pagesReady: pages.promise });
  const restored = harness.start({ currentPage: 6, scrollTop: 600 });
  await drainMicrotasks();

  harness.time.advanceBy(9_999);
  await drainMicrotasks();
  assert.deepEqual(harness.navigation, []);
  harness.time.advanceBy(1);
  await drainMicrotasks();
  assert.deepEqual(harness.navigation, []);
  await harness.advanceLayoutTurn();
  assert.deepEqual(harness.navigation, [6]);
  await harness.render(6);
  await harness.advanceLayoutTurn();
  await harness.advanceLayoutTurn();
  await restored;
});

test("page-only and scroll-only saved values are both honored", async (t) => {
  await t.test("page with zero offset", async () => {
    const harness = createRestoreHarness();
    const restored = harness.start({ currentPage: 4, scrollTop: 0 });
    await harness.render(4);
    await harness.finishLayout();
    await restored;

    assert.deepEqual(harness.starts, [{ currentPage: 4, scrollTop: 0 }]);
  });

  await t.test("page one with a nonzero offset", async () => {
    const harness = createRestoreHarness();
    const restored = harness.start({ currentPage: 1, scrollTop: 525 });
    await harness.render(1);
    await harness.finishLayout();
    await restored;

    assert.deepEqual(harness.starts, [{ currentPage: 1, scrollTop: 525 }]);
  });
});

test("a persisted stale page clamps only against the loaded document at runtime", async () => {
  const harness = createRestoreHarness({
    clientHeight: 500,
    documentPages: 3,
    scrollHeight: 2_000,
  });
  const savedPosition = {
    currentPage: 18,
    scrollTop: 9_000,
    totalPages: 3,
  };
  const restored = harness.start(savedPosition);
  await harness.render(3);
  await harness.finishLayout();
  await restored;

  assert.deepEqual(harness.navigation, [3]);
  assert.equal(harness.container.scrollTop, 1_500);
  assert.deepEqual(harness.starts, [{ currentPage: 3, scrollTop: 1_500 }]);
  assert.deepEqual(savedPosition, {
    currentPage: 18,
    scrollTop: 9_000,
    totalPages: 3,
  });
});

test("unknown saved totalPages uses the actual loaded document page count", async () => {
  const harness = createRestoreHarness({ documentPages: 5 });
  const restored = harness.start({ currentPage: 5, scrollTop: 300, totalPages: 0 });
  await harness.render(5);
  await harness.finishLayout();
  await restored;

  assert.deepEqual(harness.starts, [{ currentPage: 5, scrollTop: 300 }]);
});

test("a zero viewport safely degrades without applying an offset it cannot honor", async () => {
  const harness = createRestoreHarness({ clientHeight: 0, initialScrollTop: 0 });
  const restored = harness.start({ currentPage: 2, scrollTop: 900 });
  await harness.render(2);
  await harness.finishLayout();
  await restored;

  assert.deepEqual(harness.starts, [{ currentPage: 2, scrollTop: 1_000 }]);
});

test("a genuine interaction before saved scroll application is preserved at handoff", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 4, scrollTop: 1_200 });
  await harness.advanceLayoutTurn();
  await harness.render(4);

  harness.interact();
  harness.application.pdfViewer.currentPageNumber = 5;
  harness.container.scrollTop = 2_050;
  await harness.advanceLayoutTurn();
  await restored;

  assert.equal(harness.container.scrollTop, 2_050, "restore must yield to genuine activity");
  assert.deepEqual(harness.baselines, [{ currentPage: 4, scrollTop: 1_200 }]);
  assert.deepEqual(harness.starts, [{ currentPage: 5, scrollTop: 2_050 }]);
});

test("a handoff-boundary interaction is captured by the tracker exactly once", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 4, scrollTop: 1_200 });
  await harness.advanceLayoutTurn();
  await harness.render(4);
  await harness.advanceLayoutTurn();

  harness.interact();
  harness.application.pdfViewer.currentPageNumber = 5;
  harness.container.scrollTop = 2_050;
  await harness.advanceLayoutTurn();
  await restored;

  assert.deepEqual(harness.baselines, [{ currentPage: 4, scrollTop: 1_200 }]);
  assert.deepEqual(harness.starts, [{ currentPage: 5, scrollTop: 2_050 }]);
});

test("pagerendered must come from the target page and report a successful render", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 8, scrollTop: 800 });
  await drainMicrotasks();
  await harness.advanceLayoutTurn();
  const wrongPageView = harness.application.pdfViewer.getPageView(0);
  harness.eventBus.dispatch("pagerendered", {
    pageNumber: 8,
    source: wrongPageView,
  });
  await drainMicrotasks();
  assert.deepEqual(harness.starts, [], "an unrelated source cannot satisfy readiness");

  const renderError = new Error("canvas render failed");
  harness.eventBus.dispatch("pagerendered", {
    error: renderError,
    pageNumber: 8,
    source: harness.application.pdfViewer.getPageView(7),
  });
  await assert.rejects(restored, (error) => error === renderError);
  assert.deepEqual(harness.starts, []);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
});

test("document replacement cancels readiness waits and removes stale listeners", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 10, scrollTop: 1_000 });
  await drainMicrotasks();
  await harness.advanceLayoutTurn();
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 1);

  harness.application.pdfDocument = { id: "replacement", numPages: 2 };
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  assert.equal(await restored, undefined);
  assert.deepEqual(harness.starts, []);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesdestroy"), 0);
});

test("explicit teardown cancels a pending restore without arming tracking", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 9, scrollTop: 900 });
  await drainMicrotasks();
  harness.controller.abort();

  assert.equal(await restored, undefined);
  assert.deepEqual(harness.starts, []);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  assert.equal(harness.time.pendingCount(), 0);
});
