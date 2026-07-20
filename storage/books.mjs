import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";

const BOOKS_KEY = "books";
const BOOKS_LOCK = "pdf-resume:books";
const BOOKS_LOCK_TIMEOUT_MILLISECONDS = 25_000;
const RECORD_FIELDS = [
  "title",
  "customTitle",
  "totalPages",
  "currentPage",
  "scrollTop",
  "addedAt",
  "lastReadAt",
];
const UPSERT_FIELDS = new Set(["title", "customTitle", "totalPages"]);
const POSITION_FIELDS = new Set(["currentPage", "scrollTop"]);

export class BooksStorageDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "BooksStorageDataError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonicalFileUrl(value) {
  if (typeof value !== "string") {
    throw new TypeError("book URL must be a string");
  }

  try {
    return canonicalizeLocalPdfUrl(value).href;
  } catch {
    throw new TypeError("book URL must be a valid local file:// PDF URL");
  }
}

function ownDataEntries(value, allowedFields, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) {
    throw new TypeError(`${label} must include at least one field`);
  }

  return keys.map((key) => {
    if (typeof key !== "string" || !allowedFields.has(key)) {
      throw new TypeError(`${label} contains an unexpected field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!("value" in descriptor)) {
      throw new TypeError(`${label} fields must be data properties`);
    }
    return [key, descriptor.value];
  });
}

function validateTitle(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
}

function validateCustomTitle(value) {
  if (value !== null && typeof value !== "string") {
    throw new TypeError("customTitle must be a string or null");
  }
}

function validateTotalPages(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("totalPages must be a non-negative integer");
  }
}

function validateCurrentPage(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("currentPage must be a positive integer");
  }
}

function validateScrollTop(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("scrollTop must be a finite non-negative number");
  }
}

function validateTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer timestamp`);
  }
}

function validateField(field, value) {
  switch (field) {
    case "title":
      validateTitle(value, field);
      break;
    case "customTitle":
      validateCustomTitle(value);
      break;
    case "totalPages":
      validateTotalPages(value);
      break;
    case "currentPage":
      validateCurrentPage(value);
      break;
    case "scrollTop":
      validateScrollTop(value);
      break;
    case "addedAt":
    case "lastReadAt":
      validateTimestamp(value, field);
      break;
    default:
      throw new TypeError(`unexpected book field: ${field}`);
  }
}

function validatePageRange(record) {
  if (record.totalPages > 0 && record.currentPage > record.totalPages) {
    throw new TypeError("currentPage must not exceed totalPages");
  }
}

function validateRecord(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("book record must be a plain object");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== RECORD_FIELDS.length ||
    keys.some((key) => typeof key !== "string" || !RECORD_FIELDS.includes(key))
  ) {
    throw new TypeError("book record must contain exactly the supported fields");
  }

  const record = {};
  for (const field of RECORD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("book record fields must be own data properties");
    }
    validateField(field, descriptor.value);
    record[field] = descriptor.value;
  }
  validatePageRange(record);
  if (record.lastReadAt < record.addedAt) {
    throw new TypeError("lastReadAt must not precede addedAt");
  }
  return record;
}

function validateUpsertPatch(patch) {
  const entries = ownDataEntries(patch, UPSERT_FIELDS, "book patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return Object.fromEntries(entries);
}

function validatePositionPatch(patch) {
  const entries = ownDataEntries(patch, POSITION_FIELDS, "position patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return Object.fromEntries(entries);
}

function readBooks(storageResult) {
  if (!isPlainObject(storageResult)) {
    throw new BooksStorageDataError("stored books response must be an object");
  }
  if (!Object.hasOwn(storageResult, BOOKS_KEY)) {
    return {};
  }

  const storedBooks = storageResult[BOOKS_KEY];
  if (!isPlainObject(storedBooks)) {
    throw new BooksStorageDataError("stored books must be a plain object");
  }

  const books = {};
  try {
    for (const key of Reflect.ownKeys(storedBooks)) {
      if (typeof key !== "string" || canonicalFileUrl(key) !== key) {
        throw new TypeError("book key must be a canonical local PDF URL");
      }
      Object.defineProperty(books, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: validateRecord(storedBooks[key]),
      });
    }
  } catch (error) {
    throw new BooksStorageDataError(`stored books are malformed: ${error.message}`);
  }
  return books;
}

function currentTimestamp(now) {
  const timestamp = now();
  validateTimestamp(timestamp, "current time");
  return timestamp;
}

export function createBooksStorage({
  storageArea,
  lockManager,
  now = () => Math.floor(Date.now() / 1000),
  createLockTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("a chrome.storage.local-compatible storage area is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof createLockTimeoutSignal !== "function") {
    throw new TypeError("createLockTimeoutSignal must be a function");
  }

  async function loadBooks() {
    return readBooks(await storageArea.get(BOOKS_KEY));
  }

  async function mutate(operation) {
    if (!lockManager || typeof lockManager.request !== "function") {
      throw new Error("book mutations require the cross-context Web Locks API");
    }
    const signal = createLockTimeoutSignal(BOOKS_LOCK_TIMEOUT_MILLISECONDS);
    return lockManager.request(BOOKS_LOCK, { signal }, operation);
  }

  return Object.freeze({
    async getBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const books = await loadBooks();
      return clone(books[canonicalUrl]);
    },

    async listBooks() {
      const books = await loadBooks();
      return Object.keys(books)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((fileUrl) => ({ fileUrl, book: clone(books[fileUrl]) }));
    },

    async upsertBook(fileUrl, patch) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validateUpsertPatch(patch);
      return mutate(async () => {
        const books = await loadBooks();
        const timestamp = currentTimestamp(now);
        const existing = books[canonicalUrl];
        const updated = existing
          ? { ...existing, ...validPatch }
          : {
              title: "",
              customTitle: null,
              totalPages: 0,
              currentPage: 1,
              scrollTop: 0,
              addedAt: timestamp,
              lastReadAt: timestamp,
              ...validPatch,
            };
        validatePageRange(updated);
        books[canonicalUrl] = updated;
        await storageArea.set({ [BOOKS_KEY]: books });
        return clone(updated);
      });
    },

    async removeBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      return mutate(async () => {
        const books = await loadBooks();
        if (!Object.hasOwn(books, canonicalUrl)) {
          return false;
        }
        delete books[canonicalUrl];
        await storageArea.set({ [BOOKS_KEY]: books });
        return true;
      });
    },

    async updatePosition(fileUrl, patch) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validatePositionPatch(patch);
      return mutate(async () => {
        const books = await loadBooks();
        const existing = books[canonicalUrl];
        if (!existing) {
          return undefined;
        }
        const updated = {
          ...existing,
          ...validPatch,
          lastReadAt: Math.max(existing.lastReadAt, currentTimestamp(now)),
        };
        validatePageRange(updated);
        books[canonicalUrl] = updated;
        await storageArea.set({ [BOOKS_KEY]: books });
        return clone(updated);
      });
    },
  });
}

function defaultStorage() {
  return createBooksStorage({
    storageArea: globalThis.chrome?.storage?.local,
    lockManager: globalThis.navigator?.locks,
  });
}

export async function getBook(fileUrl) {
  return defaultStorage().getBook(fileUrl);
}

export async function upsertBook(fileUrl, patch) {
  return defaultStorage().upsertBook(fileUrl, patch);
}

export async function removeBook(fileUrl) {
  return defaultStorage().removeBook(fileUrl);
}

export async function listBooks() {
  return defaultStorage().listBooks();
}

export async function updatePosition(fileUrl, patch) {
  return defaultStorage().updatePosition(fileUrl, patch);
}
