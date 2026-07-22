import {
  createPositionObservationSource,
  validPositionObservation,
} from "../shared/position-update-messaging.mjs";
import { samePosition, validPosition } from "../shared/position.mjs";

const DEFAULT_DEBOUNCE_MILLISECONDS = 1_000;
const DEFAULT_RETRY_DELAYS_MILLISECONDS = Object.freeze([250, 1_000, 4_000]);

function validateDelays(delays) {
  if (
    !Array.isArray(delays) ||
    delays.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new TypeError("retry delays must be an array of non-negative numbers");
  }
  return [...delays];
}

export function createPositionSaveController({
  fileUrl,
  initialPosition,
  updatePosition,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
  observationSource,
  debounceMilliseconds = DEFAULT_DEBOUNCE_MILLISECONDS,
  retryDelaysMilliseconds = DEFAULT_RETRY_DELAYS_MILLISECONDS,
}) {
  if (typeof fileUrl !== "string") {
    throw new TypeError("fileUrl must be a string");
  }
  if (typeof updatePosition !== "function") {
    throw new TypeError("updatePosition must be a function");
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

  let latestPosition = validPosition(initialPosition);
  let latestObservation;
  let savedPosition = latestPosition;
  let readyUpdate;
  let timer;
  let timerKind;
  let running;
  let activeUpdate;
  let failedAttempts = 0;
  let retriesExhausted = false;
  let retirementPromise;
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

  function scheduleTimer(kind, delay) {
    cancelTimer();
    timerKind = kind;
    timer = scheduler.setTimeout(onDeadline, delay);
  }

  function observationValue(observation) {
    return Object.freeze(
      validPositionObservation(observation ?? observations.next()),
    );
  }

  function captureLatest(position, observation) {
    const positionValue = validPosition(position);
    if (samePosition(positionValue, latestPosition)) {
      return false;
    }
    latestPosition = positionValue;
    latestObservation = observationValue(observation);
    return true;
  }

  function latestUpdate() {
    latestObservation ??= observationValue();
    return {
      position: latestPosition,
      observation: latestObservation,
    };
  }

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
          const updated = await updatePosition(
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

    prepareHandoff(position) {
      if (destroyed || disabled || retired) {
        return undefined;
      }
      captureLatest(position);
      const olderUpdatePending = [activeUpdate, readyUpdate].some(
        (update) => update && !samePosition(update.position, latestPosition),
      );
      if (
        samePosition(latestPosition, savedPosition) &&
        !olderUpdatePending
      ) {
        return undefined;
      }
      const update = latestUpdate();
      return Object.freeze({
        position: validPosition(update.position),
        observation: Object.freeze(validPositionObservation(update.observation)),
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
