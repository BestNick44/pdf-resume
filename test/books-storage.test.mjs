import assert from "node:assert/strict";
import test from "node:test";

import {
  BooksStorageDataError,
  createBooksStorage,
  getBook,
  listBooks,
  removeBook,
  trackBook,
  updateCustomTitle,
  updatePosition,
  upsertBook,
} from "../storage/books.mjs";
import { createChromeStorageFake } from "./support/chrome-storage-fake.mjs";

const BOOK_A = "file:///Users/reader/Books/A%20Book.pdf";
const BOOK_B = "file:///Users/reader/Books/B.pdf";
const BOOK_LOWERCASE = "file:///Users/reader/Books/a.pdf";
const BOOK_UPPERCASE = "file:///Users/reader/Books/Z.pdf";
const TEST_TRACKING_GENERATION = "0".repeat(32);

function canonicalRecord(overrides = {}) {
  return {
    title: "A Book",
    customTitle: null,
    totalPages: 300,
    currentPage: 12,
    scrollTop: 450.5,
    addedAt: 1_700_000_000,
    lastReadAt: 1_700_000_100,
    ...overrides,
  };
}

function expectedObservedOrder(
  observation,
  generation = TEST_TRACKING_GENERATION,
) {
  return {
    version: 2,
    generation,
    winner: {
      effectiveTime: observation.observedAt,
      viewerId: observation.viewerId,
      sequence: observation.sequence,
    },
    viewers: {
      [observation.viewerId]: {
        effectiveTime: observation.observedAt,
        sequence: observation.sequence,
      },
    },
  };
}

function assertEmptyCurrentOrder(order) {
  assert.equal(order.version, 2);
  assert.match(order.generation, /^[0-9a-f]{32}$/);
  assert.equal(order.winner, null);
  assert.deepEqual(order.viewers, {});
}

function createTestBooksStorage(fake, now = 1_800_000_000, dependencies = {}) {
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => now,
    nowMilliseconds: () => now * 1_000 + 999,
    ...dependencies,
  });
  return Object.freeze({
    ...storage,
    updatePositionObservation(...args) {
      const [fileUrl, patch, observation, trackingGeneration] = args;
      return storage.updatePositionObservation(
        fileUrl,
        patch,
        observation,
        args.length < 4 ? TEST_TRACKING_GENERATION : trackingGeneration,
      );
    },
  });
}

function setProductionGlobals(fake) {
  const originalChrome = globalThis.chrome;
  const originalNavigator = globalThis.navigator;
  globalThis.chrome = { storage: { local: fake.local } };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: fake.locks },
  });

  return () => {
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
    if (originalNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }
  };
}

test("absent books storage reads as an empty library", async () => {
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake);

  assert.equal(await books.getBook(BOOK_A), undefined);
  assert.deepEqual(await books.listBooks(), []);
  assert.deepEqual(fake.snapshot(), {});
});

test("track creates the initial record once and preserves a concurrently created record", async () => {
  const fake = createChromeStorageFake();
  const firstStore = createTestBooksStorage(fake, 1_800_000_000);
  const secondStore = createTestBooksStorage(fake, 1_800_000_001);
  const heldWrite = fake.holdNext("set");

  const firstTrack = firstStore.trackBook(BOOK_A, { title: "A Book" });
  await heldWrite.started;
  const concurrentTrack = secondStore.trackBook(BOOK_A, { title: "Competing title" });
  heldWrite.release();

  const expected = {
    title: "A Book",
    customTitle: null,
    totalPages: 0,
    currentPage: 1,
    scrollTop: 0,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_000,
  };
  assert.deepEqual(await firstTrack, expected);
  assert.deepEqual(await concurrentTrack, expected);
  assert.deepEqual(fake.snapshot().books, { [BOOK_A]: expected });
  assertEmptyCurrentOrder(fake.snapshot().positionOrder[BOOK_A]);
  assert.equal(
    fake.operations.filter(({ method, phase }) => method === "set" && phase === "start").length,
    1,
  );
});

test("upsert creates a canonical record with documented defaults and timestamps", async () => {
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake);

  const created = await books.upsertBook("file:///Users/reader/Books/A Book.pdf", {
    title: "A Book",
  });

  assert.deepEqual(created, {
    title: "A Book",
    customTitle: null,
    totalPages: 0,
    currentPage: 1,
    scrollTop: 0,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_000,
  });
  assert.deepEqual(fake.snapshot().books, { [BOOK_A]: created });
  assertEmptyCurrentOrder(fake.snapshot().positionOrder[BOOK_A]);
});

test("encoded PDF extensions are accepted while the canonical full href remains the key", async () => {
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake);
  const encodedUrl = "file:///Users/reader/Books/Encoded%2Epdf?edition=1#page=2";

  const created = await books.upsertBook(encodedUrl, { title: "Encoded" });

  assert.deepEqual(fake.snapshot().books, { [encodedUrl]: created });
  assertEmptyCurrentOrder(fake.snapshot().positionOrder[encodedUrl]);
  assert.deepEqual(await books.getBook(encodedUrl), created);
});

test("upsert applies only supplied fields and preserves unrelated newer data", async () => {
  const existing = canonicalRecord({ customTitle: "My favorite", lastReadAt: 1_900_000_000 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  const updated = await books.upsertBook(BOOK_A, {
    title: "Metadata title",
    totalPages: 320,
  });

  assert.deepEqual(updated, {
    ...existing,
    title: "Metadata title",
    totalPages: 320,
  });
  assert.deepEqual(fake.snapshot().books[BOOK_A], updated);
});

test("upsert allows unknown totals on creation but rejects clearing a known total", async () => {
  const createdFake = createChromeStorageFake();
  const created = await createTestBooksStorage(createdFake).upsertBook(BOOK_B, {
    title: "B",
    totalPages: 0,
  });
  assert.equal(created.totalPages, 0);
  assert.equal(
    createdFake.operations.filter(({ method, phase }) => method === "set" && phase === "start")
      .length,
    1,
  );

  const existing = canonicalRecord();
  const existingFake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const existingBooks = createTestBooksStorage(existingFake);

  await assert.rejects(() => existingBooks.upsertBook(BOOK_A, { totalPages: 0 }), /currentPage/i);
  assert.deepEqual(existingFake.snapshot().books[BOOK_A], existing);
  assert.equal(existingFake.operations.filter(({ method }) => method === "set").length, 0);
});

test("upsert rejects an explicit total that is below the preserved current page", async () => {
  const existing = canonicalRecord({ currentPage: 200, totalPages: 300 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  await assert.rejects(() => books.upsertBook(BOOK_A, { totalPages: 100 }), /currentPage/i);
  assert.deepEqual(fake.snapshot().books[BOOK_A], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("position updates preserve metadata and only advance position and last-read fields", async () => {
  const existing = canonicalRecord({ customTitle: "Keep this title" });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  const updated = await books.updatePosition(BOOK_A, {
    currentPage: 13,
    scrollTop: 999.25,
  });

  assert.deepEqual(updated, {
    ...existing,
    currentPage: 13,
    scrollTop: 999.25,
    lastReadAt: 1_800_000_000,
  });
  assert.equal(updated.title, existing.title);
  assert.equal(updated.customTitle, existing.customTitle);
  assert.equal(updated.totalPages, existing.totalPages);
  assert.equal(updated.addedAt, existing.addedAt);
});

test("position updates can advance beyond a stale known total without changing metadata", async () => {
  const existing = canonicalRecord({
    customTitle: "Reader override",
    currentPage: 7,
    totalPages: 7,
  });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  const updated = await books.updatePosition(BOOK_A, {
    currentPage: 8,
    scrollTop: 800,
  });

  assert.deepEqual(updated, {
    ...existing,
    currentPage: 8,
    scrollTop: 800,
    lastReadAt: 1_800_000_000,
  });
  assert.deepEqual(fake.snapshot().books[BOOK_A], updated);
});

test("position updates can patch one position field and keep timestamps monotonic", async () => {
  const existing = canonicalRecord({ lastReadAt: 1_900_000_000 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  const updated = await books.updatePosition(BOOK_A, { scrollTop: 0 });

  assert.deepEqual(updated, { ...existing, scrollTop: 0 });
});

test("observed position order rejects stale delivery and permits later backward navigation", async () => {
  const existing = canonicalRecord({
    currentPage: 20,
    lastReadAt: 1_750_000_002,
    scrollTop: 2_000,
  });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  assert.deepEqual(
    await books.updatePosition(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      { observedAt: 1_750_000_001_999 },
    ),
    existing,
  );
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);

  const updated = await books.updatePosition(
    BOOK_A,
    { currentPage: 3, scrollTop: 300 },
    { observedAt: 1_750_000_003_100 },
  );
  assert.deepEqual(updated, {
    ...existing,
    currentPage: 3,
    scrollTop: 300,
    lastReadAt: 1_750_000_003,
  });
  assert.deepEqual(fake.snapshot().books[BOOK_A], updated);
});

test("observed position updates durably reject older same-second delivery", async () => {
  const existing = canonicalRecord({
    currentPage: 2,
    lastReadAt: 1_750_000_002,
    scrollTop: 200,
  });
  const newerObservation = {
    viewerId: "a".repeat(32),
    sequence: 2,
    observedAt: 1_750_000_002_100,
  };
  const olderObservation = {
    viewerId: "a".repeat(32),
    sequence: 1,
    observedAt: 1_750_000_002_000,
  };
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const firstStore = createTestBooksStorage(fake, 1_800_000_000);

  assert.equal(
    await firstStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 8, scrollTop: 800 },
      newerObservation,
    ),
    "updated",
  );
  const durableState = fake.snapshot();
  assert.deepEqual(durableState.positionOrder, {
    [BOOK_A]: expectedObservedOrder(newerObservation),
  });

  const restartedStore = createTestBooksStorage(fake, 1_800_000_000);
  assert.equal(
    await restartedStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 3, scrollTop: 300 },
      olderObservation,
    ),
    "stale",
  );
  assert.deepEqual(fake.snapshot(), durableState);
});

test("same-viewer sequence survives clock rollback and storage recreation", async () => {
  const existing = canonicalRecord({ lastReadAt: 1_750_000_001 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const viewerId = "b".repeat(32);
  const firstStore = createTestBooksStorage(fake, 1_800_000_000);

  assert.equal(
    await firstStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 4, scrollTop: 400 },
      { viewerId, sequence: 10, observedAt: 1_750_000_005_000 },
    ),
    "updated",
  );
  assert.equal(
    await firstStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 5, scrollTop: 500 },
      { viewerId, sequence: 11, observedAt: 1_750_000_004_000 },
    ),
    "updated",
  );
  assert.equal(fake.snapshot().books[BOOK_A].lastReadAt, 1_750_000_005);
  assert.equal(
    await firstStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      { viewerId, sequence: 10, observedAt: 1_750_000_006_000 },
    ),
    "stale",
  );

  const restartedStore = createTestBooksStorage(fake, 1_800_000_000);
  assert.equal(
    await restartedStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 6, scrollTop: 600 },
      { viewerId, sequence: 12, observedAt: 1_750_000_003_000 },
    ),
    "updated",
  );
  const afterRollback = fake.snapshot();
  assert.deepEqual(
    {
      currentPage: afterRollback.books[BOOK_A].currentPage,
      lastReadAt: afterRollback.books[BOOK_A].lastReadAt,
      scrollTop: afterRollback.books[BOOK_A].scrollTop,
    },
    { currentPage: 6, lastReadAt: 1_750_000_005, scrollTop: 600 },
  );
  assert.equal(
    await restartedStore.updatePositionObservation(
      BOOK_A,
      { currentPage: 7, scrollTop: 700 },
      { viewerId, sequence: 12, observedAt: 1_750_000_007_000 },
    ),
    "stale",
  );
  assert.deepEqual(fake.snapshot(), afterRollback);
});

test("untracked updates install no order and remove plus retrack resets prior order", async () => {
  const nowSeconds = 1_750_000_000;
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake, nowSeconds);
  const previousObservation = {
    viewerId: "c".repeat(32),
    sequence: 50,
    observedAt: nowSeconds * 1_000 + 100,
  };

  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 8, scrollTop: 800 },
      previousObservation,
    ),
    "missing",
  );
  assert.deepEqual(fake.snapshot(), {});

  await books.trackBook(BOOK_A, { title: "A Book" });
  const firstState = await books.getPositionTrackingState(
    BOOK_A,
    previousObservation.viewerId,
  );
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 8, scrollTop: 800 },
      previousObservation,
      firstState.trackingGeneration,
    ),
    "updated",
  );
  assert.deepEqual(fake.snapshot().positionOrder, {
    [BOOK_A]: expectedObservedOrder(
      previousObservation,
      firstState.trackingGeneration,
    ),
  });

  assert.equal(await books.removeBook(BOOK_A), true);
  assert.deepEqual(fake.snapshot().positionOrder, {});
  await books.trackBook(BOOK_A, { title: "Retracked" });
  const retrackedObservation = {
    viewerId: previousObservation.viewerId,
    sequence: 1,
    observedAt: nowSeconds * 1_000 + 200,
  };
  const retrackedState = await books.getPositionTrackingState(
    BOOK_A,
    retrackedObservation.viewerId,
  );
  assert.notEqual(
    retrackedState.trackingGeneration,
    firstState.trackingGeneration,
  );
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 20 },
      retrackedObservation,
      retrackedState.trackingGeneration,
    ),
    "updated",
  );
  assert.deepEqual(fake.snapshot().positionOrder, {
    [BOOK_A]: expectedObservedOrder(
      retrackedObservation,
      retrackedState.trackingGeneration,
    ),
  });
});

test("legacy position writes preserve known stale-viewer rejection state", async () => {
  const existing = canonicalRecord({
    addedAt: 1_000,
    currentPage: 1,
    lastReadAt: 1_000,
    scrollTop: 100,
  });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 2_000);
  const viewerId = "4".repeat(32);

  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      { viewerId, sequence: 2, observedAt: 1_002_900 },
    ),
    "updated",
  );
  assert.equal(
    (
      await books.updatePosition(
        BOOK_A,
        { currentPage: 9, scrollTop: 900 },
        { observedAt: 1_002_950 },
      )
    ).currentPage,
    9,
  );
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 1, scrollTop: 100 },
      { viewerId, sequence: 1, observedAt: 1_002_100 },
    ),
    "stale",
  );
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 9);
});

test("an observation captured before remove and same-second retrack cannot mutate the new lifetime", async () => {
  const existing = canonicalRecord({
    addedAt: 1_000,
    currentPage: 1,
    lastReadAt: 1_000,
  });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_001);
  const oldViewer = "5".repeat(32);
  const oldState = await books.getPositionTrackingState(BOOK_A, oldViewer);

  assert.equal(await books.removeBook(BOOK_A), true);
  await books.trackBook(BOOK_A, { title: "Retracked" });
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 9, scrollTop: 900 },
      { viewerId: oldViewer, sequence: 1, observedAt: 1_001_100 },
      oldState.trackingGeneration,
    ),
    "stale",
  );
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 1);

  const freshViewer = "6".repeat(32);
  const freshState = await books.getPositionTrackingState(BOOK_A, freshViewer);
  assert.notEqual(
    freshState.trackingGeneration,
    oldState.trackingGeneration,
  );
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      { viewerId: freshViewer, sequence: 1, observedAt: 1_001_900 },
      freshState.trackingGeneration,
    ),
    "updated",
  );
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 2);
});

test("pending handoffs cannot register an unknown or pre-retrack viewer", async (t) => {
  await t.test("unregistered viewer", async () => {
    const existing = canonicalRecord({ addedAt: 0, lastReadAt: 0 });
    const fake = createChromeStorageFake({
      books: { [BOOK_A]: existing },
      positionOrder: {
        [BOOK_A]: {
          version: 2,
          generation: TEST_TRACKING_GENERATION,
          winner: null,
          viewers: {},
        },
      },
    });
    const books = createTestBooksStorage(fake);
    const before = fake.snapshot();

    assert.equal(
      await books.updatePendingPositionObservation(
        BOOK_A,
        { currentPage: 9, scrollTop: 900 },
        {
          viewerId: "7".repeat(32),
          sequence: 1,
          observedAt: 1_000,
        },
      ),
      "stale",
    );
    assert.deepEqual(fake.snapshot(), before);
    assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
  });

  await t.test("pre-retrack viewer", async () => {
    let generationNumber = 0;
    const fake = createChromeStorageFake();
    const books = createTestBooksStorage(fake, 1_001, {
      createTrackingGeneration() {
        generationNumber += 1;
        return generationNumber.toString(16).padStart(32, "0");
      },
    });
    await books.trackBook(BOOK_A, { title: "Original" });
    const oldViewer = "8".repeat(32);
    await books.getPositionTrackingState(BOOK_A, oldViewer);
    assert.equal(await books.removeBook(BOOK_A), true);
    await books.trackBook(BOOK_A, { title: "Retracked" });
    const before = fake.snapshot();
    const writesBefore = fake.operations.filter(
      ({ method }) => method === "set",
    ).length;

    assert.equal(
      await books.updatePendingPositionObservation(
        BOOK_A,
        { currentPage: 9, scrollTop: 900 },
        {
          viewerId: oldViewer,
          sequence: 1,
          observedAt: 1_001_100,
        },
      ),
      "stale",
    );
    assert.deepEqual(fake.snapshot(), before);
    assert.equal(
      fake.operations.filter(({ method }) => method === "set").length,
      writesBefore,
    );
  });
});

test("viewer high-water storage is bounded without reopening the prior winner", async () => {
  let generationNumber = 0;
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake, 2_000, {
    createTrackingGeneration() {
      generationNumber += 1;
      return generationNumber.toString(16).padStart(32, "0");
    },
  });
  await books.trackBook(BOOK_A, { title: "A" });

  let firstState;
  for (let index = 1; index <= 64; index += 1) {
    const viewerId = index.toString(16).padStart(32, "0");
    const state = await books.getPositionTrackingState(BOOK_A, viewerId);
    firstState ??= state;
    assert.equal(state.trackingGeneration, firstState.trackingGeneration);
  }
  assert.equal(
    Object.keys(fake.snapshot().positionOrder[BOOK_A].viewers).length,
    64,
  );
  const firstViewer = "0".repeat(31) + "1";
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 3, scrollTop: 300 },
      { viewerId: firstViewer, sequence: 1, observedAt: 2_000_500 },
      firstState.trackingGeneration,
    ),
    "updated",
  );

  const freshViewer = "f".repeat(32);
  const rotatedState = await books.getPositionTrackingState(
    BOOK_A,
    freshViewer,
  );
  assert.notEqual(
    rotatedState.trackingGeneration,
    firstState.trackingGeneration,
  );
  assert.deepEqual(Object.keys(fake.snapshot().positionOrder[BOOK_A].viewers), [
    freshViewer,
  ]);
  assert.deepEqual(fake.snapshot().positionOrder[BOOK_A].winner, {
    effectiveTime: 2_000_500,
    viewerId: null,
    sequence: 0,
  });

  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 9, scrollTop: 900 },
      { viewerId: firstViewer, sequence: 2, observedAt: 2_000_700 },
      firstState.trackingGeneration,
    ),
    "stale",
  );
  assert.equal(
    await books.updatePendingPositionObservation(
      BOOK_A,
      { currentPage: 9, scrollTop: 900 },
      { viewerId: firstViewer, sequence: 2, observedAt: 2_000_700 },
    ),
    "stale",
  );
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 9, scrollTop: 900 },
      { viewerId: freshViewer, sequence: 1, observedAt: 2_000_400 },
      rotatedState.trackingGeneration,
    ),
    "stale",
  );
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 3);
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      { viewerId: freshViewer, sequence: 2, observedAt: 2_000_600 },
      rotatedState.trackingGeneration,
    ),
    "updated",
  );
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 2);
});

test("malformed orphan order is isolated while malformed relevant order still rejects", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_A]: canonicalRecord() },
    positionOrder: {
      [BOOK_A]: { viewerId: "7".repeat(32), sequence: 1 },
    },
  });
  const books = createTestBooksStorage(fake);

  await books.trackBook(BOOK_B, { title: "B" });
  assert.equal(fake.snapshot().books[BOOK_B].title, "B");
  assert.equal((await books.upsertBook(BOOK_B, { title: "Updated B" })).title, "Updated B");
  assert.equal(await books.removeBook(BOOK_B), true);
  assert.equal(Object.hasOwn(fake.snapshot().books, BOOK_B), false);
  const observation = {
    viewerId: "7".repeat(32),
    sequence: 2,
    observedAt: 1_750_000_003_000,
  };
  const beforeRelevantMutations = fake.snapshot();
  await assert.rejects(
    () =>
      books.updatePositionObservation(
        BOOK_A,
        { currentPage: 20, scrollTop: 2_000 },
        observation,
      ),
    BooksStorageDataError,
  );
  await assert.rejects(
    () =>
      books.updatePendingPositionObservation(
        BOOK_A,
        { currentPage: 20, scrollTop: 2_000 },
        observation,
      ),
    BooksStorageDataError,
  );
  assert.deepEqual(fake.snapshot(), beforeRelevantMutations);
});

test("missing durable order migrates through lastReadAt before installing a watermark", async () => {
  const existing = canonicalRecord({ lastReadAt: 1_750_000_002 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 200 },
      {
        viewerId: "d".repeat(32),
        sequence: 1,
        observedAt: 1_750_000_001_999,
      },
    ),
    "stale",
  );
  assert.equal(Object.hasOwn(fake.snapshot(), "positionOrder"), false);

  const migratedObservation = {
    viewerId: "d".repeat(32),
    sequence: 2,
    observedAt: 1_750_000_002_900,
  };
  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 3, scrollTop: 300 },
      migratedObservation,
    ),
    "updated",
  );
  assert.deepEqual(fake.snapshot().positionOrder, {
    [BOOK_A]: expectedObservedOrder(migratedObservation),
  });
});

test("observed position mutations reject malformed input before storage access", async () => {
  const validObservation = {
    viewerId: "e".repeat(32),
    sequence: 1,
    observedAt: 1_750_000_000_000,
  };
  const invalidObservations = [
    null,
    {},
    { ...validObservation, viewerId: "invalid" },
    { ...validObservation, sequence: 0 },
    { ...validObservation, observedAt: -1 },
    { ...validObservation, extra: true },
  ];

  for (const observation of invalidObservations) {
    const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
    const books = createTestBooksStorage(fake, 1_800_000_000);
    await assert.rejects(() =>
      books.updatePositionObservation(
        BOOK_A,
        { currentPage: 2, scrollTop: 20 },
        observation,
      ),
    );
    assert.deepEqual(fake.operations, []);
    assert.equal(Object.hasOwn(fake.snapshot(), "positionOrder"), false);
  }

  for (const generation of [undefined, null, "not-a-generation"]) {
    const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
    const books = createTestBooksStorage(fake, 1_800_000_000);
    await assert.rejects(() =>
      books.updatePositionObservation(
        BOOK_A,
        { currentPage: 2, scrollTop: 20 },
        validObservation,
        generation,
      ),
    );
    assert.deepEqual(fake.operations, []);
  }
});

test("a future unknown-viewer observation is invalid and installs no order", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  assert.equal(
    await books.updatePositionObservation(
      BOOK_A,
      { currentPage: 2, scrollTop: 20 },
      {
        viewerId: "e".repeat(32),
        sequence: 1,
        observedAt: 1_800_000_001_000,
      },
    ),
    "invalid",
  );
  assert.deepEqual(fake.snapshot(), { books: { [BOOK_A]: existing } });
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("malformed durable position order rejects without authorizing a write", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({
    books: { [BOOK_A]: existing },
    positionOrder: {
      [BOOK_A]: {
        viewerId: "f".repeat(32),
        sequence: 2,
      },
    },
  });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  await assert.rejects(
    () =>
      books.updatePositionObservation(
        BOOK_A,
        { currentPage: 20, scrollTop: 2_000 },
        {
          viewerId: "f".repeat(32),
          sequence: 3,
          observedAt: 1_750_000_003_000,
        },
      ),
    BooksStorageDataError,
  );
  assert.deepEqual(fake.snapshot().books[BOOK_A], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("malformed current order invariants reject without authorizing a write", async () => {
  const existing = canonicalRecord();
  const viewerId = "8".repeat(32);
  const fake = createChromeStorageFake({
    books: { [BOOK_A]: existing },
    positionOrder: {
      [BOOK_A]: {
        version: 2,
        generation: TEST_TRACKING_GENERATION,
        winner: {
          effectiveTime: 1_750_000_003_000,
          viewerId,
          sequence: 3,
        },
        viewers: {
          [viewerId]: {
            effectiveTime: 1_750_000_002_000,
            sequence: 3,
          },
        },
      },
    },
  });
  const books = createTestBooksStorage(fake);

  await assert.rejects(
    () => books.getPositionTrackingState(BOOK_A, viewerId),
    BooksStorageDataError,
  );
  assert.deepEqual(fake.snapshot().books[BOOK_A], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("v2 winner validation rejects every nonmaximum winner before mutation", async (t) => {
  const viewerA = "a".repeat(32);
  const viewerB = "b".repeat(32);
  const viewerC = "c".repeat(32);
  const cases = [
    {
      name: "observed winner below a retained viewer high-water mark",
      winner: { effectiveTime: 1_000, viewerId: viewerB, sequence: 1 },
      viewers: {
        [viewerA]: { effectiveTime: 2_000, sequence: 1 },
        [viewerB]: { effectiveTime: 1_000, sequence: 1 },
      },
    },
    {
      name: "unordered barrier below a retained viewer high-water mark",
      winner: { effectiveTime: 1_000, viewerId: null, sequence: 0 },
      viewers: {
        [viewerA]: { effectiveTime: 2_000, sequence: 1 },
      },
    },
    {
      name: "null winner with a positive viewer high-water mark",
      winner: null,
      viewers: {
        [viewerA]: { effectiveTime: 2_000, sequence: 1 },
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const existing = canonicalRecord({ addedAt: 0, lastReadAt: 0 });
      const fake = createChromeStorageFake({
        books: { [BOOK_A]: existing },
        positionOrder: {
          [BOOK_A]: {
            version: 2,
            generation: TEST_TRACKING_GENERATION,
            winner: testCase.winner,
            viewers: testCase.viewers,
          },
        },
      });
      const books = createTestBooksStorage(fake);
      const before = fake.snapshot();

      await assert.rejects(
        () =>
          books.updatePositionObservation(
            BOOK_A,
            { currentPage: 20, scrollTop: 2_000 },
            {
              viewerId: viewerC,
              sequence: 1,
              observedAt: 1_500,
            },
          ),
        BooksStorageDataError,
      );
      assert.deepEqual(fake.snapshot(), before);
      assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
    });
  }
});

test("position observation options reject malformed or future order before storage access", async () => {
  const invalidOptions = [
    null,
    {},
    { observedAt: -1 },
    { observedAt: 1.5 },
    { observedAt: Number.MAX_SAFE_INTEGER + 1 },
    { observedAt: 1_750_000_000_000, extra: true },
    { unexpected: 1_750_000_000_000 },
    { observedAt: 1_800_000_001_000 },
  ];

  for (const options of invalidOptions) {
    const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
    await assert.rejects(() =>
      createTestBooksStorage(fake, 1_800_000_000).updatePosition(
        BOOK_A,
        { currentPage: 2 },
        options,
      ),
    );
    assert.deepEqual(fake.operations, []);
  }
});

test("position update for an untracked book is a no-op", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_B]: canonicalRecord() } });
  const books = createTestBooksStorage(fake);

  assert.equal(await books.updatePosition(BOOK_A, { currentPage: 2 }), undefined);
  assert.deepEqual(fake.snapshot(), { books: { [BOOK_B]: canonicalRecord() } });
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("a stale current page above a known total remains readable without state churn", async () => {
  const existing = canonicalRecord({ currentPage: 12, totalPages: 7 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  assert.deepEqual(await books.getBook(BOOK_A), existing);
  assert.deepEqual(fake.snapshot().books[BOOK_A], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("get and list return canonical records in code-unit URL order", async () => {
  const recordA = canonicalRecord({ title: "A" });
  const recordLowercase = canonicalRecord({ title: "lowercase" });
  const recordUppercase = canonicalRecord({ title: "uppercase" });
  const fake = createChromeStorageFake({
    books: {
      [BOOK_LOWERCASE]: recordLowercase,
      [BOOK_A]: recordA,
      [BOOK_UPPERCASE]: recordUppercase,
    },
  });
  const books = createTestBooksStorage(fake);

  assert.deepEqual(await books.getBook(BOOK_A), recordA);
  assert.deepEqual(await books.listBooks(), [
    { fileUrl: BOOK_A, book: recordA },
    { fileUrl: BOOK_UPPERCASE, book: recordUppercase },
    { fileUrl: BOOK_LOWERCASE, book: recordLowercase },
  ]);
});

test("remove deletes an existing record and missing removes are no-ops", async () => {
  const recordB = canonicalRecord({ title: "B" });
  const fake = createChromeStorageFake({
    books: { [BOOK_A]: canonicalRecord(), [BOOK_B]: recordB },
  });
  const books = createTestBooksStorage(fake);

  assert.equal(await books.removeBook(BOOK_A), true);
  assert.deepEqual(fake.snapshot(), { books: { [BOOK_B]: recordB } });
  assert.equal(await books.removeBook(BOOK_A), false);
  assert.deepEqual(fake.snapshot(), { books: { [BOOK_B]: recordB } });
  assert.equal(
    fake.operations.filter(({ method, phase }) => method === "set" && phase === "start").length,
    1,
  );
});

test("public results never alias persisted or caller-owned objects", async () => {
  const initial = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_A]: initial } });
  const books = createTestBooksStorage(fake);

  const read = await books.getBook(BOOK_A);
  read.title = "Mutated read";
  const listed = await books.listBooks();
  listed[0].book.customTitle = "Mutated list";
  const patch = { title: "Updated" };
  const updated = await books.upsertBook(BOOK_A, patch);
  patch.title = "Mutated patch";
  updated.title = "Mutated return";

  assert.equal(fake.snapshot().books[BOOK_A].title, "Updated");
  assert.equal(fake.snapshot().books[BOOK_A].customTitle, null);
});

test("mutation results do not alias objects handed to the storage adapter", async () => {
  let raw = {};
  const storageArea = {
    async get() {
      return raw;
    },
    async set(items) {
      raw = items;
    },
  };
  const locks = createChromeStorageFake().locks;
  const books = createBooksStorage({
    storageArea,
    lockManager: locks,
    now: () => 1_800_000_000,
  });

  const created = await books.upsertBook(BOOK_A, { title: "A" });
  created.title = "caller mutation";

  assert.equal(raw.books[BOOK_A].title, "A");
});

test("invalid URLs and patch values are rejected before storage access", async (t) => {
  const cases = [
    ["malformed URL", "not a URL", { title: "Book" }],
    ["remote URL", "https://example.test/book.pdf", { title: "Book" }],
    ["non-PDF URL", "file:///tmp/book.txt", { title: "Book" }],
    ["malformed pathname escape", "file:///tmp/book%ZZ.pdf", { title: "Book" }],
    ["NUL in pathname", "file:///tmp/book%00.pdf", { title: "Book" }],
    ["remote file authority", "file://server/share/book.pdf", { title: "Book" }],
    ["empty patch", BOOK_A, {}],
    ["array patch", BOOK_A, []],
    ["unknown field", BOOK_A, { unexpected: true }],
    ["prototype-polluting field", BOOK_A, JSON.parse('{"__proto__": {"polluted": true}}')],
    ["undefined title", BOOK_A, { title: undefined }],
    ["non-string title", BOOK_A, { title: 1 }],
    ["bad custom title", BOOK_A, { customTitle: undefined }],
    ["negative total pages", BOOK_A, { totalPages: -1 }],
    ["fractional total pages", BOOK_A, { totalPages: 2.5 }],
    ["zero current page", BOOK_A, { currentPage: 0 }],
    ["NaN current page", BOOK_A, { currentPage: Number.NaN }],
    ["infinite scroll", BOOK_A, { scrollTop: Number.POSITIVE_INFINITY }],
    ["negative scroll", BOOK_A, { scrollTop: -1 }],
  ];

  for (const [name, fileUrl, patch] of cases) {
    await t.test(name, async () => {
      const fake = createChromeStorageFake();
      await assert.rejects(() => createTestBooksStorage(fake).upsertBook(fileUrl, patch));
      assert.deepEqual(fake.operations, []);
      assert.deepEqual(fake.snapshot(), {});
    });
  }
});

test("custom title updates support clearing and validate before storage access", async () => {
  const existing = canonicalRecord({ customTitle: "Reader name" });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  assert.deepEqual(await books.updateCustomTitle(BOOK_A, null), {
    ...existing,
    customTitle: null,
  });

  const invalidFake = createChromeStorageFake();
  const invalidBooks = createTestBooksStorage(invalidFake);
  await assert.rejects(() => invalidBooks.updateCustomTitle(BOOK_A, undefined), /customTitle/i);
  await assert.rejects(
    () => invalidBooks.updateCustomTitle("https://example.test/book.pdf", "Name"),
    /local file/i,
  );
  assert.deepEqual(invalidFake.operations, []);
});

test("position patches reject invalid shapes before storage access", async () => {
  const invalidPatches = [
    {},
    [],
    { title: "not position" },
    { currentPage: 1, extra: 1 },
    { currentPage: -1 },
    { currentPage: 0 },
    { currentPage: Number.NaN },
    { currentPage: Number.POSITIVE_INFINITY },
    { currentPage: 1.2 },
    { scrollTop: -0.1 },
    { scrollTop: Number.NEGATIVE_INFINITY },
  ];

  for (const patch of invalidPatches) {
    const fake = createChromeStorageFake();
    await assert.rejects(() => createTestBooksStorage(fake).updatePosition(BOOK_A, patch));
    assert.deepEqual(fake.operations, []);
  }
});

test("malformed persisted books state is reported and never rewritten", async (t) => {
  const malformedStates = [
    ["null books", null],
    ["array books", []],
    ["noncanonical key", { "file:///tmp/A Book.pdf": canonicalRecord() }],
    ["non-file key", { "https://example.test/book.pdf": canonicalRecord() }],
    ["prototype key", JSON.parse('{"__proto__": {}}')],
    ["null record", { [BOOK_A]: null }],
    ["missing field", { [BOOK_A]: { title: "A" } }],
    ["extra field", { [BOOK_A]: { ...canonicalRecord(), extra: true } }],
    ["bad title", { [BOOK_A]: canonicalRecord({ title: 5 }) }],
    ["bad custom title", { [BOOK_A]: canonicalRecord({ customTitle: undefined }) }],
    ["bad total pages", { [BOOK_A]: canonicalRecord({ totalPages: -1 }) }],
    [
      "non-finite scroll omitted during Chrome serialization",
      { [BOOK_A]: canonicalRecord({ scrollTop: Number.NaN }) },
    ],
    ["bad added timestamp", { [BOOK_A]: canonicalRecord({ addedAt: -1 }) }],
    ["bad last-read timestamp", { [BOOK_A]: canonicalRecord({ lastReadAt: 1.5 }) }],
  ];

  for (const [name, booksState] of malformedStates) {
    await t.test(name, async () => {
      const fake = createChromeStorageFake({ books: booksState });
      const books = createTestBooksStorage(fake);
      await assert.rejects(() => books.listBooks(), /stored books/i);
      await assert.rejects(() => books.upsertBook(BOOK_B, { title: "B" }), /stored books/i);
      assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
    });
  }
});

test("storage read and write failures propagate without false success", async () => {
  const readFake = createChromeStorageFake();
  readFake.failNext("get", new Error("read denied"));
  await assert.rejects(() => createTestBooksStorage(readFake).listBooks(), /read denied/);

  const existing = canonicalRecord();
  const writeFake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  writeFake.failNext("set", new Error("quota exceeded"));
  await assert.rejects(
    () => createTestBooksStorage(writeFake).upsertBook(BOOK_A, { title: "Not saved" }),
    /quota exceeded/,
  );
  assert.deepEqual(writeFake.snapshot().books[BOOK_A], existing);
});

test("Chrome storage fake serializes unsupported values instead of structured-cloning them", async () => {
  const fake = createChromeStorageFake({ retained: "existing" });
  const payload = {
    keep: 1,
    undefinedValue: undefined,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    functionValue() {},
    bigintValue: 1n,
    map: new Map([["ignored", true]]),
    values: [undefined, Number.NaN, Number.NEGATIVE_INFINITY, () => {}, new Set([1])],
  };

  const write = fake.local.set({
    retained: undefined,
    omitted: Number.NaN,
    payload,
  });
  payload.keep = 2;
  await write;

  assert.deepEqual(fake.snapshot(), {
    retained: "existing",
    payload: {
      keep: 1,
      map: {},
      values: [null, null, null, null, {}],
    },
  });
});

test("Chrome storage fake supports callbacks, promises, copy semantics, and runtime errors", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
  const promised = await fake.local.get("books");
  promised.books[BOOK_A].title = "mutated promise read";

  const callbackRead = await new Promise((resolve) => fake.local.get("books", resolve));
  callbackRead.books[BOOK_A].title = "mutated callback read";
  assert.equal(fake.snapshot().books[BOOK_A].title, "A Book");

  fake.failNext("set", new Error("callback write failed"));
  const lastErrorMessage = await new Promise((resolve) => {
    fake.local.set({ other: true }, () => resolve(fake.runtime.lastError?.message));
  });
  assert.equal(lastErrorMessage, "callback write failed");
  assert.equal(fake.runtime.lastError, undefined);

  fake.failNext("get", new Error("promise read failed"));
  await assert.rejects(() => fake.local.get("books"), /promise read failed/);
});

test("cross-context lock preserves simultaneous updates to distinct books", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
  const viewerStore = createTestBooksStorage(fake, 1_800_000_001);
  const popupStore = createTestBooksStorage(fake, 1_800_000_002);
  const heldRead = fake.holdNext("get", { after: true });

  const viewerWrite = viewerStore.updatePosition(BOOK_A, { currentPage: 20 });
  await heldRead.started;
  const popupWrite = popupStore.upsertBook(BOOK_B, { title: "B" });
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
  if (fake.operations.filter(({ method }) => method === "get").length > 1) {
    await popupWrite;
  }
  heldRead.release();
  await Promise.all([viewerWrite, popupWrite]);

  assert.deepEqual(Object.keys(fake.snapshot().books).sort(), [BOOK_A, BOOK_B]);
  assert.equal(fake.snapshot().books[BOOK_A].currentPage, 20);
  assert.equal(fake.snapshot().books[BOOK_B].title, "B");
});

test("custom title updates preserve all latest fields under the cross-context lock", async () => {
  const existing = canonicalRecord({ customTitle: null });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const viewerStore = createTestBooksStorage(fake, 1_800_000_001);
  const popupStore = createTestBooksStorage(fake, 1_800_000_002);
  const heldWrite = fake.holdNext("set");

  const positionWrite = viewerStore.updatePosition(BOOK_A, {
    currentPage: 20,
    scrollTop: 900,
  });
  await heldWrite.started;
  const renameWrite = popupStore.updateCustomTitle(BOOK_A, "Renamed");
  heldWrite.release();

  assert.deepEqual(await renameWrite, {
    ...existing,
    customTitle: "Renamed",
    currentPage: 20,
    scrollTop: 900,
    lastReadAt: 1_800_000_001,
  });
  await positionWrite;
  assert.deepEqual(fake.snapshot().books[BOOK_A], {
    ...existing,
    customTitle: "Renamed",
    currentPage: 20,
    scrollTop: 900,
    lastReadAt: 1_800_000_001,
  });
});

test("custom title updates queued after or performed after untrack never recreate the book", async (t) => {
  await t.test("performed after untrack", async () => {
    const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
    const books = createTestBooksStorage(fake);

    assert.equal(await books.removeBook(BOOK_A), true);
    const writesAfterUntrack = fake.operations.filter(({ method }) => method === "set").length;

    assert.equal(await books.updateCustomTitle(BOOK_A, "Renamed"), undefined);
    assert.deepEqual(fake.snapshot(), { books: {} });
    assert.equal(
      fake.operations.filter(({ method }) => method === "set").length,
      writesAfterUntrack,
    );
  });

  await t.test("queued after untrack", async () => {
    const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
    const untrackStore = createTestBooksStorage(fake);
    const renameStore = createTestBooksStorage(fake);
    const heldWrite = fake.holdNext("set");

    const untrack = untrackStore.removeBook(BOOK_A);
    await heldWrite.started;
    const rename = renameStore.updateCustomTitle(BOOK_A, "Renamed");
    heldWrite.release();

    assert.equal(await untrack, true);
    assert.equal(await rename, undefined);
    assert.deepEqual(fake.snapshot(), { books: {} });
    assert.equal(
      fake.operations.filter(({ method, phase }) => method === "set" && phase === "start").length,
      1,
    );
  });
});

test("cross-context lock preserves simultaneous partial updates to the same book", async () => {
  const existing = canonicalRecord({ customTitle: null });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const viewerStore = createTestBooksStorage(fake, 1_800_000_001);
  const popupStore = createTestBooksStorage(fake, 1_800_000_002);
  const heldWrite = fake.holdNext("set");

  const viewerWrite = viewerStore.updatePosition(BOOK_A, { currentPage: 20 });
  await heldWrite.started;
  const popupWrite = popupStore.upsertBook(BOOK_A, { customTitle: "Renamed" });
  heldWrite.release();
  await Promise.all([viewerWrite, popupWrite]);

  assert.deepEqual(fake.snapshot().books[BOOK_A], {
    ...existing,
    customTitle: "Renamed",
    currentPage: 20,
    lastReadAt: 1_800_000_001,
  });
});

test("unavailable locks reject on the bounded deadline without touching storage", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_A]: canonicalRecord() } });
  const heldRead = fake.holdNext("get", { after: true });
  const holderWrite = createTestBooksStorage(fake).updatePosition(BOOK_A, { currentPage: 20 });
  await heldRead.started;

  const timeout = new AbortController();
  let timeoutMilliseconds;
  const waitingStore = createTestBooksStorage(fake, 1_800_000_001, {
    createLockTimeoutSignal(milliseconds) {
      timeoutMilliseconds = milliseconds;
      return timeout.signal;
    },
  });
  const waitingWrite = waitingStore.upsertBook(BOOK_B, { title: "B" });
  const rejectedWrite = assert.rejects(waitingWrite, { name: "TimeoutError" });
  timeout.abort(new DOMException("book storage lock acquisition timed out", "TimeoutError"));
  await rejectedWrite;

  assert.equal(timeoutMilliseconds, 25_000);
  assert.equal(
    fake.operations.filter(({ method, phase }) => method === "get" && phase === "start").length,
    1,
  );
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);

  heldRead.release();
  await holderWrite;
  assert.equal(Object.hasOwn(fake.snapshot().books, BOOK_B), false);
});

test("mutations require a cross-context lock rather than claiming storage atomicity", async () => {
  const fake = createChromeStorageFake();
  const books = createBooksStorage({
    storageArea: fake.local,
    lockManager: undefined,
    now: () => 1_800_000_000,
  });

  await assert.rejects(() => books.upsertBook(BOOK_A, { title: "A" }), /Web Locks/i);
  assert.deepEqual(fake.operations, []);
});

test("top-level API resolves Chrome dependencies lazily in extension contexts", async () => {
  const fake = createChromeStorageFake();
  const restore = setProductionGlobals(fake);

  try {
    const created = await trackBook(BOOK_A, { title: "A" });
    assert.deepEqual(await getBook(BOOK_A), created);
    const updated = await upsertBook(BOOK_A, { title: "Updated" });
    assert.deepEqual(updated, { ...created, title: "Updated" });
    const renamed = await updateCustomTitle(BOOK_A, "Reader name");
    assert.deepEqual(renamed, { ...updated, customTitle: "Reader name" });
    assert.deepEqual(await listBooks(), [{ fileUrl: BOOK_A, book: renamed }]);
    assert.deepEqual(
      await updatePosition(BOOK_A, { currentPage: 2, scrollTop: 10 }),
      { ...renamed, currentPage: 2, scrollTop: 10 },
    );
    assert.equal(await removeBook(BOOK_A), true);
  } finally {
    restore();
  }
});
