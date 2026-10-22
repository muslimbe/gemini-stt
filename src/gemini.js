import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 8;
const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 30_000;

// Prompt lives in src/prompt.md — edit there, restart the bot to pick up changes.
const PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'prompt.md');
const TRANSCRIPTION_PROMPT = readFileSync(PROMPT_PATH, 'utf8').trim();

// Per 1M tokens. Pro has separate rates when promptTokenCount > 200K
// (input 2×, output 1.5×). Flash is flat-rate. Output rate covers both
// candidatesTokenCount and thoughtsTokenCount.
// https://ai.google.dev/gemini-api/docs/pricing
const PRICING = {
  'gemini-2.5-flash': {
    low: { audio: 1.0, text: 0.3, output: 2.5 },
  },
  'gemini-2.5-pro': {
    low:  { audio: 1.25, text: 1.25, output: 10.0 },
    high: { audio: 2.50, text: 2.50, output: 15.0 },
  },
};

export function createClient(apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  return new GoogleGenAI({ apiKey, httpOptions: { timeout: 60 * 60 * 1000 } });
}

export async function transcribe(client, audioPath, opts = {}) {
  const { model } = opts;

  const uploaded = await withRetry(
    () =>
      client.files.upload({
        file: audioPath,
        config: { mimeType: 'audio/ogg', displayName: basename(audioPath) },
      }),
    opts.onRetry,
  );
  opts.onRetry?.(null);

  const ready = await waitUntilActive(client, uploaded.name);

  const response = await withRetry(
    () =>
      client.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { fileUri: ready.uri, mimeType: 'audio/ogg' } }],
          },
        ],
        config: { systemInstruction: TRANSCRIPTION_PROMPT },
      }),
    opts.onRetry,
  );
  opts.onRetry?.(null);

  client.files.delete({ name: ready.name }).catch(() => {});

  const usage = response.usageMetadata ?? {};
  const audioModality = usage.promptTokensDetails?.find(d => d.modality === 'AUDIO');

  return {
    text: response.text ?? '',
    model,
    promptTokens: usage.promptTokenCount ?? 0,
    audioTokens: audioModality?.tokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    thoughtsTokens: usage.thoughtsTokenCount ?? 0,
  };
}

// Gemini's ApiError stringifies as "ApiError: {json}". Pull the human-readable
// message out so it fits on one log line.
export function extractReason(err) {
  const status = err?.status ?? err?.response?.status;
  let msg = err?.message ?? String(err);
  try {
    const parsed = JSON.parse(msg.slice(msg.indexOf(':') + 1).trim());
    if (parsed?.error?.message) msg = parsed.error.message;
  } catch {}
  msg = msg.split('\n')[0].slice(0, 200);
  return status ? `${status} ${msg}` : msg;
}

export function estimateCost({ model, promptTokens, audioTokens, outputTokens, thoughtsTokens }) {
  const tiers = PRICING[model];
  if (!tiers) return null;
  const p = tiers.high && (promptTokens ?? 0) > 200_000 ? tiers.high : tiers.low;
  const textTokens = Math.max(0, (promptTokens ?? 0) - (audioTokens ?? 0));
  const outputTotal = (outputTokens ?? 0) + (thoughtsTokens ?? 0);
  return (audioTokens * p.audio + textTokens * p.text + outputTotal * p.output) / 1_000_000;
}

async function waitUntilActive(client, name) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let file = await client.files.get({ name });
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) {
      throw new Error(`File ${name} still PROCESSING after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await sleep(POLL_INTERVAL_MS);
    file = await client.files.get({ name });
  }
  if (file.state !== 'ACTIVE') {
    throw new Error(`File ${name} ended in state ${file.state}`);
  }
  return file;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, onRetry) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      if (!RETRYABLE_STATUSES.has(status) || attempt >= MAX_RETRIES) throw err;
      attempt++;
      const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.random() * BASE_BACKOFF_MS * 0.5;
      onRetry?.({ attempt, maxRetries: MAX_RETRIES });
      await sleep(delayMs);
    }
  }
}
