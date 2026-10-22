import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { config } from './config.js';
import { optimize } from './audio.js';
import { createClient, transcribe, estimateCost } from './gemini.js';
import { acquireSlot, releaseSlot } from './queue.js';
import { logSuccess, logFailure } from './logger.js';

const gemini = createClient(config.geminiApiKey);

// Transcribes one file and returns the transcript; throws with the reason on failure.
export async function run(path) {
  const input = await resolveMedia(path);
  await acquireSlot();

  const jobStart = Date.now();
  const file = basename(input);
  let tempDir = null;
  let opt = null;
  let retryCount = 0;

  try {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-stt-'));
    const optimizedPath = join(tempDir, 'optimized.ogg');
    opt = await optimize(input, optimizedPath);

    const result = await transcribe(gemini, optimizedPath, {
      model: config.geminiModel,
      onRetry: r => {
        if (r) retryCount++;
      },
    });
    if (!result.text?.trim()) throw new Error('Got an empty transcript.');

    logSuccess({ file, opt, result, cost: estimateCost(result), retryCount, jobStart });
    return result.text.trim();
  } catch (err) {
    logFailure({ file, opt, retryCount, jobStart, err });
    throw err;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    releaseSlot();
  }
}

// Only files under MEDIA_DIR (the bot's attachments, mounted read-only) may be read.
async function resolveMedia(path) {
  const root = await realpath(config.mediaDir);
  let full;
  try {
    full = await realpath(resolve(root, path));
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (!full.startsWith(root + sep)) throw new Error(`Path is outside ${config.mediaDir}: ${path}`);
  return full;
}
