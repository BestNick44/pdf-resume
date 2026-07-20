import { canonicalizeLocalPdfUrl } from "./local-pdf-url.mjs";
import { validPosition as validPositionValues } from "./position.mjs";

const UPDATE_POSITION_MESSAGE = "pdf-resume/private/update-position";
const UPDATE_POSITION_RESULT = "pdf-resume/private/update-position-result";
const RESULT_STATUSES = new Set(["updated", "missing", "failed", "invalid"]);
const POSITION_FIELDS = ["currentPage", "scrollTop"];

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

function createMessage(fileUrl, position) {
  return {
    type: UPDATE_POSITION_MESSAGE,
    fileUrl: canonicalFileUrl(fileUrl),
    position: validPosition(position),
  };
}

function parseMessage(message) {
  const result = ownDataObject(
    message,
    ["type", "fileUrl", "position"],
    "position update message",
  );
  if (result.type !== UPDATE_POSITION_MESSAGE) {
    throw new TypeError("unexpected position update message type");
  }
  return {
    fileUrl: canonicalFileUrl(result.fileUrl),
    position: validPosition(result.position),
  };
}

function hasUpdatePositionType(message) {
  if (!isPlainObject(message)) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(message, "type");
  return descriptor?.value === UPDATE_POSITION_MESSAGE;
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

  return Object.freeze({
    async updatePosition(fileUrl, position) {
      const status = parseResult(await sendMessage(createMessage(fileUrl, position)));
      if (status === "failed" || status === "invalid") {
        throw new Error("the background position update failed");
      }
      return status === "updated" ? validPosition(position) : undefined;
    },

    handoffPosition(fileUrl, position) {
      try {
        const response = sendMessage(createMessage(fileUrl, position));
        void Promise.resolve(response).catch(() => {});
      } catch {
        // The page is tearing down and has no durable place to report this failure.
      }
    },
  });
}

export function createPositionUpdateMessageHandler({ extensionId, updatePosition } = {}) {
  if (typeof extensionId !== "string" || extensionId.length === 0) {
    throw new TypeError("extensionId must be a non-empty string");
  }
  if (typeof updatePosition !== "function") {
    throw new TypeError("updatePosition must be a function");
  }

  let queue = Promise.resolve();

  function enqueue({ fileUrl, position }) {
    const operation = queue.then(() => updatePosition(fileUrl, position));
    queue = operation.catch(() => {});
    return operation;
  }

  return function onPositionUpdateMessage(message, sender, sendResponse) {
    if (!hasUpdatePositionType(message)) {
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
        const updated = await enqueue(update);
        response = resultMessage(updated === undefined ? "missing" : "updated");
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
