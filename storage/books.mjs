import { canonicalizeLocalPdfUrl } from "../shared/local-pdf-url.mjs";
import {
  validPositionObservation,
  validPositionTrackingGeneration,
} from "../shared/position-update-messaging.mjs";

const BOOKS_KEY = "books";
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
const POSITION_OPTION_FIELDS = new Set(["observedAt"]);
const POSITION_ORDER_VERSION = 2;
const MAX_VIEWERS_PER_GENERATION = 64;
const POSITION_ORDER_FIELDS = ["version", "generation", "winner", "viewers"];
const POSITION_WINNER_FIELDS = ["effectiveTime", "viewerId", "sequence"];
const POSITION_VIEWER_FIELDS = ["effectiveTime", "sequence"];
const defaultNowSeconds = () => Math.floor(Date.now() / 1_000);
const defaultNowMilliseconds = () => Date.now();

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
  if (record.currentPage > record.totalPages) {
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
  if (record.lastReadAt < record.addedAt) {
    throw new TypeError("lastReadAt must not precede addedAt");
  }
  return record;
}

function validateTrackPatch(patch) {
  const entries = ownDataEntries(patch, TRACK_FIELDS, "initial book patch");
  if (entries.length !== 1 || entries[0][0] !== "title") {
    throw new TypeError("initial book patch must include only title");
  }
  validateTitle(entries[0][1], "title");
  return { title: entries[0][1] };
}

function validateUpsertPatch(patch) {
  const entries = ownDataEntries(patch, UPSERT_FIELDS, "book patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return Object.fromEntries(entries);
}

function validateHydrationPatch(patch) {
  const entries = ownDataEntries(patch, HYDRATION_FIELDS, "metadata patch");
  if (entries.length !== HYDRATION_FIELDS.size) {
    throw new TypeError("metadata patch must include title and totalPages");
  }
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  const validPatch = Object.fromEntries(entries);
  if (validPatch.totalPages === 0) {
    throw new TypeError("hydrated totalPages must be positive");
  }
  return validPatch;
}

function validatePositionPatch(patch) {
  const entries = ownDataEntries(patch, POSITION_FIELDS, "position patch");
  for (const [field, value] of entries) {
    validateField(field, value);
  }
  return Object.fromEntries(entries);
}

function validatePositionOptions(options) {
  if (options === undefined) {
    return undefined;
  }
  const entries = ownDataEntries(
    options,
    POSITION_OPTION_FIELDS,
    "position update options",
  );
  if (entries.length !== 1 || entries[0][0] !== "observedAt") {
    throw new TypeError("position update options must include only observedAt");
  }
  const observedAt = entries[0][1];
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new TypeError(
      "observedAt must be a non-negative integer Unix millisecond timestamp",
    );
  }
  return observedAt;
}

function validateAbortSignal(signal) {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) {
    throw new TypeError("metadata hydration signal must be an AbortSignal");
  }
}

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

function validateEffectiveTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("position effectiveTime must be a non-negative safe integer");
  }
  return value;
}

function validateViewerId(value) {
  return validPositionObservation({
    viewerId: value,
    sequence: 1,
    observedAt: 0,
  }).viewerId;
}

function validatePositionViewer(value) {
  const viewer = ownStoredObject(
    value,
    POSITION_VIEWER_FIELDS,
    "position viewer order",
  );
  if (!Number.isSafeInteger(viewer.sequence) || viewer.sequence < 0) {
    throw new TypeError("position viewer sequence must be a non-negative safe integer");
  }
  const effectiveTime = validateEffectiveTime(viewer.effectiveTime);
  if (viewer.sequence === 0 && effectiveTime !== 0) {
    throw new TypeError("registered position viewers must start at effectiveTime zero");
  }
  return {
    effectiveTime,
    sequence: viewer.sequence,
  };
}

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
  if (!Number.isSafeInteger(winner.sequence) || winner.sequence < 1) {
    throw new TypeError("observed position winners must use a positive sequence");
  }
  return { effectiveTime, viewerId, sequence: winner.sequence };
}

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

function readRelevantPositionOrder(positionOrder, canonicalUrl) {
  if (!Object.hasOwn(positionOrder, canonicalUrl)) {
    return undefined;
  }
  try {
    const value = positionOrder[canonicalUrl];
    return isLegacyPositionOrder(value)
      ? { legacy: validPositionObservation(value) }
      : { current: validateCurrentPositionOrder(value) };
  } catch (error) {
    throw new BooksStorageDataError(
      `stored position order for ${canonicalUrl} is malformed: ${error.message}`,
    );
  }
}

function createPositionOrder(generation) {
  return {
    version: POSITION_ORDER_VERSION,
    generation: validPositionTrackingGeneration(generation),
    winner: null,
    viewers: {},
  };
}

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

function currentMilliseconds(nowMilliseconds) {
  const timestamp = nowMilliseconds();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "current time must be a non-negative integer Unix millisecond timestamp",
    );
  }
  return timestamp;
}

function randomTrackingGeneration() {
  const values = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("position tracking generations require crypto.getRandomValues");
  }
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function positionOrderFrom(relevantOrder, generation) {
  if (relevantOrder?.current) {
    return relevantOrder.current;
  }
  return relevantOrder?.legacy
    ? migratePositionOrder(relevantOrder.legacy, generation)
    : createPositionOrder(generation);
}

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
    return readBooks(await storageArea.get(BOOKS_KEY));
  }

  async function loadOrderedState() {
    const stored = await storageArea.get([BOOKS_KEY, POSITION_ORDER_KEY]);
    return {
      books: readBooks(stored),
      positionOrder: readPositionOrder(stored),
    };
  }

  async function mutate(operation) {
    if (!lockManager || typeof lockManager.request !== "function") {
      throw new Error("book mutations require the cross-context Web Locks API");
    }
    const signal = createLockTimeoutSignal(BOOKS_LOCK_TIMEOUT_MILLISECONDS);
    return lockManager.request(BOOKS_LOCK, { signal }, operation);
  }

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
        return "missing";
      }

      let currentOrder;
      if (requireRegisteredViewer) {
        if (!relevantOrder?.current) {
          return "stale";
        }
        currentOrder = relevantOrder.current;
      } else {
        if (
          relevantOrder?.current &&
          relevantOrder.current.generation !== trackingGeneration
        ) {
          return "stale";
        }
        currentOrder = positionOrderFrom(relevantOrder, trackingGeneration);
      }

      const viewerOrder = currentOrder.viewers[observation.viewerId];
      if (requireRegisteredViewer && !viewerOrder) {
        return "stale";
      }
      if (viewerOrder && observation.sequence <= viewerOrder.sequence) {
        return "stale";
      }
      if (!viewerOrder) {
        if (observation.observedAt > currentMilliseconds(millisecondsNow)) {
          return "invalid";
        }
        if (!registerPositionViewer(currentOrder, observation.viewerId)) {
          return "stale";
        }
      }
      if (
        !relevantOrder?.current &&
        observedTimestamp < existing.lastReadAt
      ) {
        return "stale";
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
        await storageArea.set({ [POSITION_ORDER_KEY]: positionOrder });
        return "stale";
      }

      currentOrder.winner = candidate;
      books[canonicalUrl] = {
        ...existing,
        ...patch,
        lastReadAt: Math.max(existing.lastReadAt, observedTimestamp),
      };
      await storageArea.set({
        [BOOKS_KEY]: books,
        [POSITION_ORDER_KEY]: positionOrder,
      });
      return "updated";
    });
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
          await storageArea.set({ [POSITION_ORDER_KEY]: positionOrder });
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
        await storageArea.set({
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
          await storageArea.set({ [BOOKS_KEY]: books });
        } else {
          positionOrder[canonicalUrl] = createPositionOrder(
            newTrackingGeneration(relevantOrder?.current?.generation),
          );
          await storageArea.set({
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
        await storageArea.set({ [BOOKS_KEY]: books });
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
        await storageArea.set({ [BOOKS_KEY]: books });
        return clone(updated);
      });
    },

    async removeBook(fileUrl) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      return mutate(async () => {
        const { books, positionOrder } = await loadOrderedState();
        readRelevantPositionOrder(positionOrder, canonicalUrl);
        if (!Object.hasOwn(books, canonicalUrl)) {
          return false;
        }
        const hadPositionOrder = Object.hasOwn(positionOrder, canonicalUrl);
        delete books[canonicalUrl];
        delete positionOrder[canonicalUrl];
        await storageArea.set({
          [BOOKS_KEY]: books,
          ...(hadPositionOrder ? { [POSITION_ORDER_KEY]: positionOrder } : {}),
        });
        return true;
      });
    },

    async updatePendingPositionObservation(fileUrl, patch, observation) {
      return mutatePositionObservation({
        canonicalUrl: canonicalFileUrl(fileUrl),
        patch: validatePositionPatch(patch),
        observation: validPositionObservation(observation),
        requireRegisteredViewer: true,
      });
    },

    async updatePositionObservation(
      fileUrl,
      patch,
      observation,
      trackingGeneration,
    ) {
      return mutatePositionObservation({
        canonicalUrl: canonicalFileUrl(fileUrl),
        patch: validatePositionPatch(patch),
        observation: validPositionObservation(observation),
        requireRegisteredViewer: false,
        trackingGeneration: validPositionTrackingGeneration(
          trackingGeneration,
        ),
      });
    },

    async updatePosition(fileUrl, patch, options) {
      const canonicalUrl = canonicalFileUrl(fileUrl);
      const validPatch = validatePositionPatch(patch);
      const observedAt = validatePositionOptions(options);
      if (
        observedAt !== undefined &&
        observedAt > currentMilliseconds(millisecondsNow)
      ) {
        throw new TypeError("observedAt must not be in the future");
      }
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
        const writeTime = observedAt ?? currentMilliseconds(millisecondsNow);
        const observedTimestamp = Math.floor(writeTime / 1_000);
        if (
          observedAt !== undefined &&
          observedTimestamp < existing.lastReadAt
        ) {
          return clone(existing);
        }

        const currentOrder = positionOrderFrom(
          relevantOrder,
          relevantOrder?.current?.generation ?? newTrackingGeneration(),
        );
        const effectiveTime = Math.max(
          writeTime,
          currentOrder.winner?.effectiveTime ?? 0,
        );
        currentOrder.winner = {
          effectiveTime,
          viewerId: null,
          sequence: 0,
        };
        const updated = {
          ...existing,
          ...validPatch,
          lastReadAt: Math.max(existing.lastReadAt, observedTimestamp),
        };
        positionOrder[canonicalUrl] = currentOrder;
        books[canonicalUrl] = updated;
        await storageArea.set({
          [BOOKS_KEY]: books,
          [POSITION_ORDER_KEY]: positionOrder,
        });
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

export async function getPositionTrackingState(fileUrl, viewerId) {
  return defaultStorage().getPositionTrackingState(fileUrl, viewerId);
}

export async function trackBook(fileUrl, patch) {
  return defaultStorage().trackBook(fileUrl, patch);
}

export async function upsertBook(fileUrl, patch) {
  return defaultStorage().upsertBook(fileUrl, patch);
}

export async function hydrateMetadata(fileUrl, patch, options) {
  return defaultStorage().hydrateMetadata(fileUrl, patch, options);
}

export async function updateCustomTitle(fileUrl, customTitle) {
  return defaultStorage().updateCustomTitle(fileUrl, customTitle);
}

export async function removeBook(fileUrl) {
  return defaultStorage().removeBook(fileUrl);
}

export async function listBooks() {
  return defaultStorage().listBooks();
}

export async function updatePosition(fileUrl, patch, options) {
  return defaultStorage().updatePosition(fileUrl, patch, options);
}

export async function updatePendingPositionObservation(
  fileUrl,
  patch,
  observation,
) {
  return defaultStorage().updatePendingPositionObservation(
    fileUrl,
    patch,
    observation,
  );
}

export async function updatePositionObservation(
  fileUrl,
  patch,
  observation,
  trackingGeneration,
) {
  return defaultStorage().updatePositionObservation(
    fileUrl,
    patch,
    observation,
    trackingGeneration,
  );
}
