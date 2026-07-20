import assert from "node:assert/strict";
import test from "node:test";

import { waitForPdfJsInitialization } from "../viewer/pdfjs-initialization.mjs";
import { createFakeScheduler } from "./support/fake-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function waitFor(initializedPromise, time, signal) {
  return waitForPdfJsInitialization({
    initializedPromise,
    scheduler: time.scheduler,
    signal,
    timeoutErrorMessage: "PDF.js test initialization timed out.",
  });
}

test("PDF.js initialization wait resolves and clears its timeout", async () => {
  const initialized = deferred();
  const time = createFakeScheduler();
  const controller = new AbortController();
  const result = waitFor(initialized.promise, time, controller.signal);

  assert.equal(time.pendingCount(), 1);
  initialized.resolve();
  assert.equal(await result, true);
  assert.equal(time.pendingCount(), 0);
});

test("PDF.js initialization wait preserves the official capability rejection", async () => {
  const failure = new Error("PDF.js initialization failed");
  const time = createFakeScheduler();
  const controller = new AbortController();
  const result = waitFor(Promise.reject(failure), time, controller.signal);

  await assert.rejects(result, (error) => error === failure);
  assert.equal(time.pendingCount(), 0);
});

test("PDF.js initialization wait rejects at the exact app-owned deadline", async () => {
  const initialized = deferred();
  const time = createFakeScheduler();
  const controller = new AbortController();
  const result = waitFor(initialized.promise, time, controller.signal);

  time.advanceBy(9_999);
  assert.equal(time.pendingCount(), 1);
  time.advanceBy(1);
  await assert.rejects(result, /PDF\.js test initialization timed out\./);
  assert.equal(time.pendingCount(), 0);
});

test("PDF.js initialization wait resolves false and clears its timeout when aborted", async () => {
  const initialized = deferred();
  const time = createFakeScheduler();
  const controller = new AbortController();
  const result = waitFor(initialized.promise, time, controller.signal);

  controller.abort();
  assert.equal(await result, false);
  assert.equal(time.pendingCount(), 0);
  initialized.resolve();
  await Promise.resolve();
  assert.equal(time.pendingCount(), 0);
});
