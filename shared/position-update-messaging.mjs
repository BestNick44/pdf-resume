import { canonicalizeLocalPdfUrl } from "./local-pdf-url.mjs";
import { validPosition as validPositionValues } from "./position.mjs";

const UPDATE_POSITION_MESSAGE = "pdf-resume/private/update-position";
const PENDING_POSITION_HANDOFF_MESSAGE =
  "pdf-resume/private/handoff-pending-position";
const UPDATE_POSITION_RESULT = "pdf-resume/private/update-position-result";
const RESULT_STATUSES = new Set(["updated", "stale", "missing", "failed", "invalid"]);
const STORAGE_RESULT_STATUSES = new Set([
  "updated",
  "stale",
  "missing",
  "invalid",
]);
const POSITION_FIELDS = ["currentPage", "scrollTop"];
const OBSERVATION_FIELDS = ["viewerId", "sequence", "observedAt"];
const POSITION_ID_PATTERN = /^[0-9a-f]{32}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

function canonicalFileUrl(fileUrl) {
  const canonicalUrl = canonicalizeLocalPdfUrl(fileUrl).href;
  if (canonicalUrl !== fileUrl) {
    throw new TypeError("position update URL must already be canonical");
  }
  return canonicalUrl;
}

function validPosition(position) {
  return validPositionValues(
    ownDataObject(position, POSITION_FIELDS, "position"),
  );
}

function validObservedAt(value, label = "position observation time") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer Unix millisecond timestamp`);
  }
  return value;
}

function validPositionId(value, label) {
  if (typeof value !== "string" || !POSITION_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 128-bit lowercase hex ID`);
  }
  return value;
}

export function validPositionTrackingGeneration(value) {
  return validPositionId(value, "position tracking generation");
}

export function validPositionObservation(observation) {
  const result = ownDataObject(
    observation,
    OBSERVATION_FIELDS,
    "position observation",
  );
  if (!Number.isSafeInteger(result.sequence) || result.sequence < 1) {
    throw new TypeError("position observation sequence must be a positive safe integer");
  }
  return {
    viewerId: validPositionId(
      result.viewerId,
      "position observation viewerId",
    ),
    sequence: result.sequence,
    observedAt: validObservedAt(result.observedAt),
  };
}

function randomViewerId() {
  const values = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("position observations require crypto.getRandomValues");
  }
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createPositionObservationSource({
  clock = { now: () => Date.now() },
  viewerId = randomViewerId(),
} = {}) {
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("position observation clock must provide now");
  }
  const validViewerId = validPositionObservation({
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
      const observation = validPositionObservation({
        viewerId: validViewerId,
        sequence: sequence + 1,
        observedAt: clock.now(),
      });
      sequence = observation.sequence;
      return Object.freeze(observation);
    },
  });
}

function createMessage(
  fileUrl,
  position,
  observation,
  trackingGeneration,
) {
  return {
    type: UPDATE_POSITION_MESSAGE,
    fileUrl: canonicalFileUrl(fileUrl),
    position: validPosition(position),
    observation: validPositionObservation(observation),
    trackingGeneration: validPositionTrackingGeneration(trackingGeneration),
  };
}

function createPendingHandoffMessage(fileUrl, position, observation) {
  return {
    type: PENDING_POSITION_HANDOFF_MESSAGE,
    fileUrl: canonicalFileUrl(fileUrl),
    position: validPosition(position),
    observation: validPositionObservation(observation),
  };
}

function parseMessage(message) {
  const type = Object.getOwnPropertyDescriptor(message, "type")?.value;
  if (type === UPDATE_POSITION_MESSAGE) {
    const result = ownDataObject(
      message,
      ["type", "fileUrl", "position", "observation", "trackingGeneration"],
      "position update message",
    );
    return {
      operation: "ordered",
      fileUrl: canonicalFileUrl(result.fileUrl),
      position: validPosition(result.position),
      observation: validPositionObservation(result.observation),
      trackingGeneration: validPositionTrackingGeneration(
        result.trackingGeneration,
      ),
    };
  }
  if (type === PENDING_POSITION_HANDOFF_MESSAGE) {
    const result = ownDataObject(
      message,
      ["type", "fileUrl", "position", "observation"],
      "pending position handoff message",
    );
    return {
      operation: "pendingHandoff",
      fileUrl: canonicalFileUrl(result.fileUrl),
      position: validPosition(result.position),
      observation: validPositionObservation(result.observation),
    };
  }
  throw new TypeError("unexpected position update message type");
}

function hasPositionMutationType(message) {
  if (!isPlainObject(message)) {
    return false;
  }
  const type = Object.getOwnPropertyDescriptor(message, "type")?.value;
  return (
    type === UPDATE_POSITION_MESSAGE ||
    type === PENDING_POSITION_HANDOFF_MESSAGE
  );
}

function resultMessage(status) {
  return { type: UPDATE_POSITION_RESULT, status };
}

function parseResult(response) {
  const result = ownDataObject(
    response,
    ["type", "status"],
    "position update response",
  );
  if (
    result.type !== UPDATE_POSITION_RESULT ||
    !RESULT_STATUSES.has(result.status)
  ) {
    throw new TypeError("invalid position update response");
  }
  return result.status;
}

export function createPositionUpdateClient({ sendMessage } = {}) {
  if (typeof sendMessage !== "function") {
    throw new TypeError("sendMessage must be a function");
  }

  function handoff(message) {
    try {
      const response = sendMessage(message);
      void Promise.resolve(response).catch(() => {});
    } catch {
      // The page is tearing down and has no durable place to report this failure.
    }
  }

  return Object.freeze({
    async updatePosition(fileUrl, position, observation, trackingGeneration) {
      const status = parseResult(
        await sendMessage(
          createMessage(fileUrl, position, observation, trackingGeneration),
        ),
      );
      if (status === "failed" || status === "invalid") {
        throw new Error("the background position update failed");
      }
      return status === "missing" ? undefined : validPosition(position);
    },

    handoffPendingPosition(fileUrl, position, observation) {
      handoff(createPendingHandoffMessage(fileUrl, position, observation));
    },

    handoffPosition(fileUrl, position, observation, trackingGeneration) {
      handoff(
        createMessage(fileUrl, position, observation, trackingGeneration),
      );
    },
  });
}

export function createPositionUpdateMessageHandler({
  extensionId,
  updatePendingPositionObservation,
  updatePositionObservation,
} = {}) {
  if (typeof extensionId !== "string" || extensionId.length === 0) {
    throw new TypeError("extensionId must be a non-empty string");
  }
  if (
    typeof updatePendingPositionObservation !== "function" ||
    typeof updatePositionObservation !== "function"
  ) {
    throw new TypeError("position observation mutations must be functions");
  }
  let queue = Promise.resolve();

  function enqueue(update) {
    const operation = queue.then(async () => {
      const status =
        update.operation === "pendingHandoff"
          ? await updatePendingPositionObservation(
              update.fileUrl,
              update.position,
              update.observation,
            )
          : await updatePositionObservation(
              update.fileUrl,
              update.position,
              update.observation,
              update.trackingGeneration,
            );
      if (!STORAGE_RESULT_STATUSES.has(status)) {
        throw new TypeError("invalid position storage result");
      }
      return status;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return function onPositionUpdateMessage(message, sender, sendResponse) {
    if (!hasPositionMutationType(message)) {
      return false;
    }

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
      let response;
      try {
        response = resultMessage(await enqueue(update));
      } catch {
        response = resultMessage("failed");
      }
      try {
        sendResponse(response);
      } catch {
        // The sender may disappear after a pagehide handoff; the write is complete.
      }
    }

    void respond();
    return true;
  };
}
