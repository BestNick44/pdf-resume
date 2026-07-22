import assert from "node:assert/strict";
import test from "node:test";

import { createChromeExtensionFake } from "./support/chrome-extension-fake.mjs";

const BOOK_URL = "file:///Users/reader/Books/A%20Book.pdf";
const OTHER_BOOK_URL = "file:///Users/reader/Books/Other.pdf";
const LATEST_BOOK_URL = "file:///Users/reader/Books/Latest.pdf";
const UNRELATED_URL = "file:///Users/reader/Books/Untracked.pdf";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const TAB_ID = 7;
const TIME_STAMP = 1_800_000_000_000;
const VIEWER_URL = `${EXTENSION_ORIGIN}/viewer.html?file=${encodeURIComponent(BOOK_URL)}`;

function viewerUrl(fileUrl) {
  return `${EXTENSION_ORIGIN}/viewer.html?file=${encodeURIComponent(fileUrl)}`;
}

function navigationDetails(overrides = {}) {
  return {
    frameId: 0,
    tabId: TAB_ID,
    timeStamp: TIME_STAMP,
    url: BOOK_URL,
    ...overrides,
  };
}

function canonicalRecord() {
  return {
    title: "A Book",
    customTitle: null,
    totalPages: 100,
    currentPage: 25,
    scrollTop: 400,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_001,
  };
}

function createNavigationEvent() {
  const registrations = [];
  return {
    registrations,
    addListener(listener, filter) {
      registrations.push({ listener, filter });
    },
    async emit(details) {
      await Promise.all(registrations.map(({ listener }) => listener(details)));
    },
  };
}

let backgroundImportNumber = 0;

async function withLoadedBackground(fake, run) {
  const onBeforeNavigate = createNavigationEvent();
  fake.chrome.webNavigation = { onBeforeNavigate };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = fake.chrome;

  try {
    backgroundImportNumber += 1;
    await import(`../background.js?auto-redirect-test=${backgroundImportNumber}`);
    return await run(onBeforeNavigate);
  } finally {
    globalThis.chrome = previousChrome;
  }
}

function startedTabUpdates(fake) {
  return fake.tabOperations.filter(
    (operation) => operation.method === "update" && operation.phase === "start",
  );
}

function finishedTabUpdates(fake) {
  return fake.tabOperations.filter(
    (operation) => operation.method === "update" && operation.phase === "finish",
  );
}

function startedStorageReads(fake) {
  return fake.storageFake.operations.filter(
    (operation) => operation.method === "get" && operation.phase === "start",
  );
}

function startedTabReads(fake) {
  return fake.tabOperations.filter(
    (operation) => operation.method === "get" && operation.phase === "start",
  );
}

async function waitForStartedTabUpdates(fake, expectedCount) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (startedTabUpdates(fake).length === expectedCount) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(startedTabUpdates(fake).length, expectedCount);
}

test("service worker redirects a tracked top-level local PDF navigation to the tracking viewer", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const update = fake.holdNext("update", { after: true });

    assert.equal(onBeforeNavigate.registrations.length, 1);
    const navigation = onBeforeNavigate.emit(navigationDetails());
    await update.started;
    fake.setTabPendingUrl(TAB_ID, undefined);
    update.release();
    await navigation;

    assert.deepEqual(startedTabUpdates(fake), [
      {
        method: "update",
        phase: "start",
        tabId: TAB_ID,
        updateProperties: { url: VIEWER_URL },
      },
    ]);
    assert.equal(fake.snapshotTab(TAB_ID).url, VIEWER_URL);
    assert.equal(fake.snapshotTab(TAB_ID).pendingUrl, undefined);
  });
});

test("service worker bounds duplicate callback work while a redirect is active", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const update = fake.holdNext("update", { after: true });
    const details = navigationDetails();
    const firstNavigation = onBeforeNavigate.emit({ ...details });
    await update.started;

    const duplicateCallbacks = Array.from({ length: 1_000 }, () =>
      onBeforeNavigate.emit({ ...details }),
    );
    fake.setTabPendingUrl(TAB_ID, undefined);
    update.release();
    await Promise.all([firstNavigation, ...duplicateCallbacks]);

    assert.equal(startedStorageReads(fake).length, 2);
    assert.equal(startedTabReads(fake).length, 2);
    assert.equal(startedTabUpdates(fake).length, 1);
    assert.equal(finishedTabUpdates(fake).length, 1);
    assert.equal(fake.snapshotTab(TAB_ID).url, VIEWER_URL);
  });
});

test("service worker redirects a distinct later same-file navigation with the same timestamp", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const firstUpdate = fake.holdNext("update", { after: true });
    const secondUpdate = fake.holdNext("update", { after: true });
    const details = navigationDetails();
    const firstNavigation = onBeforeNavigate.emit({ ...details });
    await firstUpdate.started;

    const secondNavigation = onBeforeNavigate.emit({ ...details });
    fake.setTabPendingUrl(TAB_ID, BOOK_URL);
    firstUpdate.release();
    await waitForStartedTabUpdates(fake, 2);

    fake.setTabPendingUrl(TAB_ID, undefined);
    secondUpdate.release();
    await Promise.all([firstNavigation, secondNavigation]);

    assert.equal(startedStorageReads(fake).length, 2);
    assert.equal(startedTabReads(fake).length, 2);
    assert.equal(startedTabUpdates(fake).length, 2);
    assert.equal(finishedTabUpdates(fake).length, 2);
    assert.equal(fake.snapshotTab(TAB_ID).url, VIEWER_URL);
    assert.equal(fake.snapshotTab(TAB_ID).pendingUrl, undefined);
  });
});

test("service worker coalesces pending different files to the latest navigation intent", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: {
      books: {
        [BOOK_URL]: canonicalRecord(),
        [OTHER_BOOK_URL]: canonicalRecord(),
        [LATEST_BOOK_URL]: canonicalRecord(),
      },
    },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const firstUpdate = fake.holdNext("update", { after: true });
    const firstNavigation = onBeforeNavigate.emit(navigationDetails());
    await firstUpdate.started;

    const supersededNavigation = onBeforeNavigate.emit(
      navigationDetails({ url: OTHER_BOOK_URL }),
    );
    const latestNavigation = onBeforeNavigate.emit(
      navigationDetails({ url: LATEST_BOOK_URL }),
    );
    fake.setTabPendingUrl(TAB_ID, LATEST_BOOK_URL);
    firstUpdate.release();
    await Promise.all([firstNavigation, supersededNavigation, latestNavigation]);

    assert.equal(startedStorageReads(fake).length, 2);
    assert.equal(startedTabReads(fake).length, 2);
    assert.deepEqual(
      startedTabUpdates(fake).map((operation) => operation.updateProperties.url),
      [VIEWER_URL, viewerUrl(LATEST_BOOK_URL)],
    );
    assert.equal(fake.snapshotTab(TAB_ID).url, viewerUrl(LATEST_BOOK_URL));
  });
});

test("service worker abandons a stale tab snapshot when a newer intent arrives", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: {
      books: {
        [BOOK_URL]: canonicalRecord(),
        [OTHER_BOOK_URL]: canonicalRecord(),
      },
    },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const staleRead = fake.holdNext("get", { after: true });
    const firstNavigation = onBeforeNavigate.emit(navigationDetails());
    await staleRead.started;

    fake.setTabPendingUrl(TAB_ID, OTHER_BOOK_URL);
    const newerCallbacks = Array.from({ length: 1_000 }, () =>
      onBeforeNavigate.emit(navigationDetails({ url: OTHER_BOOK_URL })),
    );
    staleRead.release();
    await Promise.all([firstNavigation, ...newerCallbacks]);

    assert.equal(startedStorageReads(fake).length, 2);
    assert.equal(startedTabReads(fake).length, 2);
    assert.deepEqual(
      startedTabUpdates(fake).map((operation) => operation.updateProperties.url),
      [viewerUrl(OTHER_BOOK_URL)],
    );
    assert.equal(fake.snapshotTab(TAB_ID).url, viewerUrl(OTHER_BOOK_URL));
  });
});

test("service worker does not let a pending intent overwrite unrelated live navigation", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: {
      books: {
        [BOOK_URL]: canonicalRecord(),
        [OTHER_BOOK_URL]: canonicalRecord(),
      },
    },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const firstUpdate = fake.holdNext("update", { after: true });
    const firstNavigation = onBeforeNavigate.emit(navigationDetails());
    await firstUpdate.started;

    const pendingNavigation = onBeforeNavigate.emit(
      navigationDetails({ url: OTHER_BOOK_URL }),
    );
    fake.setTabPendingUrl(TAB_ID, UNRELATED_URL);
    firstUpdate.release();
    await Promise.all([firstNavigation, pendingNavigation]);

    assert.equal(startedStorageReads(fake).length, 2);
    assert.equal(startedTabReads(fake).length, 2);
    assert.equal(startedTabUpdates(fake).length, 1);
    assert.equal(fake.snapshotTab(TAB_ID).pendingUrl, UNRELATED_URL);
  });
});

test("service worker ignores invalid and subframe navigation events", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    await Promise.all([
      onBeforeNavigate.emit(navigationDetails({ frameId: 1 })),
      onBeforeNavigate.emit(navigationDetails({ url: "file:///not-a-pdf.txt" })),
      onBeforeNavigate.emit(navigationDetails({ tabId: "7" })),
    ]);

    assert.deepEqual(startedTabUpdates(fake), []);
  });
});

test("service worker leaves an untracked local PDF navigation untouched", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    tabs: [{ id: TAB_ID, url: UNRELATED_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    await onBeforeNavigate.emit(navigationDetails({ url: UNRELATED_URL }));

    assert.deepEqual(startedTabUpdates(fake), []);
    assert.equal(fake.snapshotTab(TAB_ID).url, UNRELATED_URL);
  });
});

test("service worker does not overwrite a newer navigation after an asynchronous lookup", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const heldLookup = fake.storageFake.holdNext("get");

    const navigation = onBeforeNavigate.emit(navigationDetails());
    await heldLookup.started;
    fake.setTabPendingUrl(TAB_ID, UNRELATED_URL);
    heldLookup.release();
    await navigation;

    assert.deepEqual(startedTabUpdates(fake), []);
    assert.equal(fake.snapshotTab(TAB_ID).pendingUrl, UNRELATED_URL);
  });
});

test("service worker cleans failed redirect state so the same tab can retry", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    fake.storageFake.failNext("get");
    await onBeforeNavigate.emit(navigationDetails());

    fake.failNext("get");
    await onBeforeNavigate.emit(navigationDetails());

    fake.failNext("update");
    await onBeforeNavigate.emit(navigationDetails());

    const retryUpdate = fake.holdNext("update", { after: true });
    const retry = onBeforeNavigate.emit(navigationDetails());
    await retryUpdate.started;
    fake.setTabPendingUrl(TAB_ID, undefined);
    retryUpdate.release();
    await retry;

    assert.equal(startedTabUpdates(fake).length, 2);
    assert.equal(finishedTabUpdates(fake).length, 1);
    assert.equal(fake.snapshotTab(TAB_ID).url, VIEWER_URL);
  });
});

test("service worker settles callbacks and releases state for a closed tab", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    fake.closeTab(TAB_ID);

    await onBeforeNavigate.emit(navigationDetails());
    await onBeforeNavigate.emit(navigationDetails());

    assert.equal(startedTabReads(fake).length, 2);
    assert.deepEqual(startedTabUpdates(fake), []);
    assert.equal(fake.snapshotTab(TAB_ID), undefined);
  });
});
