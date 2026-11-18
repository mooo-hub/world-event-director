export function createKeyedMutex() {
  const queues = new Map();

  async function run(key, task) {
    const queueKey = String(key ?? 'default');
    const previous = queues.get(queueKey) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    queues.set(queueKey, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (queues.get(queueKey) === tail) queues.delete(queueKey);
    }
  }

  return { run };
}
