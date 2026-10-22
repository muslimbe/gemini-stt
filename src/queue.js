// FIFO concurrency gate. JS is single-threaded, so the sync check + push/
// increment pair is atomic; only awaits can interleave callers.
import { config } from './config.js';

let inFlight = 0;
const waiters = [];

// Resolves once a slot is free.
export async function acquireSlot() {
  if (inFlight < config.maxConcurrent && waiters.length === 0) {
    inFlight++;
    return;
  }
  await new Promise(resolve => waiters.push(resolve));
}

// Hands the slot straight to the next waiter, so inFlight only drops when nobody waits.
export function releaseSlot() {
  const next = waiters.shift();
  if (next) next();
  else inFlight--;
}
