/**
 * Lightweight in-memory Async Mutex lock to prevent race conditions
 * in concurrent read-modify-write operations.
 * A 10-second acquisition timeout prevents indefinite deadlocks.
 */
class Mutex {
  private queue: Promise<void> = Promise.resolve();
  public activeCount = 0;

  /**
   * Acquire lock and execute the provided task sequentially.
   * Rejects with a timeout error if lock cannot be acquired within 10 seconds.
   */
  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.activeCount++;
    let release: () => void = () => {};
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    const currentQueue = this.queue;
    this.queue = this.queue.then(
      () => lock,
      () => lock
    );

    // Timeout guard: reject if lock isn't acquired within 10 seconds
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let lockAcquired = false;
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error('Mutex acquisition timeout after 10s')), 10_000);
    });

    try {
      await Promise.race([currentQueue, timeout]);
      lockAcquired = true;
      if (timerId !== undefined) clearTimeout(timerId);
      return await Promise.resolve().then(() => task());
    } catch (e) {
      if (!lockAcquired) {
        currentQueue.finally(release).catch(() => {});
      }
      throw e;
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
      if (lockAcquired) {
        release();
      }
      this.activeCount--;
    }
  }
}

const namedMutexes = new Map<string, Mutex>();

/**
 * Run an async function within a named lock context.
 */
export async function withLock<T>(lockName: string, task: () => Promise<T>): Promise<T> {
  let mutex = namedMutexes.get(lockName);
  if (!mutex) {
    mutex = new Mutex();
    namedMutexes.set(lockName, mutex);
  }
  try {
    return await mutex.runExclusive(task);
  } finally {
    if (mutex.activeCount === 0 && namedMutexes.get(lockName) === mutex) {
      namedMutexes.delete(lockName);
    }
  }
}

/**
 * Helper lock specifically for inbox storage operations.
 */
export async function withInboxLock<T>(task: () => Promise<T>): Promise<T> {
  return withLock('inbox_storage_lock', task);
}
