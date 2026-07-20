import assert from "node:assert/strict";
import test from "node:test";

import {
  createBooksStorage,
  getBook,
  listBooks,
  removeBook,
  updatePosition,
  upsertBook,
} from "../storage/books.mjs";
import { createChromeStorageFake } from "./support/chrome-storage-fake.mjs";

const BOOK_A = "file:///Users/reader/Books/A%20Book.pdf";
const BOOK_B = "file:///Users/reader/Books/B.pdf";
const BOOK_LOWERCASE = "file:///Users/reader/Books/a.pdf";
const BOOK_UPPERCASE = "file:///Users/reader/Books/Z.pdf";

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

function createTestBooksStorage(fake, now = 1_800_000_000, dependencies = {}) {
  return createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => now,
    ...dependencies,
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
  assert.deepEqual(fake.snapshot(), {
    books: { [BOOK_A]: created },
  });
});

test("encoded PDF extensions are accepted while the canonical full href remains the key", async () => {
  const fake = createChromeStorageFake();
  const books = createTestBooksStorage(fake);
  const encodedUrl = "file:///Users/reader/Books/Encoded%2Epdf?edition=1#page=2";

  const created = await books.upsertBook(encodedUrl, { title: "Encoded" });

  assert.deepEqual(fake.snapshot(), { books: { [encodedUrl]: created } });
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

test("position updates reject an explicit page above the known total", async () => {
  const existing = canonicalRecord({ currentPage: 200, totalPages: 300 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake);

  await assert.rejects(() => books.updatePosition(BOOK_A, { currentPage: 301 }), /currentPage/i);
  assert.deepEqual(fake.snapshot().books[BOOK_A], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("position updates can patch one position field and keep timestamps monotonic", async () => {
  const existing = canonicalRecord({ lastReadAt: 1_900_000_000 });
  const fake = createChromeStorageFake({ books: { [BOOK_A]: existing } });
  const books = createTestBooksStorage(fake, 1_800_000_000);

  const updated = await books.updatePosition(BOOK_A, { scrollTop: 0 });

  assert.deepEqual(updated, { ...existing, scrollTop: 0 });
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

test("position patches reject invalid shapes before storage access", async () => {
  const invalidPatches = [
    {},
    [],
    { title: "not position" },
    { currentPage: 1, extra: 1 },
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
    const created = await upsertBook(BOOK_A, { title: "A" });
    assert.deepEqual(await getBook(BOOK_A), created);
    assert.deepEqual(await listBooks(), [{ fileUrl: BOOK_A, book: created }]);
    assert.deepEqual(
      await updatePosition(BOOK_A, { currentPage: 2, scrollTop: 10 }),
      { ...created, currentPage: 2, scrollTop: 10 },
    );
    assert.equal(await removeBook(BOOK_A), true);
  } finally {
    restore();
  }
});
