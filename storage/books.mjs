// @ts-check

import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";
import {
  validPositionObservation,
  validPositionObservationMetadata,
  validPositionTrackingGeneration,
} from "../shared/position-update-messaging.mjs";
import {
  isPlainObject,
  randomHexId,
  STORAGE_RESULT_STATUSES,
} from "../shared/strict-record.mjs";

/** @typedef {import("../types/storage.d.ts").BookRecord} BookRecord */
/** @typedef {import("../types/storage.d.ts").PositionObservation} PositionObservation */
/** @typedef {import("../types/storage.d.ts").PositionObservationMetadata} PositionObservationMetadata */
/** @typedef {import("../types/storage.d.ts").PositionOrderEntry} PositionOrderEntry */
/** @typedef {import("../types/storage.d.ts").PositionWinner} PositionWinner */
/** @typedef {import("../types/storage.d.ts").StorageMutationStatus} StorageMutationStatus */
/** @typedef {import("../types/storage.d.ts").ViewerHighWaterMark} ViewerHighWaterMark */
/** @typedef {Record<string, BookRecord>} BooksMap */
/** @typedef {Record<string, number>} CompletedBooksMap */
/** @typedef {{ book: BookRecord, completedAt: number | null }} BookWithCompletion */
/** @typedef {{ fileUrl: string, book: BookRecord, completedAt: number | null }} ListedBookWithCompletion */
/** @typedef {Record<string, unknown>} PositionOrderMap */
/** @typedef {Pick<BookRecord, "title">} TrackPatch */
/** @typedef {Partial<Pick<BookRecord, "title" | "customTitle" | "totalPages">>} UpsertPatch */
/** @typedef {Pick<BookRecord, "title" | "totalPages">} HydrationPatch */
/** @typedef {Partial<Pick<BookRecord, "currentPage" | "scrollTop">>} PositionPatch */
/** @typedef {{ book: BookRecord, trackingGeneration: string }} PositionTrackingState */
/** @typedef {{ legacy: PositionObservationMetadata, current?: undefined } | { legacy?: undefined, current: PositionOrderEntry }} RelevantPositionOrder */
/**
 * @typedef {{
 *   storageArea?: Pick<chrome.storage.StorageArea, "get" | "set">,
 *   lockManager?: Pick<LockManager, "request">,
 *   now?: () => number,
 *   nowMilliseconds?: () => number,
 *   createTrackingGeneration?: () => unknown,
 *   createLockTimeoutSignal?: (milliseconds: number) => AbortSignal,
 * }} BooksStorageDependencies
 */
/**
 * @typedef {{
 *   getBook(fileUrl: string): Promise<BookRecord | undefined>,
 *   getBookWithCompletion(fileUrl: string): Promise<BookWithCompletion | undefined>,
 *   listBooks(): Promise<Array<{ fileUrl: string, book: BookRecord }>>,
 *   listBooksWithCompletion(): Promise<ListedBookWithCompletion[]>,
 *   completeBook(fileUrl: string): Promise<BookWithCompletion | undefined>,
 *   markBookReading(fileUrl: string): Promise<BookWithCompletion | undefined>,
 *   getPositionTrackingState(fileUrl: string, viewerId: string): Promise<PositionTrackingState | undefined>,
 *   trackBook(fileUrl: string, patch: TrackPatch): Promise<BookRecord>,
 *   upsertBook(fileUrl: string, patch: UpsertPatch): Promise<BookRecord>,
 *   hydrateMetadata(fileUrl: string, patch: HydrationPatch, options?: { signal?: AbortSignal }): Promise<BookRecord | undefined>,
 *   updateCustomTitle(fileUrl: string, customTitle: string | null): Promise<BookRecord | undefined>,
 *   removeBook(fileUrl: string): Promise<boolean>,
 *   recordObservation(fileUrl: string, patch: PositionPatch, observation: PositionObservation): Promise<StorageMutationStatus>,
 * }} BooksStorage
 */

const BOOKS_KEY = "books";
const COMPLETED_BOOKS_KEY = "completedBooks";
const POSITION_ORDER_KEY = "positionOrder";
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
const TRACK_FIELDS = new Set(["title"]);
const UPSERT_FIELDS = new Set(["title", "customTitle", "totalPages"]);
const HYDRATION_FIELDS = new Set(["title", "totalPages"]);
const POSITION_FIELDS = new Set(["currentPage", "scrollTop"]);
const POSITION_ORDER_VERSION = 2;
const MAX_VIEWERS_PER_GENERATION = 64;
const POSITION_ORDER_FIELDS = ["version", "generation", "winner", "viewers"];
const POSITION_WINNER_FIELDS = ["effectiveTime", "viewerId", "sequence"];
const POSITION_VIEWER_FIELDS = ["effectiveTime", "sequence"];
const defaultNowSeconds = () => Math.floor(Date.now() / 1_000);
const defaultNowMilliseconds = () => Date.now();

export class BooksStorageDataError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "BooksStorageDataError";
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return /** @type {T} */ (
    value === undefined ? undefined : structuredClone(value)
  );
}

/** @param {unknown} value */
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

/**
 * @param {unknown} value
 * @param {ReadonlySet<string>} allowedFields
 * @param {string} label
 * @returns {Array<[string, unknown]>}
 */
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
    const descriptor = /** @type {PropertyDescriptor} */ (
      Object.getOwnPropertyDescriptor(value, key)
    );
    if (!("value" in descriptor)) {
      throw new TypeError(`${label} fields must be data properties`);
    }
    return [key, descriptor.value];
  });
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function validateTitle(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
}

/** @param {unknown} value */
function validateCustomTitle(value) {
  if (value !== null && typeof value !== "string") {
    throw new TypeError("customTitle must be a string or null");
  }
}

/** @param {unknown} value */
function validateTotalPages(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
    throw new TypeError("totalPages must be a non-negative integer");
  }
}

/** @param {unknown} value */
function validateCurrentPage(value) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) {
    throw new TypeError("currentPage must be a positive integer");
  }
}

/** @param {unknown} value */
function validateScrollTop(value) {
  if (!Number.isFinite(value) || /** @type {number} */ (value) < 0) {
    throw new TypeError("scrollTop must be a finite non-negative number");
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function validateTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new TypeError(`${field} must be a non-negative integer timestamp`);
  }
}

/**
 * @param {string} field
 * @param {unknown} value
 */
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

/** @param {BookRecord} record */
function validatePageRange(record) {
  if (record.currentPage > record.totalPages) {
    throw new TypeError("currentPage must not exceed totalPages");
  }
}

/**
 * @param {unknown} value
 * @returns {BookRecord}
 */
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

  /** @type {Record<string, unknown>} */
  const record = {};
  for (const field of RECORD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("book record fields must be own data properties");
    }
    validateField(field, descriptor.value);
    record[field] = descriptor.value;
  }
  if (
    /** @type {number} */ (record.lastReadAt) <
    /** @type {number} */ (record.addedAt)
  ) {
    throw new TypeError("lastReadAt must not precede addedAt");
  }
  return /** @type {BookRecord} */ (/** @type {unknown} */ (record));
}

/**
 * @param {unknown} patch
 * @returns {TrackPatch}
 */
function validateTrackPatch(patch) {
  const entries = ownDataEntries(patch, TRACK_FIELDS, "initial book patch");
  if (entries.length !== 1 || entries[0][0] !== "title") {
    throw new TypeError("initial book patch must include only title");
  }
  validateTitle(entries[0][1], "title");
  return { title: /** @type {string} */ (entries[0][1]) };
}

/**
 * @param {unknown} patch
 * @returns {UpsertPatch}
 */
function validateUpsertPatch(patch) {
  const entries = ownDataEntries(patch, UPSERT_FIELDS, "book patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return /** @type {UpsertPatch} */ (Object.fromEntries(entries));
}

/**
 * @param {unknown} patch
 * @returns {HydrationPatch}
 */
function validateHydrationPatch(patch) {
  const entries = ownDataEntries(patch, HYDRATION_FIELDS, "metadata patch");
  if (entries.length !== HYDRATION_FIELDS.size) {
    throw new TypeError("metadata patch must include title and totalPages");
  }
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  const validPatch = /** @type {HydrationPatch} */ (
    Object.fromEntries(entries)
  );
  if (validPatch.totalPages === 0) {
    throw new TypeError("hydrated totalPages must be positive");
  }
  return validPatch;
}

/**
 * @param {unknown} patch
 * @returns {PositionPatch}
 */
function validatePositionPatch(patch) {
  const entries = ownDataEntries(patch, POSITION_FIELDS, "position patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return /** @type {PositionPatch} */ (Object.fromEntries(entries));
}

/** @param {unknown} signal */
function validateAbortSignal(signal) {
  if (
    signal !== undefined &&
    (!signal ||
      typeof /** @type {{ aborted?: unknown }} */ (signal).aborted !==
        "boolean" ||
      typeof /** @type {{ addEventListener?: unknown }} */ (signal)
        .addEventListener !== "function")
  ) {
    throw new TypeError("metadata hydration signal must be an AbortSignal");
  }
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fields
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function ownStoredObject(value, fields, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    throw new TypeError(`${label} must contain exactly the supported fields`);
  }
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`${label} fields must be own data properties`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

/** @param {unknown} value */
function validateEffectiveTime(value) {
  if (
    !Number.isSafeInteger(/** @type {number} */ (value)) ||
    /** @type {number} */ (value) < 0
  ) {
    throw new TypeError("position effectiveTime must be a non-negative safe integer");
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value */
function validateViewerId(value) {
  return validPositionObservationMetadata({
    viewerId: value,
    sequence: 1,
    observedAt: 0,
  }).viewerId;
}

/**
 * @param {unknown} value
 * @returns {ViewerHighWaterMark}
 */
function validatePositionViewer(value) {
  const viewer = ownStoredObject(
    value,
    POSITION_VIEWER_FIELDS,
    "position viewer order",
  );
  if (
    !Number.isSafeInteger(/** @type {number} */ (viewer.sequence)) ||
    /** @type {number} */ (viewer.sequence) < 0
  ) {
    throw new TypeError("position viewer sequence must be a non-negative safe integer");
  }
  const effectiveTime = validateEffectiveTime(viewer.effectiveTime);
  if (viewer.sequence === 0 && effectiveTime !== 0) {
    throw new TypeError("registered position viewers must start at effectiveTime zero");
  }
  return {
    effectiveTime,
    sequence: /** @type {number} */ (viewer.sequence),
  };
}

/**
 * @param {unknown} value
 * @returns {PositionWinner | null}
 */
function validatePositionWinner(value) {
  if (value === null) {
    return null;
  }
  const winner = ownStoredObject(
    value,
    POSITION_WINNER_FIELDS,
    "position order winner",
  );
  const effectiveTime = validateEffectiveTime(winner.effectiveTime);
  if (winner.viewerId === null) {
    if (winner.sequence !== 0) {
      throw new TypeError("unordered position winners must use sequence zero");
    }
    return { effectiveTime, viewerId: null, sequence: 0 };
  }
  const viewerId = validateViewerId(winner.viewerId);
  if (
    !Number.isSafeInteger(/** @type {number} */ (winner.sequence)) ||
    /** @type {number} */ (winner.sequence) < 1
  ) {
    throw new TypeError("observed position winners must use a positive sequence");
  }
  return {
    effectiveTime,
    viewerId,
    sequence: /** @type {number} */ (winner.sequence),
  };
}

/**
 * @param {unknown} value
 * @returns {PositionOrderEntry}
 */
function validateCurrentPositionOrder(value) {
  const order = ownStoredObject(
    value,
    POSITION_ORDER_FIELDS,
    "position order entry",
  );
  if (order.version !== POSITION_ORDER_VERSION) {
    throw new TypeError("position order version is unsupported");
  }
  const generation = validPositionTrackingGeneration(order.generation);
  const winner = validatePositionWinner(order.winner);
  if (!isPlainObject(order.viewers)) {
    throw new TypeError("position order viewers must be a plain object");
  }
  const viewerKeys = Reflect.ownKeys(order.viewers);
  if (viewerKeys.length > MAX_VIEWERS_PER_GENERATION) {
    throw new TypeError("position order has too many viewers");
  }
  /** @type {Record<string, ViewerHighWaterMark>} */
  const viewers = {};
  for (const key of viewerKeys) {
    if (typeof key !== "string") {
      throw new TypeError("position order viewer IDs must be strings");
    }
    const viewerId = validateViewerId(key);
    const descriptor = Object.getOwnPropertyDescriptor(order.viewers, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("position order viewers must be own data properties");
    }
    Object.defineProperty(viewers, viewerId, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: validatePositionViewer(descriptor.value),
    });
  }
  if (winner && winner.viewerId !== null) {
    const winningViewer = viewers[winner.viewerId];
    if (
      !winningViewer ||
      winningViewer.sequence !== winner.sequence ||
      winningViewer.effectiveTime !== winner.effectiveTime
    ) {
      throw new TypeError("position order winner must match its viewer high-water mark");
    }
  }
  const observedViewerWinners = Object.entries(viewers)
    .filter(([, viewer]) => viewer.sequence > 0)
    .map(([viewerId, viewer]) => ({
      effectiveTime: viewer.effectiveTime,
      viewerId,
      sequence: viewer.sequence,
    }));
  if (!winner && observedViewerWinners.length > 0) {
    throw new TypeError("null position order winner requires only initial viewers");
  }
  if (
    winner &&
    observedViewerWinners.some(
      (viewerWinner) => comparePositionWinners(winner, viewerWinner) < 0,
    )
  ) {
    throw new TypeError("position order winner must dominate every viewer high-water mark");
  }
  return {
    version: POSITION_ORDER_VERSION,
    generation,
    winner,
    viewers,
  };
}

/** @param {unknown} value */
function isLegacyPositionOrder(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 3 &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        ["viewerId", "sequence", "observedAt"].includes(key),
    )
  );
}

/**
 * @param {unknown} storageResult
 * @returns {PositionOrderMap}
 */
function readPositionOrder(storageResult) {
  if (!isPlainObject(storageResult)) {
    throw new BooksStorageDataError("stored position order response must be an object");
  }
  if (!Object.hasOwn(storageResult, POSITION_ORDER_KEY)) {
    return {};
  }
  const storedPositionOrder = storageResult[POSITION_ORDER_KEY];
  if (!isPlainObject(storedPositionOrder)) {
    throw new BooksStorageDataError("stored position order must be a plain object");
  }

  /** @type {PositionOrderMap} */
  const positionOrder = {};
  for (const key of Reflect.ownKeys(storedPositionOrder)) {
    const descriptor = Object.getOwnPropertyDescriptor(storedPositionOrder, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
      throw new BooksStorageDataError(
        "stored position order entries must be own string data properties",
      );
    }
    Object.defineProperty(positionOrder, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: descriptor.value,
    });
  }
  return positionOrder;
}

/**
 * @param {PositionOrderMap} positionOrder
 * @param {string} canonicalUrl
 * @returns {RelevantPositionOrder | undefined}
 */
function readRelevantPositionOrder(positionOrder, canonicalUrl) {
  if (!Object.hasOwn(positionOrder, canonicalUrl)) {
    return undefined;
  }
  try {
    const value = positionOrder[canonicalUrl];
    return isLegacyPositionOrder(value)
      ? { legacy: validPositionObservationMetadata(value) }
      : { current: validateCurrentPositionOrder(value) };
  } catch (error) {
    throw new BooksStorageDataError(
      `stored position order for ${canonicalUrl} is malformed: ${/** @type {Error} */ (error).message}`,
    );
  }
}

/**
 * @param {unknown} generation
 * @returns {PositionOrderEntry}
 */
function createPositionOrder(generation) {
  return {
    version: POSITION_ORDER_VERSION,
    generation: validPositionTrackingGeneration(generation),
    winner: null,
    viewers: {},
  };
}

/**
 * @param {PositionObservationMetadata} observation
 * @param {string} generation
 * @returns {PositionOrderEntry}
 */
function migratePositionOrder(observation, generation) {
  const state = createPositionOrder(generation);
  state.viewers[observation.viewerId] = {
    effectiveTime: observation.observedAt,
    sequence: observation.sequence,
  };
  state.winner = {
    effectiveTime: observation.observedAt,
    viewerId: observation.viewerId,
    sequence: observation.sequence,
  };
  return state;
}

/**
 * @param {PositionWinner} left
 * @param {PositionWinner} right
 */
function comparePositionWinners(left, right) {
  if (left.effectiveTime !== right.effectiveTime) {
    return left.effectiveTime < right.effectiveTime ? -1 : 1;
  }
  if (left.viewerId === right.viewerId) {
    return left.sequence === right.sequence
      ? 0
      : left.sequence < right.sequence
        ? -1
        : 1;
  }
  if (left.viewerId === null) {
    return 1;
  }
  if (right.viewerId === null) {
    return -1;
  }
  return left.viewerId < right.viewerId ? -1 : 1;
}

/**
 * @param {unknown} storageResult
 * @returns {CompletedBooksMap}
 */
function readCompletedBooks(storageResult) {
  if (!isPlainObject(storageResult)) {
    throw new BooksStorageDataError("stored completed books response must be an object");
  }
  if (!Object.hasOwn(storageResult, COMPLETED_BOOKS_KEY)) {
    return {};
  }

  const storedCompletedBooks = storageResult[COMPLETED_BOOKS_KEY];
  if (!isPlainObject(storedCompletedBooks)) {
    throw new BooksStorageDataError("stored completed books must be a plain object");
  }

  /** @type {CompletedBooksMap} */
  const completedBooks = {};
  try {
    for (const key of Reflect.ownKeys(storedCompletedBooks)) {
      const descriptor = Object.getOwnPropertyDescriptor(storedCompletedBooks, key);
      if (
        typeof key !== "string" ||
        canonicalFileUrl(key) !== key ||
        !descriptor ||
        !("value" in descriptor)
      ) {
        throw new TypeError("completed book entries must use canonical URL data properties");
      }
      validateTimestamp(descriptor.value, "completedAt");
      completedBooks[key] = /** @type {number} */ (descriptor.value);
    }
  } catch (error) {
    throw new BooksStorageDataError(
      `stored completed books are malformed: ${/** @type {Error} */ (error).message}`,
    );
  }
  return completedBooks;
}

/**
 * @param {BooksMap} books
 * @param {CompletedBooksMap} completedBooks
 */
function validateCompletedBooksBelongToLibrary(books, completedBooks) {
  if (Object.keys(completedBooks).some((fileUrl) => !Object.hasOwn(books, fileUrl))) {
    throw new BooksStorageDataError("completed books must still be tracked");
  }
}

/**
 * @param {unknown} storageResult
 * @returns {BooksMap}
 */
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

  /** @type {BooksMap} */
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
    throw new BooksStorageDataError(
      `stored books are malformed: ${/** @type {Error} */ (error).message}`,
    );
  }
  return books;
}

/** @param {() => number} now */
function currentTimestamp(now) {
  const timestamp = now();
  validateTimestamp(timestamp, "current time");
  return timestamp;
}

/** @param {() => number} nowMilliseconds */
function currentMilliseconds(nowMilliseconds) {
  const timestamp = nowMilliseconds();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "current time must be a non-negative integer Unix millisecond timestamp",
    );
  }
  return timestamp;
}

/** @returns {string} */
function randomTrackingGeneration() {
  return randomHexId("position tracking generations require crypto.getRandomValues");
}

/**
 * @param {RelevantPositionOrder | undefined} relevantOrder
 * @param {string} generation
 * @returns {PositionOrderEntry}
 */
function positionOrderFrom(relevantOrder, generation) {
  if (relevantOrder?.current) {
    return relevantOrder.current;
  }
  return relevantOrder?.legacy
    ? migratePositionOrder(relevantOrder.legacy, generation)
    : createPositionOrder(generation);
}

/**
 * @param {PositionOrderEntry} positionOrder
 * @param {string} viewerId
 */
function registerPositionViewer(positionOrder, viewerId) {
  if (Object.hasOwn(positionOrder.viewers, viewerId)) {
    return true;
  }
  if (
    Object.keys(positionOrder.viewers).length >= MAX_VIEWERS_PER_GENERATION
  ) {
    return false;
  }
  positionOrder.viewers[viewerId] = { effectiveTime: 0, sequence: 0 };
  return true;
}

/**
 * @param {number} timestamp
 * @param {UpsertPatch} patch
 * @returns {BookRecord}
 */
function createInitialRecord(timestamp, patch) {
  return {
    title: "",
    customTitle: null,
    totalPages: 0,
    currentPage: 1,
    scrollTop: 0,
    addedAt: timestamp,
    lastReadAt: timestamp,
    ...patch,
  };
}

/**
 * @param {BooksStorageDependencies} [dependencies]
 * @returns {BooksStorage}
 */
export function createBooksStorage({
  storageArea,
  lockManager,
  now = defaultNowSeconds,
  nowMilliseconds,
  createTrackingGeneration = randomTrackingGeneration,
  createLockTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  if (!storageArea || typeof storageArea.get !== "function" || typeof storageArea.set !== "function") {
    throw new TypeError("a chrome.storage.local-compatible storage area is required");
  }
  if (
    typeof now !== "function" ||
    (nowMilliseconds !== undefined && typeof nowMilliseconds !== "function")
  ) {
    throw new TypeError("book storage clocks must be functions");
  }
  const millisecondsNow =
    nowMilliseconds ??
    (now === defaultNowSeconds
      ? defaultNowMilliseconds
      : () => now() * 1_000 + 999);
  if (typeof createTrackingGeneration !== "function") {
    throw new TypeError("createTrackingGeneration must be a function");
  }
  if (typeof createLockTimeoutSignal !== "function") {
    throw new TypeError("createLockTimeoutSignal must be a function");
  }

  async function loadBooks() {
    return readBooks(
      await /** @type {NonNullable<typeof storageArea>} */ (storageArea).get(
        BOOKS_KEY,
      ),
    );
  }

  async function loadBooksWithCompletion() {
    const stored = await /** @type {NonNullable<typeof storageArea>} */ (
      storageArea
    ).get([BOOKS_KEY, COMPLETED_BOOKS_KEY]);
    const books = readBooks(stored);
    const completedBooks = readCompletedBooks(stored);
    validateCompletedBooksBelongToLibrary(books, completedBooks);
    return { books, completedBooks };
  }

  async function loadOrderedState() {
    const stored = await /** @type {NonNullable<typeof storageArea>} */ (
      storageArea
    ).get([BOOKS_KEY, POSITION_ORDER_KEY]);
    return {
      books: readBooks(stored),
      positionOrder: readPositionOrder(stored),
    };
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async function mutate(operation) {
    if (!lockManager || typeof lockManager.request !== "function") {
      throw new Error("book mutations require the cross-context Web Locks API");
    }
    const signal = createLockTimeoutSignal(BOOKS_LOCK_TIMEOUT_MILLISECONDS);
    return lockManager.request(BOOKS_LOCK, { signal }, operation);
  }

  /** @param {string | undefined} [previousGeneration] */
  function newTrackingGeneration(previousGeneration) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generation = validPositionTrackingGeneration(
        createTrackingGeneration(),
      );
      if (generation !== previousGeneration) {
        return generation;
      }
    }
    throw new Error("unable to create a distinct position tracking generation");
  }

  /**
   * @param {{
   *   canonicalUrl: string,
   *   patch: PositionPatch,
   *   observation: PositionObservationMetadata,
   *   requireRegisteredViewer: boolean,
   *   trackingGeneration?: string,
   * }} mutation
   * @returns {Promise<StorageMutationStatus>}
   */
  async function mutatePositionObservation({
    canonicalUrl,
    patch,
    observation,
    requireRegisteredViewer,
    trackingGeneration,
  }) {
    const observedTimestamp = Math.floor(observation.observedAt / 1_000);

    return mutate(async () => {
      const { books, positionOrder } = await loadOrderedState();
      const relevantOrder = readRelevantPositionOrder(
        positionOrder,
        canonicalUrl,
      );
      const existing = books[canonicalUrl];
      if (!existing) {
        return STORAGE_RESULT_STATUSES.missing;
      }

      let currentOrder;
      if (requireRegisteredViewer) {
        if (!relevantOrder?.current) {
          return STORAGE_RESULT_STATUSES.stale;
        }
        currentOrder = relevantOrder.current;
      } else {
        if (
          relevantOrder?.current &&
          relevantOrder.current.generation !== trackingGeneration
        ) {
          return STORAGE_RESULT_STATUSES.stale;
        }
        currentOrder = positionOrderFrom(
          relevantOrder,
          /** @type {string} */ (trackingGeneration),
        );
      }

      const viewerOrder = currentOrder.viewers[observation.viewerId];
      if (requireRegisteredViewer && !viewerOrder) {
        return STORAGE_RESULT_STATUSES.stale;
      }
      if (viewerOrder && observation.sequence <= viewerOrder.sequence) {
        return STORAGE_RESULT_STATUSES.stale;
      }
      if (!viewerOrder) {
        if (observation.observedAt > currentMilliseconds(millisecondsNow)) {
          return STORAGE_RESULT_STATUSES.invalid;
        }
        if (!registerPositionViewer(currentOrder, observation.viewerId)) {
          return STORAGE_RESULT_STATUSES.stale;
        }
      }
      if (
        !relevantOrder?.current &&
        observedTimestamp < existing.lastReadAt
      ) {
        return STORAGE_RESULT_STATUSES.stale;
      }

      const effectiveTime = Math.max(
        viewerOrder?.effectiveTime ?? 0,
        observation.observedAt,
      );
      const candidate = {
        effectiveTime,
        viewerId: observation.viewerId,
        sequence: observation.sequence,
      };
      currentOrder.viewers[observation.viewerId] = {
        effectiveTime,
        sequence: observation.sequence,
      };
      positionOrder[canonicalUrl] = currentOrder;

      if (
        currentOrder.winner &&
        comparePositionWinners(candidate, currentOrder.winner) <= 0
      ) {
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [POSITION_ORDER_KEY]: positionOrder,
        });
        return STORAGE_RESULT_STATUSES.stale;
      }

      currentOrder.winner = candidate;
      books[canonicalUrl] = {
        ...existing,
        ...patch,
        lastReadAt: Math.max(existing.lastReadAt, observedTimestamp),
      };
      await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
        [BOOKS_KEY]: books,
        [POSITION_ORDER_KEY]: positionOrder,
      });
      return STORAGE_RESULT_STATUSES.updated;
    });
  }

  return Object.freeze({
    async getBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const books = await loadBooks();
      return clone(books[canonicalUrl]);
    },

    async getBookWithCompletion(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const { books, completedBooks } = await loadBooksWithCompletion();
      const book = books[canonicalUrl];
      return book
        ? { book: clone(book), completedAt: completedBooks[canonicalUrl] ?? null }
        : undefined;
    },

    async listBooks() {
      const books = await loadBooks();
      return Object.keys(books)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((fileUrl) => ({ fileUrl, book: clone(books[fileUrl]) }));
    },

    async listBooksWithCompletion() {
      const { books, completedBooks } = await loadBooksWithCompletion();
      return Object.keys(books)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((fileUrl) => ({
          fileUrl,
          book: clone(books[fileUrl]),
          completedAt: completedBooks[fileUrl] ?? null,
        }));
    },

    async completeBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      return mutate(async () => {
        const { books, completedBooks } = await loadBooksWithCompletion();
        const book = books[canonicalUrl];
        if (!book) {
          return undefined;
        }
        if (Object.hasOwn(completedBooks, canonicalUrl)) {
          return { book: clone(book), completedAt: completedBooks[canonicalUrl] };
        }
        if (book.totalPages === 0 || book.currentPage !== book.totalPages) {
          throw new RangeError("book must be on its known final page to be completed");
        }
        const completedAt = currentTimestamp(now);
        completedBooks[canonicalUrl] = completedAt;
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [COMPLETED_BOOKS_KEY]: completedBooks,
        });
        return { book: clone(book), completedAt };
      });
    },

    async markBookReading(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      return mutate(async () => {
        const { books, completedBooks } = await loadBooksWithCompletion();
        const book = books[canonicalUrl];
        if (!book) {
          return undefined;
        }
        if (!Object.hasOwn(completedBooks, canonicalUrl)) {
          return { book: clone(book), completedAt: null };
        }
        delete completedBooks[canonicalUrl];
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [COMPLETED_BOOKS_KEY]: completedBooks,
        });
        return { book: clone(book), completedAt: null };
      });
    },

    async getPositionTrackingState(fileUrl, viewerId) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validViewerId = validateViewerId(viewerId);
      return mutate(async () => {
        const { books, positionOrder } = await loadOrderedState();
        const relevantOrder = readRelevantPositionOrder(
          positionOrder,
          canonicalUrl,
        );
        const existing = books[canonicalUrl];
        if (!existing) {
          return undefined;
        }

        let currentOrder;
        let changed = false;
        if (relevantOrder?.current) {
          currentOrder = relevantOrder.current;
          if (
            !Object.hasOwn(currentOrder.viewers, validViewerId) &&
            Object.keys(currentOrder.viewers).length >=
              MAX_VIEWERS_PER_GENERATION
          ) {
            const previousWinner = currentOrder.winner;
            currentOrder = createPositionOrder(
              newTrackingGeneration(currentOrder.generation),
            );
            if (previousWinner) {
              currentOrder.winner = {
                effectiveTime: previousWinner.effectiveTime,
                viewerId: null,
                sequence: 0,
              };
            }
            changed = true;
          }
        } else {
          currentOrder = positionOrderFrom(
            relevantOrder,
            newTrackingGeneration(),
          );
          changed = true;
        }
        if (!Object.hasOwn(currentOrder.viewers, validViewerId)) {
          registerPositionViewer(currentOrder, validViewerId);
          changed = true;
        }
        if (changed) {
          positionOrder[canonicalUrl] = currentOrder;
          await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
            [POSITION_ORDER_KEY]: positionOrder,
          });
        }
        return {
          book: clone(existing),
          trackingGeneration: currentOrder.generation,
        };
      });
    },

    async trackBook(fileUrl, patch) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validateTrackPatch(patch);
      return mutate(async () => {
        const { books, positionOrder } = await loadOrderedState();
        const relevantOrder = readRelevantPositionOrder(
          positionOrder,
          canonicalUrl,
        );
        const existing = books[canonicalUrl];
        if (existing) {
          return clone(existing);
        }
        const timestamp = currentTimestamp(now);
        const created = createInitialRecord(timestamp, validPatch);
        positionOrder[canonicalUrl] = createPositionOrder(
          newTrackingGeneration(relevantOrder?.current?.generation),
        );
        books[canonicalUrl] = created;
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [BOOKS_KEY]: books,
          [POSITION_ORDER_KEY]: positionOrder,
        });
        return clone(created);
      });
    },

    async upsertBook(fileUrl, patch) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validateUpsertPatch(patch);
      return mutate(async () => {
        const { books, positionOrder } = await loadOrderedState();
        const relevantOrder = readRelevantPositionOrder(
          positionOrder,
          canonicalUrl,
        );
        const timestamp = currentTimestamp(now);
        const existing = books[canonicalUrl];
        const updated = existing
          ? { ...existing, ...validPatch }
          : createInitialRecord(timestamp, validPatch);
        if (existing && Object.hasOwn(validPatch, "totalPages")) {
          validatePageRange(updated);
        }
        books[canonicalUrl] = updated;
        if (existing) {
          await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
            [BOOKS_KEY]: books,
          });
        } else {
          positionOrder[canonicalUrl] = createPositionOrder(
            newTrackingGeneration(relevantOrder?.current?.generation),
          );
          await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
            [BOOKS_KEY]: books,
            [POSITION_ORDER_KEY]: positionOrder,
          });
        }
        return clone(updated);
      });
    },

    async hydrateMetadata(fileUrl, patch, { signal } = {}) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validateHydrationPatch(patch);
      validateAbortSignal(signal);
      return mutate(async () => {
        const books = await loadBooks();
        const existing = books[canonicalUrl];
        if (signal?.aborted || !existing) {
          return undefined;
        }
        if (existing.totalPages !== 0) {
          return clone(existing);
        }
        const updated = { ...existing, ...validPatch };
        if (signal?.aborted) {
          return undefined;
        }
        books[canonicalUrl] = updated;
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [BOOKS_KEY]: books,
        });
        return clone(updated);
      });
    },

    async updateCustomTitle(fileUrl, customTitle) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      validateCustomTitle(customTitle);
      return mutate(async () => {
        const books = await loadBooks();
        const existing = books[canonicalUrl];
        if (!existing) {
          return undefined;
        }
        const updated = { ...existing, customTitle };
        books[canonicalUrl] = updated;
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [BOOKS_KEY]: books,
        });
        return clone(updated);
      });
    },

    async removeBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      return mutate(async () => {
        const stored = await /** @type {NonNullable<typeof storageArea>} */ (
          storageArea
        ).get([BOOKS_KEY, COMPLETED_BOOKS_KEY, POSITION_ORDER_KEY]);
        const books = readBooks(stored);
        const completedBooks = readCompletedBooks(stored);
        validateCompletedBooksBelongToLibrary(books, completedBooks);
        const positionOrder = readPositionOrder(stored);
        readRelevantPositionOrder(positionOrder, canonicalUrl);
        if (!Object.hasOwn(books, canonicalUrl)) {
          return false;
        }
        const hadCompletion = Object.hasOwn(completedBooks, canonicalUrl);
        const hadPositionOrder = Object.hasOwn(positionOrder, canonicalUrl);
        delete books[canonicalUrl];
        delete completedBooks[canonicalUrl];
        delete positionOrder[canonicalUrl];
        await /** @type {NonNullable<typeof storageArea>} */ (storageArea).set({
          [BOOKS_KEY]: books,
          ...(hadCompletion ? { [COMPLETED_BOOKS_KEY]: completedBooks } : {}),
          ...(hadPositionOrder ? { [POSITION_ORDER_KEY]: positionOrder } : {}),
        });
        return true;
      });
    },

    async recordObservation(fileUrl, patch, observation) {
      const recordedObservation = validPositionObservation(observation);
      const observationMetadata = {
        viewerId: recordedObservation.viewerId,
        sequence: recordedObservation.sequence,
        observedAt: recordedObservation.observedAt,
      };
      return mutatePositionObservation({
        canonicalUrl: canonicalFileUrl(fileUrl),
        patch: validatePositionPatch(patch),
        observation: observationMetadata,
        requireRegisteredViewer: recordedObservation.intent === "pending",
        ...(recordedObservation.intent === "registered"
          ? { trackingGeneration: recordedObservation.trackingGeneration }
          : {}),
      });
    },

  });
}

/** @returns {BooksStorage} */
function defaultStorage() {
  return createBooksStorage({
    storageArea: globalThis.chrome?.storage?.local,
    lockManager: globalThis.navigator?.locks,
  });
}

/** @param {string} fileUrl */
export async function getBook(fileUrl) {
  return defaultStorage().getBook(fileUrl);
}

/** @param {string} fileUrl */
export async function getBookWithCompletion(fileUrl) {
  return defaultStorage().getBookWithCompletion(fileUrl);
}

/**
 * @param {string} fileUrl
 * @param {string} viewerId
 */
export async function getPositionTrackingState(fileUrl, viewerId) {
  return defaultStorage().getPositionTrackingState(fileUrl, viewerId);
}

/**
 * @param {string} fileUrl
 * @param {TrackPatch} patch
 */
export async function trackBook(fileUrl, patch) {
  return defaultStorage().trackBook(fileUrl, patch);
}

/**
 * @param {string} fileUrl
 * @param {UpsertPatch} patch
 */
export async function upsertBook(fileUrl, patch) {
  return defaultStorage().upsertBook(fileUrl, patch);
}

/**
 * @param {string} fileUrl
 * @param {HydrationPatch} patch
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function hydrateMetadata(fileUrl, patch, options) {
  return defaultStorage().hydrateMetadata(fileUrl, patch, options);
}

/**
 * @param {string} fileUrl
 * @param {string | null} customTitle
 */
export async function updateCustomTitle(fileUrl, customTitle) {
  return defaultStorage().updateCustomTitle(fileUrl, customTitle);
}

/** @param {string} fileUrl */
export async function removeBook(fileUrl) {
  return defaultStorage().removeBook(fileUrl);
}

/** @returns {Promise<Array<{ fileUrl: string, book: BookRecord }>>} */
export async function listBooks() {
  return defaultStorage().listBooks();
}

export async function listBooksWithCompletion() {
  return defaultStorage().listBooksWithCompletion();
}

/** @param {string} fileUrl */
export async function completeBook(fileUrl) {
  return defaultStorage().completeBook(fileUrl);
}

/** @param {string} fileUrl */
export async function markBookReading(fileUrl) {
  return defaultStorage().markBookReading(fileUrl);
}

/**
 * @param {string} fileUrl
 * @param {PositionPatch} patch
 * @param {PositionObservation} observation
 */
export async function recordObservation(fileUrl, patch, observation) {
  return defaultStorage().recordObservation(fileUrl, patch, observation);
}
