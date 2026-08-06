export function createEventQueue(capacity = 256) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new TypeError('capacity must be a positive integer');
  }

  let queue = [];
  let emitted = 0;
  let drained = 0;
  let dropped = 0;
  let clears = 0;

  function emit(type, payload) {
    if (typeof type !== 'string' || type.trim().length === 0) {
      throw new TypeError('event type must be a non-empty string');
    }
    if (queue.length >= capacity) {
      dropped += 1;
      return false;
    }
    queue.push(Object.freeze({ type, payload }));
    emitted += 1;
    return true;
  }

  function drain(handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const batch = queue;
    queue = [];
    for (const event of batch) handler(event);
    drained += batch.length;
    return batch.length;
  }

  function clear() {
    const cleared = queue.length;
    queue = [];
    clears += 1;
    return cleared;
  }

  function getStats() {
    return Object.freeze({ capacity, queued: queue.length, emitted, drained, dropped, clears });
  }

  return Object.freeze({ emit, drain, clear, getStats });
}
