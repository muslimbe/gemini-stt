// Telegram is sometimes unreachable for a few seconds from the server
// (ETIMEDOUT, ECONNRESET). Network failures are retried with backoff; an
// answer from Telegram itself (an API error) is never retried.
const ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// node-fetch (Telegraf) marks network failures type "system"; undici (fetch) wraps them as a TypeError with a cause.
const isNetworkError = err => err?.type === 'system' || (err instanceof TypeError && err.cause !== undefined);

export async function withRetry(fn, onRetry = () => {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isNetworkError(err) || attempt >= ATTEMPTS) throw err;
      onRetry(err, attempt);
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
