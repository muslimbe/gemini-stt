import { fmtDuration, fmtBytes } from './format.js';

const PHRASES = ['Listening', 'Decoding', 'Diarizing', 'Transcribing', 'Untangling', 'Disambiguating', 'Distilling', 'Crystallizing', 'Discerning', 'Synthesizing', 'Annotating', 'Polishing'];

export function queued(pos) {
  const ahead = pos - 1;
  if (ahead === 0) return `⏳ Queued — you're next…`;
  return `⏳ Queued — ${ahead} ${ahead === 1 ? 'job' : 'jobs'} ahead of you…`;
}

export const DOWNLOADING = '📥 Downloading from Telegram…';
export const OPTIMIZING = '🔧 Optimizing audio…';

export const optimizedBlock = opt =>
  `🔧 Optimized\n${fmtDuration(opt.originalDuration)} → ${fmtDuration(opt.optimizedDuration)} (-${(opt.durationSavings * 100).toFixed(0)}%)\n${fmtBytes(opt.originalSize)} → ${fmtBytes(opt.optimizedSize)}`;

export function transcribing(block, retry) {
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  const retryText = retry ? ` (retry ${retry.attempt}/${retry.maxRetries})` : '';
  return `${block}\n\n🎙 ${phrase}…${retryText}`;
}

export const failure = (block, errMsg) => (block ? `${block}\n\n` : '') + `❌ ${errMsg}`;

// Sends one Telegram message and edits it over time. Edit failures (rate
// limits, deleted message, etc.) are silently swallowed — they aren't
// actionable and would otherwise crash the ticker. The FIRST send (ctx.reply)
// does reject on purpose: the bot relies on it to abort a job early when the
// user can't receive messages (before any download/Gemini spend), so callers
// where the message is merely cosmetic must add their own .catch(() => {}).
export function createStatus(ctx) {
  let currentText = '';
  let messageId = null;
  let timer = null;

  async function show(text) {
    if (text === currentText) return;
    if (!messageId) {
      const sent = await ctx.reply(text);
      messageId = sent.message_id;
      currentText = text;
      return;
    }
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text);
      currentText = text;
    } catch {}
  }

  function stopTicker() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startTicker(fn) {
    stopTicker();
    const tick = () => show(fn());
    tick();
    timer = setInterval(tick, 2000);
  }

  async function finish(text) {
    stopTicker();
    await show(text);
  }

  return { show, startTicker, stopTicker, finish };
}
