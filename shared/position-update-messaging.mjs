// @ts-check

import { canonicalizeLocalPdfUrl } from "./local-pdf-url.mjs";
import { validPosition as validPositionValues } from "./position.mjs";
import {
  isPlainObject,
  randomHexId,
  RESULT_STATUSES,
  STORAGE_RESULT_STATUSES,
} from "./strict-record.mjs";

/** @typedef {import("../types/storage.d.ts").ClientResultStatus} ClientResultStatus */
/** @typedef {import("../types/storage.d.ts").Position} Position */
/** @typedef {import("../types/storage.d.ts").PositionObservation} PositionObservation */
/** @typedef {import("../types/storage.d.ts").PositionObservationMetadata} PositionObservationMetadata */
/** @typedef {import("../types/storage.d.ts").RecordObservationMessage} RecordObservationMessage */
/** @typedef {import("../types/storage.d.ts").StorageMutationStatus} StorageMutationStatus */
/** @typedef {{ type: typeof RECORD_OBSERVATION_RESULT, status: ClientResultStatus }} RecordObservationResultMessage */

const RECORD_OBSERVATION_MESSAGE = "pdf-resume/private/record-observation";
const RECORD_OBSERVATION_RESULT = "pdf-resume/private/update-position-result";
const POSITION_FIELDS = ["currentPage", "scrollTop"];
const OBSERVATION_FIELDS = ["viewerId", "sequence", "observedAt"];
const POSITION_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * @param {unknown} value
 * @param {readonly string[]} fields
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function ownDataObject(value, fields, label) {
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

/**
 * @param {unknown} fileUrl
 */
function canonicalFileUrl(fileUrl) {
  const canonicalUrl = canonicalizeLocalPdfUrl(fileUrl).href;
  if (canonicalUrl !== fileUrl) {
    throw new TypeError("position update URL must already be canonical");
  }
  return canonicalUrl;
}

/**
 * @param {unknown} position
 * @returns {Position}
 */
function validPosition(position) {
  return validPositionValues(
    ownDataObject(position, POSITION_FIELDS, "position"),
  );
}

/**
 * @param {unknown} value
 * @param {string} [label]
 */
function validObservedAt(value, label = "position observation time") {
  if (!Number.isSafeInteger(/** @type {number} */ (value)) || /** @type {number} */ (value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer Unix millisecond timestamp`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function validPositionId(value, label) {
  if (typeof value !== "string" || !POSITION_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 128-bit lowercase hex ID`);
  }
  return value;
}

/**
 * @param {unknown} value
 */
export function validPositionTrackingGeneration(value) {
  return validPositionId(value, "position tracking generation");
}

/**
 * @param {unknown} observation
 * @returns {PositionObservationMetadata}
 */
export function validPositionObservationMetadata(observation) {
  const result = ownDataObject(
    observation,
    OBSERVATION_FIELDS,
    "position observation",
  );
  if (
    !Number.isSafeInteger(/** @type {number} */ (result.sequence)) ||
    /** @type {number} */ (result.sequence) < 1
  ) {
    throw new TypeError("position observation sequence must be a positive safe integer");
  }
  return {
    viewerId: validPositionId(
      result.viewerId,
      "position observation viewerId",
    ),
    sequence: /** @type {number} */ (result.sequence),
    observedAt: validObservedAt(result.observedAt),
  };
}

/**
 * @param {unknown} observation
 * @returns {PositionObservation}
 */
export function validPositionObservation(observation) {
  if (!isPlainObject(observation)) {
    throw new TypeError("position observation must be a plain object");
  }
  const intentDescriptor = Object.getOwnPropertyDescriptor(observation, "intent");
  const intent =
    intentDescriptor && "value" in intentDescriptor
      ? intentDescriptor.value
      : undefined;
  if (intent !== "registered" && intent !== "pending") {
    throw new TypeError('position observation intent must be "registered" or "pending"');
  }
  const result = ownDataObject(
    observation,
    intent === "registered"
      ? [...OBSERVATION_FIELDS, "intent", "trackingGeneration"]
      : [...OBSERVATION_FIELDS, "intent"],
    "position observation",
  );
  const metadata = validPositionObservationMetadata({
    viewerId: result.viewerId,
    sequence: result.sequence,
    observedAt: result.observedAt,
  });
  return intent === "registered"
    ? {
        ...metadata,
        intent,
        trackingGeneration: validPositionTrackingGeneration(
          result.trackingGeneration,
        ),
      }
    : { ...metadata, intent };
}

/** @returns {string} */
function randomViewerId() {
  return randomHexId("position observations require crypto.getRandomValues");
}

/**
 * @param {{ clock?: { now: () => number }, viewerId?: unknown }} [options]
 */
export function createPositionObservationSource({
  clock = { now: () => Date.now() },
  viewerId = randomViewerId(),
} = {}) {
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("position observation clock must provide now");
  }
  const validViewerId = validPositionObservationMetadata({
    viewerId,
    sequence: 1,
    observedAt: 0,
  }).viewerId;
  let sequence = 0;

  return Object.freeze({
    viewerId: validViewerId,

    next() {
      if (sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("position observation sequence is exhausted");
      }
      const observation = validPositionObservationMetadata({
        viewerId: validViewerId,
        sequence: sequence + 1,
        observedAt: clock.now(),
      });
      sequence = observation.sequence;
      return Object.freeze(observation);
    },
  });
}

/**
 * @param {string} fileUrl
 * @param {Position} position
 * @param {PositionObservation} observation
 * @returns {RecordObservationMessage}
 */
function createMessage(fileUrl, position, observation) {
  return {
    type: RECORD_OBSERVATION_MESSAGE,
    fileUrl: canonicalFileUrl(fileUrl),
    position: validPosition(position),
    observation: validPositionObservation(observation),
  };
}

/**
 * @param {unknown} message
 * @returns {Omit<RecordObservationMessage, "type">}
 */
function parseMessage(message) {
  const result = ownDataObject(
    message,
    ["type", "fileUrl", "position", "observation"],
    "position observation message",
  );
  if (result.type !== RECORD_OBSERVATION_MESSAGE) {
    throw new TypeError("unexpected position observation message type");
  }
  return {
    fileUrl: canonicalFileUrl(result.fileUrl),
    position: validPosition(result.position),
    observation: validPositionObservation(result.observation),
  };
}

/**
 * @param {unknown} message
 * @returns {message is Record<PropertyKey, unknown>}
 */
function hasPositionMutationType(message) {
  return (
    isPlainObject(message) &&
    Object.getOwnPropertyDescriptor(message, "type")?.value ===
      RECORD_OBSERVATION_MESSAGE
  );
}

/**
 * @param {ClientResultStatus} status
 * @returns {RecordObservationResultMessage}
 */
function resultMessage(status) {
  return { type: RECORD_OBSERVATION_RESULT, status };
}

/**
 * @param {unknown} response
 * @returns {ClientResultStatus}
 */
function parseResult(response) {
  const result = ownDataObject(
    response,
    ["type", "status"],
    "position observation response",
  );
  if (
    result.type !== RECORD_OBSERVATION_RESULT ||
    !RESULT_STATUSES.has(/** @type {ClientResultStatus} */ (result.status))
  ) {
    throw new TypeError("invalid position observation response");
  }
  return /** @type {ClientResultStatus} */ (result.status);
}

/**
 * @param {{ sendMessage?: (message: RecordObservationMessage) => unknown }} [dependencies]
 */
export function createPositionUpdateClient({ sendMessage } = {}) {
  if (typeof sendMessage !== "function") {
    throw new TypeError("sendMessage must be a function");
  }

  /** @param {RecordObservationMessage} message */
  async function send(message) {
    const status = parseResult(
      await /** @type {(message: RecordObservationMessage) => unknown} */ (
        sendMessage
      )(message),
    );
    if (status === "failed" || status === "invalid") {
      throw new Error("the background position observation failed");
    }
    return status === "missing" ? undefined : validPosition(message.position);
  }

  /** @param {RecordObservationMessage} message */
  function handoff(message) {
    try {
      const response = /** @type {(message: RecordObservationMessage) => unknown} */ (
        sendMessage
      )(message);
      void Promise.resolve(response).catch(() => {});
    } catch {
      // The page is tearing down and has no durable place to report this failure.
    }
  }

  return Object.freeze({
    /**
     * @param {string} fileUrl
     * @param {Position} position
     * @param {PositionObservation} observation
     * @param {{ handoff?: boolean }} [options]
     */
    recordObservation(fileUrl, position, observation, { handoff: isHandoff = false } = {}) {
      if (isHandoff) {
        handoff(createMessage(fileUrl, position, observation));
        return undefined;
      }
      try {
        return send(createMessage(fileUrl, position, observation));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
}

/**
 * @param {{
 *   extensionId?: string,
 *   recordObservation?: (
 *     fileUrl: string,
 *     position: Position,
 *     observation: PositionObservation,
 *   ) => Promise<StorageMutationStatus>,
 * }} [dependencies]
 */
export function createPositionUpdateMessageHandler({
  extensionId,
  recordObservation,
} = {}) {
  if (typeof extensionId !== "string" || extensionId.length === 0) {
    throw new TypeError("extensionId must be a non-empty string");
  }
  if (typeof recordObservation !== "function") {
    throw new TypeError("recordObservation must be a function");
  }
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * @param {Omit<RecordObservationMessage, "type">} update
   * @returns {Promise<StorageMutationStatus>}
   */
  function enqueue(update) {
    const operation = queue.then(async () => {
      const status = await /** @type {NonNullable<typeof recordObservation>} */ (
        recordObservation
      )(update.fileUrl, update.position, update.observation);
      if (!STORAGE_RESULT_STATUSES.has(status)) {
        throw new TypeError("invalid position storage result");
      }
      return status;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  /**
   * @param {unknown} message
   * @param {chrome.runtime.MessageSender} sender
   * @param {unknown} sendResponse
   */
  return function onPositionUpdateMessage(message, sender, sendResponse) {
    if (!hasPositionMutationType(message)) {
      return false;
    }

    /** @type {Omit<RecordObservationMessage, "type">} */
    let update;
    try {
      if (sender?.id !== extensionId || typeof sendResponse !== "function") {
        throw new TypeError("position updates are private to this extension");
      }
      update = parseMessage(message);
    } catch {
      if (typeof sendResponse === "function") {
        sendResponse(resultMessage("invalid"));
      }
      return false;
    }

    async function respond() {
      /** @type {RecordObservationResultMessage} */
      let response;
      try {
        response = resultMessage(await enqueue(update));
      } catch {
        response = resultMessage("failed");
      }
      try {
        /** @type {(response: RecordObservationResultMessage) => void} */ (
          sendResponse
        )(response);
      } catch {
        // The sender may disappear after a pagehide handoff; the write is complete.
      }
    }

    void respond();
    return true;
  };
}
