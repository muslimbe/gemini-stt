// Lift Node's bundled undici headersTimeout (default 5 min) so long Gemini
// transcriptions don't fail with UND_ERR_HEADERS_TIMEOUT after we've been
// billed. Done via the public global-dispatcher symbol to avoid pulling a
// separate `undici` npm package, which would clash with Node's bundled version.
{
  const sym = Symbol.for('undici.globalDispatcher.1');
  fetch('data:,').catch(() => {}); // trigger lazy init of the global dispatcher
  const Agent = globalThis[sym].constructor;
  globalThis[sym] = new Agent({ headersTimeout: 60 * 60 * 1000, bodyTimeout: 60 * 60 * 1000 });
}

function str(name, fallback) {
  const v = process.env[name] || fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function int(name, fallback) {
  const v = str(name, fallback);
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${name}: ${v}`);
  return n;
}

export const config = {
  // Server
  port: int('PORT', 8080),
  // Where the bot's attachments are mounted; the same path as inside the tars
  // container, so the path in an [attachment: …] marker works here verbatim.
  mediaDir: str('MEDIA_DIR', '/app/data/attachments'),

  // Gemini
  geminiApiKey: str('GEMINI_API_KEY'),
  geminiModel: str('GEMINI_MODEL', 'gemini-3.5-flash'),

  // Concurrency
  maxConcurrent: Math.max(1, int('MAX_CONCURRENT', 4)),
};
