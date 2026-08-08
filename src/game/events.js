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

export function createPresentationEventConsumer({ capacity = 64, onEvent = null } = {}) {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new TypeError('presentation event capacity must be a positive integer');
  }
  if (onEvent !== null && typeof onEvent !== 'function') {
    throw new TypeError('presentation event handler must be a function or null');
  }
  const recent = new Array(capacity).fill(null);
  let cursor = 0;
  let count = 0;
  let consumed = 0;
  let overwritten = 0;

  function consume(event) {
    onEvent?.(event);
    if (count === capacity) overwritten += 1;
    recent[cursor] = event;
    cursor = (cursor + 1) % capacity;
    count = Math.min(capacity, count + 1);
    consumed += 1;
    return true;
  }

  function getRecent() {
    const snapshot = new Array(count);
    const start = (cursor - count + capacity) % capacity;
    for (let index = 0; index < count; index += 1) {
      snapshot[index] = recent[(start + index) % capacity];
    }
    return Object.freeze(snapshot);
  }

  function reset() {
    recent.fill(null);
    cursor = 0;
    count = 0;
    return true;
  }

  function getStats() {
    return Object.freeze({ capacity, count, consumed, overwritten, recent: getRecent() });
  }

  return Object.freeze({ consume, reset, getStats });
}
