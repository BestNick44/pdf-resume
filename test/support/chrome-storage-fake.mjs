function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
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
  let data = clone(initial);
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
      return invoke("set", args, () => {
        const items = args[0];
        for (const key of Object.keys(items)) {
          Object.defineProperty(data, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: clone(items[key]),
          });
        }
      });
    },
    remove(...args) {
      return invoke("remove", args, () => {
        const keys = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const key of keys) {
          delete data[key];
        }
      });
    },
    clear(...args) {
      return invoke("clear", args, () => {
        data = {};
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
  const tails = new Map();

  return {
    request(name, callback) {
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.catch(() => {}).then(() => callback({ name, mode: "exclusive" }));
      const tail = result
        .catch(() => {})
        .finally(() => {
          if (tails.get(name) === tail) {
            tails.delete(name);
          }
        });
      tails.set(name, tail);
      return result;
    },
  };
}
