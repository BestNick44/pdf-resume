import { createChromeStorageFake } from "./chrome-storage-fake.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function createChromeExtensionFake({
  activeTabId,
  extensionId = "abcdefghijklmnopabcdefghijklmnop",
  storage = {},
  tabs = [],
} = {}) {
  const storageFake = createChromeStorageFake(storage);
  const tabMap = new Map(tabs.map((tab) => [tab.id, structuredClone(tab)]));
  let selectedTabId = activeTabId;
  const failures = new Map();
  const holds = new Map();
  const undefinedResults = new Map();
  const tabOperations = [];

  async function invoke(method, details, operation) {
    tabOperations.push({ method, phase: "start", ...structuredClone(details) });
    await Promise.resolve();
    const hold = holds.get(method)?.shift();
    if (hold && !hold.after) {
      hold.started.resolve();
      await hold.released.promise;
    }
    const failure = failures.get(method)?.shift();
    if (failure) {
      throw failure;
    }
    const returnUndefined = undefinedResults.get(method)?.shift();
    const result = returnUndefined ? undefined : operation();
    if (hold?.after) {
      hold.started.resolve();
      await hold.released.promise;
    }
    tabOperations.push({ method, phase: "finish", ...structuredClone(details) });
    return result === undefined ? undefined : structuredClone(result);
  }

  const chrome = {
    runtime: {
      id: extensionId,
      lastError: undefined,
      getURL(path) {
        return `chrome-extension://${extensionId}/${path}`;
      },
    },
    storage: { local: storageFake.local },
    tabs: {
      query(queryInfo) {
        return invoke("query", { queryInfo }, () => {
          const tab = tabMap.get(selectedTabId);
          return tab ? [tab] : [];
        });
      },
      get(tabId) {
        return invoke("get", { tabId }, () => {
          const tab = tabMap.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          return tab;
        });
      },
      update(tabId, updateProperties) {
        return invoke("update", { tabId, updateProperties }, () => {
          const tab = tabMap.get(tabId);
          if (!tab) {
            throw new Error(`No tab with id: ${tabId}`);
          }
          Object.assign(tab, updateProperties);
          return tab;
        });
      },
    },
  };

  return {
    chrome,
    locks: storageFake.locks,
    storageFake,
    tabOperations,
    closeTab(tabId) {
      tabMap.delete(tabId);
    },
    failNext(method, error = new Error(`tabs.${method} failed`)) {
      const queued = failures.get(method) ?? [];
      queued.push(error);
      failures.set(method, queued);
    },
    holdNext(method, { after = false } = {}) {
      const hold = { after, released: deferred(), started: deferred() };
      const queued = holds.get(method) ?? [];
      queued.push(hold);
      holds.set(method, queued);
      return { started: hold.started.promise, release: hold.released.resolve };
    },
    returnUndefinedNext(method) {
      const queued = undefinedResults.get(method) ?? [];
      queued.push(true);
      undefinedResults.set(method, queued);
    },
    selectTab(tabId) {
      selectedTabId = tabId;
    },
    snapshotTab(tabId) {
      const tab = tabMap.get(tabId);
      return tab && structuredClone(tab);
    },
    setTabUrl(tabId, url) {
      const tab = tabMap.get(tabId);
      if (tab) {
        tab.url = url;
      }
    },
  };
}
