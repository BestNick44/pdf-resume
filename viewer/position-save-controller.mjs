// @ts-check

import {
  createPositionObservationSource,
  validPositionObservationMetadata,
} from "../shared/position-update-messaging.mjs";
import { samePosition, validPosition } from "../shared/position.mjs";

/** @typedef {import("../types/storage.d.ts").Position} Position */
/** @typedef {import("../types/storage.d.ts").PositionObservationMetadata} PositionObservationMetadata */
/**
 * @typedef {{
 *   setTimeout: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>,
 *   clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => void,
 * }} TimerScheduler
 */
/** @typedef {{ now: () => number }} Clock */
/** @typedef {{ next: () => PositionObservationMetadata }} PositionObservationSource */
/** @typedef {{ position: Position, observation: PositionObservationMetadata }} PositionUpdate */
/** @typedef {"debounce" | "retry"} TimerKind */
/** @typedef {{ disabled: boolean, durable: boolean, pending: boolean, retryPending: boolean }} SaveStatus */

const DEFAULT_DEBOUNCE_MILLISECONDS = 1_000;
const DEFAULT_RETRY_DELAYS_MILLISECONDS = Object.freeze([250, 1_000, 4_000]);

/**
 * @param {readonly number[]} delays
 * @returns {number[]}
 */
function validateDelays(delays) {
  if (
    !Array.isArray(delays) ||
    delays.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new TypeError(
      "retry delays must be an array of non-negative numbers",
    );
  }
  return [...delays];
}

/**
 * @param {{
 *   fileUrl: string,
 *   initialPosition: Position,
 *   recordObservation: (
 *     fileUrl: string,
 *     position: Position,
 *     observation: PositionObservationMetadata,
 *   ) => Promise<unknown>,
 *   scheduler?: TimerScheduler,
 *   clock?: Clock,
 *   observationSource?: PositionObservationSource,
 *   debounceMilliseconds?: number,
 *   retryDelaysMilliseconds?: readonly number[],
 * }} options
 */
export function createPositionSaveController({
  fileUrl,
  initialPosition,
  recordObservation,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
  observationSource,
  debounceMilliseconds = DEFAULT_DEBOUNCE_MILLISECONDS,
  retryDelaysMilliseconds = DEFAULT_RETRY_DELAYS_MILLISECONDS,
}) {
  if (typeof fileUrl !== "string") {
    throw new TypeError("fileUrl must be a string");
  }
  if (typeof recordObservation !== "function") {
    throw new TypeError("recordObservation must be a function");
  }
  if (
    !scheduler ||
    typeof scheduler.setTimeout !== "function" ||
    typeof scheduler.clearTimeout !== "function"
  ) {
    throw new TypeError("scheduler must provide setTimeout and clearTimeout");
  }
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("clock must provide now");
  }
  if (!Number.isFinite(debounceMilliseconds) || debounceMilliseconds < 0) {
    throw new TypeError("debounceMilliseconds must be non-negative");
  }
  const retryDelays = validateDelays(retryDelaysMilliseconds);
  const observations =
    observationSource ?? createPositionObservationSource({ clock });
  if (!observations || typeof observations.next !== "function") {
    throw new TypeError("observationSource must provide next");
  }

  /** @type {Position} */
  let latestPosition = validPosition(initialPosition);
  /** @type {PositionObservationMetadata | undefined} */
  let latestObservation;
  /** @type {Position} */
  let savedPosition = latestPosition;
  /** @type {PositionUpdate | undefined} */
  let readyUpdate;
  /** @type {ReturnType<TimerScheduler["setTimeout"]> | undefined} */
  let timer;
  /** @type {TimerKind | undefined} */
  let timerKind;
  /** @type {Promise<void> | undefined} */
  let running;
  /** @type {PositionUpdate | undefined} */
  let activeUpdate;
  let failedAttempts = 0;
  let retriesExhausted = false;
  /** @type {Promise<void> | undefined} */
  let retirementPromise;
  /** @type {(() => void) | undefined} */
  let resolveRetirement;
  let retired = false;
  let destroyed = false;
  let disabled = false;

  function cancelTimer() {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
    timerKind = undefined;
  }

  /**
   * @param {TimerKind} kind
   * @param {number} delay
   */
  function scheduleTimer(kind, delay) {
    cancelTimer();
    timerKind = kind;
    timer = scheduler.setTimeout(onDeadline, delay);
  }

  /**
   * @param {PositionObservationMetadata} [observation]
   * @returns {Readonly<PositionObservationMetadata>}
   */
  function observationValue(observation) {
    return Object.freeze(
      validPositionObservationMetadata(observation ?? observations.next()),
    );
  }

  /**
   * @param {Position} position
   * @param {PositionObservationMetadata} [observation]
   * @returns {boolean}
   */
  function captureLatest(position, observation) {
    const positionValue = validPosition(position);
    if (samePosition(positionValue, latestPosition)) {
      return false;
    }
    latestPosition = positionValue;
    latestObservation = observationValue(observation);
    return true;
  }

  /** @returns {PositionUpdate} */
  function latestUpdate() {
    latestObservation ??= observationValue();
    return {
      position: latestPosition,
      observation: latestObservation,
    };
  }

  /** @param {PositionUpdate} update */
  function scheduleRetry(update) {
    readyUpdate = update;
    if (failedAttempts >= retryDelays.length) {
      failedAttempts = 0;
      retriesExhausted = true;
      return;
    }
    const delay = retryDelays[failedAttempts];
    failedAttempts += 1;
    scheduleTimer("retry", delay);
  }

  function finishRetirement() {
    if (
      !resolveRetirement ||
      (!destroyed &&
        (running ||
          (!disabled &&
            !retriesExhausted &&
            (readyUpdate ||
              timer !== undefined ||
              !samePosition(latestPosition, savedPosition)))))
    ) {
      return;
    }
    const resolve = resolveRetirement;
    resolveRetirement = undefined;
    resolve();
  }

  /** @returns {Promise<void>} */
  function startPump() {
    if (running || destroyed || disabled) {
      return running ?? Promise.resolve();
    }

    running = (async () => {
      while (readyUpdate && !destroyed && !disabled) {
        const update = readyUpdate;
        readyUpdate = undefined;
        if (samePosition(update.position, savedPosition)) {
          failedAttempts = 0;
          continue;
        }

        activeUpdate = update;
        try {
          const updated = await recordObservation(
            fileUrl,
            update.position,
            update.observation,
          );
          if (updated === undefined) {
            disabled = true;
            readyUpdate = undefined;
            cancelTimer();
            break;
          }
          savedPosition = update.position;
          failedAttempts = 0;
        } catch {
          if (destroyed || disabled) {
            break;
          }
          if (readyUpdate) {
            failedAttempts = 0;
            continue;
          }
          if (!samePosition(latestPosition, update.position)) {
            failedAttempts = 0;
            break;
          }
          scheduleRetry(update);
          break;
        } finally {
          if (activeUpdate === update) {
            activeUpdate = undefined;
          }
        }
      }
    })().finally(() => {
      running = undefined;
      finishRetirement();
    });
    return running;
  }

  /**
   * @param {{ resetFailures?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function makeReady({ resetFailures = false } = {}) {
    if (destroyed || disabled) {
      finishRetirement();
      return Promise.resolve();
    }
    if (resetFailures) {
      failedAttempts = 0;
      retriesExhausted = false;
    }
    readyUpdate = latestUpdate();
    return startPump();
  }

  function onDeadline() {
    timer = undefined;
    const expiredKind = timerKind;
    timerKind = undefined;
    return makeReady({ resetFailures: expiredKind === "debounce" });
  }

  /** @returns {Readonly<SaveStatus>} */
  function status() {
    const durable =
      !disabled &&
      !readyUpdate &&
      timer === undefined &&
      !running &&
      samePosition(latestPosition, savedPosition);
    return Object.freeze({
      disabled,
      durable,
      pending: !disabled && !durable,
      retryPending: timerKind === "retry",
    });
  }

  return Object.freeze({
    /**
     * @param {Position} position
     * @param {PositionObservationMetadata} [observation]
     */
    observe(position, observation) {
      if (destroyed || disabled || retired) {
        return;
      }
      if (!captureLatest(position, observation)) {
        if (readyUpdate && timerKind !== "retry") {
          scheduleTimer("debounce", debounceMilliseconds);
        }
        return;
      }
      failedAttempts = 0;
      scheduleTimer("debounce", debounceMilliseconds);
    },

    /** @param {Position} [position] */
    flush(position) {
      if (destroyed || disabled || retired) {
        return Promise.resolve();
      }
      if (position !== undefined) {
        captureLatest(position);
      }
      cancelTimer();
      return makeReady({ resetFailures: true });
    },

    retire() {
      if (retirementPromise) {
        return retirementPromise;
      }
      retired = true;
      retirementPromise = new Promise((resolve) => {
        resolveRetirement = resolve;
      });
      cancelTimer();
      void makeReady({ resetFailures: true });
      finishRetirement();
      return retirementPromise;
    },

    /** @param {Position} position */
    prepareHandoff(position) {
      if (destroyed || disabled || retired) {
        return undefined;
      }
      captureLatest(position);
      const olderUpdatePending = [activeUpdate, readyUpdate].some(
        (update) => update && !samePosition(update.position, latestPosition),
      );
      if (samePosition(latestPosition, savedPosition) && !olderUpdatePending) {
        return undefined;
      }
      const update = latestUpdate();
      return Object.freeze({
        position: validPosition(update.position),
        observation: Object.freeze(
          validPositionObservationMetadata(update.observation),
        ),
      });
    },

    async settled() {
      while (running) {
        await running;
      }
      return status();
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      readyUpdate = undefined;
      cancelTimer();
      finishRetirement();
    },
  });
}
