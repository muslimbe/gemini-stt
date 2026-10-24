import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { optimize } from './audio.js';
import { createClient, transcribe, estimateCost } from './gemini.js';
import { acquireSlot, releaseSlot } from './queue.js';
import { logSuccess, logFailure } from './logger.js';

const gemini = createClient(config.geminiApiKey);
const noop = () => {};

// One job, shared by the MCP tool and the bot. `source(tempDir)` resolves to the
// input file (the bot downloads it into tempDir). `ui` hooks let the bot show
// progress; the MCP tool passes none. Returns the transcript; throws with the
// reason on failure, after logging it under `label`.
export async function run({ label, source, ui = {} }) {
  const { queued = noop, optimizing = noop, optimized = noop, retry = noop } = ui;
  await acquireSlot(queued);

  const jobStart = Date.now();
  let tempDir = null;
  let opt = null;
  let retryCount = 0;

  try {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-stt-'));
    const input = await source(tempDir);

    await optimizing();
    const optimizedPath = join(tempDir, 'optimized.ogg');
    opt = await optimize(input, optimizedPath);
    optimized(opt);

    const result = await transcribe(gemini, optimizedPath, {
      model: config.geminiModel,
      onRetry: r => {
        if (r) retryCount++;
        retry(r);
      },
    });
    if (!result.text?.trim()) throw new Error('Got an empty transcript.');

    logSuccess({ label, opt, result, cost: estimateCost(result), retryCount, jobStart });
    return result.text.trim();
  } catch (err) {
    logFailure({ label, opt, retryCount, jobStart, err });
    throw err;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    releaseSlot();
  }
}
