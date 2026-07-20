export function createFakeScheduler(start = 0) {
  let currentTime = start;
  let nextId = 1;
  const tasks = new Map();

  function runDueTasks() {
    while (true) {
      const due = [...tasks.values()]
        .filter((task) => task.time <= currentTime)
        .sort((left, right) => left.time - right.time || left.id - right.id)[0];
      if (!due) {
        return;
      }
      tasks.delete(due.id);
      due.callback();
    }
  }

  return {
    clock: {
      now() {
        return currentTime;
      },
    },
    scheduler: {
      setTimeout(callback, delay) {
        const id = nextId;
        nextId += 1;
        tasks.set(id, { id, callback, time: currentTime + delay });
        return id;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
    },
    advanceBy(milliseconds) {
      currentTime += milliseconds;
      runDueTasks();
    },
    pendingCount() {
      return tasks.size;
    },
  };
}
