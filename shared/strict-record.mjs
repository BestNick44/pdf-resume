// @ts-check

/** @typedef {import("../types/storage.d.ts").ClientResultStatus} ClientResultStatus */
/** @typedef {import("../types/storage.d.ts").StorageMutationStatus} StorageMutationStatus */

/** @type {ReadonlySet<ClientResultStatus>} */
export const RESULT_STATUSES = new Set([
  "updated",
  "stale",
  "missing",
  "failed",
  "invalid",
]);

/**
 * @type {{
 *   readonly updated: "updated",
 *   readonly stale: "stale",
 *   readonly missing: "missing",
 *   readonly invalid: "invalid",
 * }}
 */
const STORAGE_RESULT_VALUES = {
  updated: "updated",
  stale: "stale",
  missing: "missing",
  invalid: "invalid",
};

/** @type {ReadonlySet<StorageMutationStatus> & typeof STORAGE_RESULT_VALUES} */
export const STORAGE_RESULT_STATUSES = Object.assign(
  new Set(Object.values(STORAGE_RESULT_VALUES)),
  STORAGE_RESULT_VALUES,
);

/**
 * @param {unknown} value
 * @returns {value is Record<PropertyKey, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {string} unavailableErrorMessage
 * @returns {string}
 */
export function randomHexId(unavailableErrorMessage) {
  const values = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error(unavailableErrorMessage);
  }
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}
