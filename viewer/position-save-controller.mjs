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

  let latestPosition = validPosition(initialPosition);
  let savedPosition = latestPosition;
  let readyPosition;
  let timer;
  let timerKind;
  let deadline;
  let running;
  let failedAttempts = 0;
  let destroyed = false;
  let disabled = false;

  function cancelTimer() {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
    timerKind = undefined;
    deadline = undefined;
  }

  function scheduleTimer(kind, delay) {
    cancelTimer();
    timerKind = kind;
    deadline = clock.now() + delay;
    timer = scheduler.setTimeout(onDeadline, delay);
  }

  function scheduleRetry(position) {
    readyPosition = position;
    if (failedAttempts >= retryDelays.length) {
      failedAttempts = 0;
      return;
    }
    const delay = retryDelays[failedAttempts];
    failedAttempts += 1;
    scheduleTimer("retry", delay);
  }

  function startPump() {
    if (running || destroyed || disabled) {
      return running ?? Promise.resolve();
    }

    running = (async () => {
      while (readyPosition && !destroyed && !disabled) {
        const position = readyPosition;
        readyPosition = undefined;
        if (samePosition(position, savedPosition)) {
          failedAttempts = 0;
          continue;
        }

        try {
          const updated = await updatePosition(fileUrl, position);
          if (updated === undefined) {
            disabled = true;
            readyPosition = undefined;
            cancelTimer();
            break;
          }
          savedPosition = position;
          failedAttempts = 0;
        } catch {
          if (readyPosition) {
            failedAttempts = 0;
            continue;
          }
          if (!samePosition(latestPosition, position)) {
            failedAttempts = 0;
            break;
          }
          scheduleRetry(position);
          break;
        }
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  function makeReady({ resetFailures = false } = {}) {
    if (destroyed || disabled) {
      return Promise.resolve();
    }
    if (resetFailures) {
      failedAttempts = 0;
    }
    readyPosition = latestPosition;
    return startPump();
  }

  function onDeadline() {
    timer = undefined;
    const remaining = deadline - clock.now();
    if (remaining > 0) {
      timer = scheduler.setTimeout(onDeadline, remaining);
      return;
    }
    const expiredKind = timerKind;
    timerKind = undefined;
    deadline = undefined;
    return makeReady({ resetFailures: expiredKind === "debounce" });
  }

  function status() {
    const durable =
      !disabled &&
      !readyPosition &&
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
    needsSave(position) {
      if (destroyed || disabled) {
        return false;
      }
      return !samePosition(validPosition(position), savedPosition);
    },

    observe(position) {
      if (destroyed || disabled) {
        return;
      }
      const positionValue = validPosition(position);
      if (samePosition(positionValue, latestPosition)) {
        if (readyPosition && timerKind !== "retry") {
          scheduleTimer("debounce", debounceMilliseconds);
        }
        return;
      }
      latestPosition = positionValue;
      failedAttempts = 0;
      scheduleTimer("debounce", debounceMilliseconds);
    },

    flush(position) {
      if (destroyed || disabled) {
        return Promise.resolve();
      }
      if (position !== undefined) {
        latestPosition = validPosition(position);
      }
      cancelTimer();
      return makeReady({ resetFailures: true });
    },

    async settled() {
      while (running) {
        await running;
      }
      return status();
    },

    destroy() {
      destroyed = true;
      readyPosition = undefined;
      cancelTimer();
    },
  });
}
