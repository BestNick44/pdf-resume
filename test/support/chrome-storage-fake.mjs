const OMITTED = Symbol("omitted Chrome storage value");

function serialize(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : OMITTED;
  }
  if (typeof value !== "object") {
    return OMITTED;
  }
  if (ancestors.has(value)) {
    return null;
  }

  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = Array.from(value, (item) => {
      const serializedItem = serialize(item, ancestors);
      return serializedItem === OMITTED ? null : serializedItem;
    });
  } else {
    serialized = {};
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      keys = [];
    }
    for (const key of keys) {
      let item;
      try {
        item = value[key];
      } catch {
        continue;
      }
      const serializedItem = serialize(item, ancestors);
      if (serializedItem !== OMITTED) {
        Object.defineProperty(serialized, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: serializedItem,
        });
      }
    }
  }
  ancestors.delete(value);
  return serialized;
}

function clone(value) {
  const serialized = serialize(value);
  return serialized === OMITTED ? undefined : serialized;
}

function serializeItems(value) {
  const serialized = serialize(value);
  if (serialized === OMITTED || serialized === null || Array.isArray(serialized)) {
    throw new TypeError("storage items must be an object");
  }
  return serialized;
}

function select(data, keys) {
  if (keys === null || keys === undefined) {
    return clone(data);
  }

  if (typeof keys === "string") {
    return Object.hasOwn(data, keys) ? { [keys]: clone(data[keys]) } : {};
  }

  if (Array.isArray(keys)) {
    return Object.fromEntries(
      keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, clone(data[key])]),
    );
  }

  if (typeof keys === "object") {
    return Object.fromEntries(
      Object.entries(keys).map(([key, fallback]) => [
        key,
        Object.hasOwn(data, key) ? clone(data[key]) : clone(fallback),
      ]),
    );
  }

  throw new TypeError("storage keys must be a string, array, object, or null");
}

export function createChromeStorageFake(initial = {}) {
  let data = serializeItems(initial);
  const failures = new Map();
  const holds = new Map();
  const operations = [];
  const runtime = {};

  function invoke(method, args, operation) {
    const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
    const promise = (async () => {
      operations.push({ method, phase: "start" });
      await Promise.resolve();

      const hold = holds.get(method)?.shift();
      if (hold && !hold.after) {
        hold.startedResolve();
        await hold.released;
      }

      const failure = failures.get(method)?.shift();
      if (failure) {
        throw failure;
      }

      const result = operation();
      if (hold?.after) {
        hold.startedResolve();
        await hold.released;
      }
      operations.push({ method, phase: "finish" });
      return clone(result);
    })();

    if (!callback) {
      return promise;
    }

    promise.then(
      (result) => callback(result),
      (error) => {
        runtime.lastError = { message: error.message };
        try {
          callback();
        } finally {
          delete runtime.lastError;
        }
      },
    );
    return undefined;
  }

  const local = {
    get(...args) {
      return invoke("get", args, () => select(data, args[0]));
    },
    set(...args) {
      const items = serializeItems(args[0]);
      return invoke("set", args, () => {
        for (const key of Object.keys(items)) {
          Object.defineProperty(data, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: items[key],
          });
        }
      });
    },
  };

  return {
    local,
    runtime,
    operations,
    locks: createLockManagerFake(),
    snapshot() {
      return clone(data);
    },
    failNext(method, error = new Error(`storage ${method} failed`)) {
      const queued = failures.get(method) ?? [];
      queued.push(error);
      failures.set(method, queued);
    },
    holdNext(method, { after = false } = {}) {
      let startedResolve;
      let release;
      const started = new Promise((resolve) => {
        startedResolve = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      const queued = holds.get(method) ?? [];
      queued.push({ after, startedResolve, released });
      holds.set(method, queued);
      return { started, release };
    },
  };
}

export function createLockManagerFake() {
  const lockStates = new Map();

  function processQueue(name, state) {
    if (state.active) {
      return;
    }

    const entry = state.queue.shift();
    if (!entry) {
      lockStates.delete(name);
      return;
    }

    state.active = true;
    entry.started = true;
    entry.signal?.removeEventListener("abort", entry.abort);
    Promise.resolve()
      .then(() => entry.callback({ name, mode: "exclusive" }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        state.active = false;
        processQueue(name, state);
      });
  }

  return {
    request(name, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }

      const signal = options?.signal;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }

        const state = lockStates.get(name) ?? { active: false, queue: [] };
        lockStates.set(name, state);
        const entry = {
          callback,
          resolve,
          reject,
          signal,
          started: false,
          abort() {
            if (entry.started) {
              return;
            }
            const index = state.queue.indexOf(entry);
            if (index !== -1) {
              state.queue.splice(index, 1);
            }
            reject(signal.reason);
            processQueue(name, state);
          },
        };
        signal?.addEventListener("abort", entry.abort, { once: true });
        state.queue.push(entry);
        processQueue(name, state);
      });
    },
  };
}
