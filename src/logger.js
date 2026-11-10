import { inspect } from 'node:util';
import { config } from './config.js';
import { fmtDuration, fmtBytes } from './format.js';
import { extractReason } from './gemini.js';

const ts = () => new Date().toLocaleString('sv');
const fmtRetries = n => (n ? ` · ${n} ${n === 1 ? 'retry' : 'retries'}` : '');
const optPart = opt => (opt ? ` · ${fmtDuration(opt.originalDuration)} (${fmtBytes(opt.originalSize)}) → ${fmtDuration(opt.optimizedDuration)}` : '');
const stripModel = m => m.replace('gemini-', '');
// estimateCost() knows only the models in its PRICING table.
const fmtCost = cost => (cost == null ? '$?' : `$${cost.toFixed(4)}`);

// stdout only: `docker compose logs` is the log.
export const log = line => console.log(`[${ts()}] ${line}`);

export function logSuccess({ label, opt, result, cost, retryCount, jobStart }) {
  const elapsed = (Date.now() - jobStart) / 1000;
  log(`✓ ${label}${optPart(opt)} · ${stripModel(result.model)} · ${fmtCost(cost)} · ${result.text.length} chars · ${fmtDuration(elapsed)} total${fmtRetries(retryCount)}`);
}

export function logFailure({ label, opt, retryCount, jobStart, err }) {
  const elapsed = (Date.now() - jobStart) / 1000;
  log(`✗ ${label}${optPart(opt)} · ${stripModel(config.geminiModel)} · ${fmtDuration(elapsed)} total${fmtRetries(retryCount)} · failed: ${extractReason(err)}`);
  // Full error with stack and cause chain — for diagnosing "fetch failed" and similar opaque errors.
  log(inspect(err, { depth: 5 }));
}
