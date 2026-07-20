const DEFAULT_DEBOUNCE_MILLISECONDS = 1_000;

function validatePosition(position) {
  if (
    !position ||
    !Number.isInteger(position.currentPage) ||
    position.currentPage < 1 ||
    !Number.isFinite(position.scrollTop) ||
    position.scrollTop < 0
  ) {
    throw new TypeError("position must contain a valid currentPage and scrollTop");
  }
  return {
    currentPage: position.currentPage,
    scrollTop: position.scrollTop,
  };
}

function samePosition(left, right) {
  return (
    left.currentPage === right.currentPage && left.scrollTop === right.scrollTop
  );
}

export function createPositionSaveController({
  fileUrl,
  initialPosition,
  updatePosition,
  scheduler = globalThis,
  clock = { now: () => Date.now() },
  debounceMilliseconds = DEFAULT_DEBOUNCE_MILLISECONDS,
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

  let latestPosition = validatePosition(initialPosition);
  let savedPosition = latestPosition;
  let readyPosition;
  let timer;
  let deadline;
  let running;
  let destroyed = false;
  let disabled = false;

  function cancelTimer() {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
    deadline = undefined;
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
          continue;
        }

        try {
          const updated = await updatePosition(fileUrl, position);
          if (updated === undefined) {
            disabled = true;
            readyPosition = undefined;
            break;
          }
          savedPosition = position;
        } catch {
          if (!readyPosition) {
            readyPosition = position;
            break;
          }
        }
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  function makeReady() {
    if (destroyed || disabled) {
      return Promise.resolve();
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
    deadline = undefined;
    return makeReady();
  }

  function schedule() {
    cancelTimer();
    deadline = clock.now() + debounceMilliseconds;
    timer = scheduler.setTimeout(onDeadline, debounceMilliseconds);
  }

  return Object.freeze({
    observe(position) {
      if (destroyed || disabled) {
        return;
      }
      const validPosition = validatePosition(position);
      if (samePosition(validPosition, latestPosition)) {
        if (readyPosition) {
          schedule();
        }
        return;
      }
      latestPosition = validPosition;
      schedule();
    },

    flush(position) {
      if (destroyed || disabled) {
        return Promise.resolve();
      }
      if (position !== undefined) {
        latestPosition = validatePosition(position);
      }
      cancelTimer();
      return makeReady();
    },

    async settled() {
      while (running) {
        await running;
      }
    },

    destroy() {
      destroyed = true;
      readyPosition = undefined;
      cancelTimer();
    },
  });
}
