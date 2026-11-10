// FIFO concurrency gate. JS is single-threaded, so the sync check + push/
// increment pair is atomic; only awaits can interleave callers.
import { config } from './config.js';

let inFlight = 0;
const waiters = [];

// Resolves once a slot is free. While the caller waits, `onQueued(pos)` hears
// its position (1 = next); the bot shows it, the MCP tool doesn't care.
export async function acquireSlot(onQueued = () => {}) {
  if (inFlight < config.maxConcurrent && waiters.length === 0) {
    inFlight++;
    return;
  }
  const slot = new Promise(resolve => waiters.push({ resolve, onQueued }));
  await onQueued(waiters.length);
  await slot;
}

// Hands the slot straight to the next waiter, so inFlight only drops when nobody waits.
export function releaseSlot() {
  const next = waiters.shift();
  if (!next) {
    inFlight--;
    return;
  }
  next.resolve();
  waiters.forEach((w, i) => w.onQueued(i + 1));
}
