// @ts-check

import { canonicalizeLocalPdfUrl } from "./shared/local-pdf-url.mjs";
import { createPositionUpdateMessageHandler } from "./shared/position-update-messaging.mjs";
import {
  getBook,
  updatePendingPositionObservation,
  updatePositionObservation,
} from "./storage/books.mjs";

/**
 * @typedef {{
 *   pendingFileUrl: string | undefined,
 *   intentGeneration: number,
 *   drain: Promise<void> | undefined,
 * }} RedirectState
 */

const runtime = globalThis.chrome?.runtime;
const tabs = globalThis.chrome?.tabs;
const onBeforeNavigate = globalThis.chrome?.webNavigation?.onBeforeNavigate;
/** @type {Map<number, RedirectState>} */
const redirectDrainsByTab = new Map();

/**
 * @param {chrome.tabs.Tab} tab
 * @param {string} fileUrl
 */
function tabMatchesNavigation(tab, fileUrl) {
  const candidateUrl = tab.pendingUrl ?? tab.url;
  try {
    return canonicalizeLocalPdfUrl(candidateUrl).href === fileUrl;
  } catch {
    return false;
  }
}

/**
 * @param {number} tabId
 * @param {string} fileUrl
 * @param {RedirectState} state
 * @param {number} intentGeneration
 */
async function redirectTabToTrackedLocalPdf(
  tabId,
  fileUrl,
  state,
  intentGeneration,
) {
  try {
    const book = await getBook(fileUrl);
    if (state.intentGeneration !== intentGeneration || !book) {
      return;
    }

    const tab = await tabs.get(tabId);
    if (state.intentGeneration !== intentGeneration) {
      return;
    }
    if (!tabMatchesNavigation(tab, fileUrl)) {
      return;
    }

    const viewerPath = `viewer.html?file=${encodeURIComponent(fileUrl)}`;
    if (state.intentGeneration !== intentGeneration) {
      return;
    }
    await tabs.update(tabId, { url: runtime.getURL(viewerPath) });
  } catch {
    // A stale tab or unavailable storage should leave the current navigation untouched.
  }
}

/**
 * @param {number} tabId
 * @param {RedirectState} state
 */
async function drainRedirects(tabId, state) {
  try {
    while (state.pendingFileUrl !== undefined) {
      const fileUrl = state.pendingFileUrl;
      const intentGeneration = state.intentGeneration;
      state.pendingFileUrl = undefined;
      await redirectTabToTrackedLocalPdf(
        tabId,
        fileUrl,
        state,
        intentGeneration,
      );
    }
  } finally {
    if (redirectDrainsByTab.get(tabId) === state) {
      redirectDrainsByTab.delete(tabId);
    }
  }
}

/**
 * @param {number} tabId
 * @param {string} fileUrl
 * @returns {Promise<void>}
 */
function queueRedirect(tabId, fileUrl) {
  // Equal-timestamp callbacks can represent distinct navigations, so preserve
  // one follow-up even when its canonical URL matches the active attempt.
  const activeState = redirectDrainsByTab.get(tabId);
  if (activeState) {
    activeState.intentGeneration += 1;
    activeState.pendingFileUrl = fileUrl;
    return /** @type {Promise<void>} */ (activeState.drain);
  }

  /** @type {RedirectState} */
  const state = {
    pendingFileUrl: fileUrl,
    intentGeneration: 1,
    drain: undefined,
  };
  redirectDrainsByTab.set(tabId, state);
  state.drain = drainRedirects(tabId, state);
  return state.drain;
}

/** @param {chrome.webNavigation.WebNavigationBaseCallbackDetails} details */
function redirectTrackedLocalPdf(details) {
  if (details.frameId !== 0 || !Number.isInteger(details.tabId)) {
    return;
  }

  let fileUrl;
  try {
    fileUrl = canonicalizeLocalPdfUrl(details.url).href;
  } catch {
    return;
  }

  return queueRedirect(details.tabId, fileUrl);
}

if (runtime?.onMessage?.addListener && runtime.id) {
  runtime.onMessage.addListener(
    createPositionUpdateMessageHandler({
      extensionId: runtime.id,
      updatePendingPositionObservation,
      updatePositionObservation,
    }),
  );
}

if (
  runtime?.id &&
  /** @type {unknown} */ (tabs?.get) &&
  /** @type {unknown} */ (tabs?.update) &&
  onBeforeNavigate?.addListener
) {
  onBeforeNavigate.addListener(redirectTrackedLocalPdf, {
    url: [{ schemes: ["file"] }],
  });
}
