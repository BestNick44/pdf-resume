import assert from "node:assert/strict";
import test from "node:test";

import { createChromeExtensionFake } from "./support/chrome-extension-fake.mjs";

const BOOK_URL = "file:///Users/reader/Books/A%20Book.pdf";
const TAB_ID = 7;

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

test("service worker redirects a tracked top-level local PDF navigation to the tracking viewer", async () => {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    assert.equal(onBeforeNavigate.registrations.length, 1);
    await onBeforeNavigate.emit({ frameId: 0, tabId: TAB_ID, url: BOOK_URL });

    assert.deepEqual(startedTabUpdates(fake), [
      {
        method: "update",
        phase: "start",
        tabId: TAB_ID,
        updateProperties: {
          url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?file=file%3A%2F%2F%2FUsers%2Freader%2FBooks%2FA%2520Book.pdf",
        },
      },
    ]);
  });
});

test("service worker leaves an untracked local PDF navigation untouched", async () => {
  const untrackedUrl = "file:///Users/reader/Books/Untracked.pdf";
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    tabs: [{ id: TAB_ID, url: untrackedUrl }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    await onBeforeNavigate.emit({ frameId: 0, tabId: TAB_ID, url: untrackedUrl });

    assert.deepEqual(startedTabUpdates(fake), []);
    assert.equal(fake.snapshotTab(TAB_ID).url, untrackedUrl);
  });
});

test("service worker does not overwrite a newer navigation after an asynchronous lookup", async () => {
  const newerUrl = "file:///Users/reader/Books/Untracked.pdf";
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: canonicalRecord() } },
    tabs: [{ id: TAB_ID, url: "chrome://newtab/", pendingUrl: BOOK_URL }],
  });
  await withLoadedBackground(fake, async (onBeforeNavigate) => {
    const heldLookup = fake.storageFake.holdNext("get");

    const navigation = onBeforeNavigate.emit({
      frameId: 0,
      tabId: TAB_ID,
      url: BOOK_URL,
    });
    await heldLookup.started;
    fake.setTabPendingUrl(TAB_ID, newerUrl);
    heldLookup.release();
    await navigation;

    assert.deepEqual(startedTabUpdates(fake), []);
    assert.equal(fake.snapshotTab(TAB_ID).pendingUrl, newerUrl);
  });
});
