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

function createRestoreHarness({
  clientHeight = 600,
  documentPages = 20,
  initialPage = 1,
  initialScrollTop = 0,
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
  };
  const application = {
    appConfig: { mainContainer: container },
    eventBus,
    pdfDocument: documentIdentity,
    pdfViewer,
  };
  const baselines = [];
  const starts = [];
  const controller = new AbortController();

  function start(savedPosition) {
    const promise = restorePdfJsPosition({
      application,
      container,
      documentIdentity,
      eventBus,
      isCurrent: () => application.pdfDocument === documentIdentity,
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

  async function finishLayout() {
    time.advanceBy(16);
    await drainMicrotasks();
    time.advanceBy(16);
    await drainMicrotasks();
  }

  return {
    application,
    baselines,
    container,
    controller,
    documentIdentity,
    eventBus,
    finishLayout,
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

  assert.deepEqual(harness.navigation, [7]);
  assert.equal(harness.container.scrollTop, 6_000, "page navigation owns the initial offset");
  assert.deepEqual(harness.starts, [], "tracking must remain disarmed before rendering");

  await harness.render(7);
  assert.equal(harness.container.scrollTop, 6_000, "render alone is not layout readiness");
  harness.time.advanceBy(16);
  await drainMicrotasks();
  assert.equal(harness.container.scrollTop, 2_345.5);
  assert.deepEqual(harness.starts, [], "tracking waits for the restored scroll to settle");
  harness.time.advanceBy(16);
  await restored;

  assert.deepEqual(harness.starts, [{ currentPage: 7, scrollTop: 2_345.5 }]);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesdestroy"), 0);
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

test("saved bounds clamp against the loaded replacement document and current viewport", async () => {
  const harness = createRestoreHarness({
    clientHeight: 500,
    documentPages: 3,
    scrollHeight: 2_000,
  });
  const restored = harness.start({
    currentPage: 18,
    scrollTop: 9_000,
    totalPages: 20,
  });
  await harness.render(3);
  await harness.finishLayout();
  await restored;

  assert.deepEqual(harness.navigation, [3]);
  assert.equal(harness.container.scrollTop, 1_500);
  assert.deepEqual(harness.starts, [{ currentPage: 3, scrollTop: 1_500 }]);
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

test("an immediate handoff-boundary interaction becomes the tracking baseline", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 4, scrollTop: 1_200 });
  await harness.render(4);
  harness.time.advanceBy(16);
  await drainMicrotasks();

  harness.application.pdfViewer.currentPageNumber = 5;
  harness.container.scrollTop = 2_050;
  harness.time.advanceBy(16);
  await restored;

  assert.deepEqual(harness.baselines, [{ currentPage: 4, scrollTop: 1_200 }]);
  assert.deepEqual(harness.starts, [{ currentPage: 5, scrollTop: 2_050 }]);
});

test("document replacement cancels readiness waits and removes stale listeners", async () => {
  const harness = createRestoreHarness();
  const restored = harness.start({ currentPage: 10, scrollTop: 1_000 });
  await drainMicrotasks();
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
