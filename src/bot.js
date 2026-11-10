import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Telegraf, Input } from 'telegraf';
import { message } from 'telegraf/filters';
import { config, botConfig } from './config.js';
import * as allowlist from './allowlist.js';
import { downloadFile } from './download.js';
import { run } from './pipeline.js';
import { fmtOutput, fmtBytes } from './format.js';
import { log } from './logger.js';
import { withRetry } from './network.js';
import * as status from './status.js';
import { trimUrl } from './trim.js';

const cfg = botConfig();

// The cloud Bot API's getFile limit.
const MAX_DOWNLOAD = 20 * 1024 * 1024;

const isAdmin = id => id === cfg.adminUserId;
const isAllowed = id => isAdmin(id) || allowlist.has(id);
const userTag = u => `${u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ')} (${u.id})`;

const bot = new Telegraf(cfg.botToken, {
  handlerTimeout: 60 * 60 * 1000, // media handlers are fire-and-forget, so this only guards command replies; keep it above the undici timeouts (config.js) so a stalled Telegram call times out there first
});

// Every Bot API call (replies, status edits, getFile) retries network failures.
const callApi = bot.telegram.callApi.bind(bot.telegram);
bot.telegram.callApi = (method, ...args) =>
  withRetry(
    () => callApi(method, ...args),
    (err, attempt) => log(`telegram ${method} failed (${err.code ?? err.message}), retry ${attempt}`),
  );

// DM-only: silently drop anything from groups/channels.
bot.use((ctx, next) => (ctx.chat?.type === 'private' ? next() : undefined));

const WELCOME = 'Send me a voice note, audio file, or video. I will transcribe and reply.';

const fmtWhoami = (u, allowed) => `ID: ${u.id}\nUsername: @${u.username ?? '(none)'}\nStatus: ${allowed ? 'authorized ✓' : 'not authorized — contact the admin'}`;

// /start and /whoami work for everyone in DMs (regardless of allowlist).
bot.start(ctx => {
  const u = ctx.from;
  const allowed = isAllowed(u.id);
  if (allowed) return ctx.reply(WELCOME);
  log(`/start unauthorized — id=${u.id}, username=@${u.username ?? 'none'}`);
  return ctx.reply(`${WELCOME}\n\n${fmtWhoami(u, false)}`);
});

bot.command('whoami', ctx => {
  const u = ctx.from;
  const allowed = isAllowed(u.id);
  if (!allowed) {
    log(`/whoami unauthorized — id=${u.id}, username=@${u.username ?? 'none'}`);
  }
  return ctx.reply(fmtWhoami(u, allowed));
});

// Admin commands.
bot.command('allow', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!Number.isInteger(id)) return ctx.reply('Usage: /allow <user_id>');
  allowlist.add(id);
  return ctx.reply(`Allowed: ${id}`);
});

bot.command('deny', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!Number.isInteger(id)) return ctx.reply('Usage: /deny <user_id>');
  allowlist.remove(id);
  return ctx.reply(`Denied: ${id}`);
});

bot.command('list', ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const ids = allowlist.list();
  return ctx.reply(ids.length ? `Allowed users (${ids.length}):\n${ids.join('\n')}` : 'Allowlist is empty.');
});

// Allowlist: everyone else gets told once per run (not once per message) and is otherwise ignored.
const refused = new Set();
bot.use((ctx, next) => {
  const u = ctx.from;
  if (isAllowed(u?.id)) return next();
  if (!u || refused.has(u.id)) return;
  refused.add(u.id);
  log(`unauthorized message — id=${u.id}, username=@${u.username ?? 'none'}`);
  return ctx.reply(fmtWhoami(u, false));
});

// Media handlers — audio + video (ffmpeg extracts a video's audio track). Nothing
// starts on its own: the user picks transcribing or cutting, since waiting for a
// transcript is wasted time when they came to cut.
bot.on(message('voice'), ctx => offer(ctx, ctx.message.voice, 'voice.ogg'));
bot.on(message('audio'), ctx => offer(ctx, ctx.message.audio, 'audio'));
bot.on(message('video'), ctx => offer(ctx, ctx.message.video, 'video.mp4'));
bot.on(message('video_note'), ctx => offer(ctx, ctx.message.video_note, 'video_note.mp4'));
bot.on(message('document'), ctx => {
  const d = ctx.message.document;
  const mime = d.mime_type ?? '';
  if (!mime.startsWith('audio/') && !mime.startsWith('video/')) {
    return ctx.reply(`Document is not audio or video (mime: ${mime || '?'}). Ignored.`);
  }
  return offer(ctx, d, 'file');
});

const CHOOSE = 'Nima qilamiz?';
const TRANSCRIBE = 'transcribe';
const transcribeRow = [{ text: "📝 Matnga o'girish", callback_data: TRANSCRIBE }];

// The "Cut" button opens the Mini App with this file; over Telegram's 20 MB
// download cap it opens the Mini App's own file picker instead.
function cutRow(ctx, file, fallbackName) {
  if (!cfg.trimAppUrl) return [];
  const url =
    file.file_size > MAX_DOWNLOAD
      ? cfg.trimAppUrl
      : trimUrl(cfg.trimAppUrl, { fileId: file.file_id, userId: ctx.from.id, name: file.file_name ?? fallbackName, botToken: cfg.botToken });
  return [[{ text: '✂️ Kesish', web_app: { url } }]];
}

function offer(ctx, file, fallbackName) {
  const tooBig = file.file_size > MAX_DOWNLOAD;
  const text = tooBig ? `${CHOOSE}\n\nFayl ${fmtBytes(file.file_size)}: Telegram botga 20 MB gacha beradi, shuning uchun matnga o'girib bo'lmaydi. Kesish uchun faylni ilovada qayta tanlang.` : CHOOSE;
  const rows = [...(tooBig ? [] : [transcribeRow]), ...cutRow(ctx, file, fallbackName)];
  if (!rows.length) return ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id } });
  return ctx.reply(text, { reply_parameters: { message_id: ctx.message.message_id }, reply_markup: { inline_keyboard: rows } });
}

// The file a choice message is about: the media message it replies to.
function chosenFile(msg) {
  const m = msg?.reply_to_message;
  return m && (m.voice ?? m.audio ?? m.video ?? m.video_note ?? m.document);
}

// "Transcribe" pressed: drop that button (it can't run twice), keep "Cut", run the job.
// Fire-and-forget (`void`): Telegraf won't fetch the next getUpdates batch until
// every handler resolves, so awaiting a multi-minute transcription here would
// freeze /start and all other updates for its whole duration. handle() never
// rejects, so dropping the promise is safe.
bot.action(TRANSCRIBE, async ctx => {
  const msg = ctx.callbackQuery.message;
  const file = chosenFile(msg);
  if (!file) return ctx.answerCbQuery('Fayl topilmadi, qaytadan yuboring.');
  await ctx.answerCbQuery();
  const rows = (msg.reply_markup?.inline_keyboard ?? []).filter(row => row[0]?.callback_data !== TRANSCRIBE);
  await ctx.editMessageReplyMarkup({ inline_keyboard: rows }).catch(() => {});
  void handle(ctx, file, msg.reply_to_message.message_id);
});

// One status message per job, edited as it moves along; the transcript is a
// reply to the user's file. Never rejects: every failure ends up in the status
// message or the log.
async function handle(ctx, file, replyTo) {
  const ui = status.createStatus(ctx);
  const progress = { block: '', retry: null };
  let text;
  try {
    text = await run({ label: userTag(ctx.from), source: dir => download(ctx, file, ui, dir), ui: hooks(ui, progress) });
  } catch (err) {
    ui.stopTicker();
    await ui.finish(status.failure(progress.block, err?.message ?? String(err))).catch(() => {});
    return;
  }
  ui.stopTicker();
  try {
    await sendTranscript(ctx, text, replyTo);
    await ui.finish(progress.block);
  } catch (err) {
    log(`✗ ${userTag(ctx.from)} · transcript not delivered: ${err?.message ?? err}`);
  }
}

async function download(ctx, file, ui, dir) {
  await ui.show(status.DOWNLOADING);
  const path = join(dir, 'input');
  await downloadFile(ctx.telegram, file.file_id, path);
  return path;
}

// Pipeline progress → status message. Queue position is cosmetic, so its send
// failures don't fail the job.
const hooks = (ui, progress) => ({
  queued: pos => ui.show(status.queued(pos)).catch(() => {}),
  optimizing: () => ui.show(status.OPTIMIZING),
  optimized: opt => {
    progress.block = status.optimizedBlock(opt);
    ui.startTicker(() => status.transcribing(progress.block, progress.retry));
  },
  retry: r => {
    progress.retry = r;
  },
});

function sendTranscript(ctx, text, replyTo) {
  const extra = { reply_parameters: { message_id: replyTo } };
  const output = fmtOutput(text, randomBytes(3).toString('hex'));
  if (output.kind === 'message') return ctx.reply(output.text, extra);
  return ctx.replyWithDocument(Input.fromBuffer(Buffer.from(output.content), output.filename), extra);
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

log(`▶ starting bot`);
log(`  model:         ${config.geminiModel}`);
log(`  admin:         ${cfg.adminUserId}`);
log(`  allowed users: ${allowlist.list().join(', ') || '(none — only admin works)'}`);

const baseCommands = [
  { command: 'start', description: 'Welcome message' },
  { command: 'whoami', description: 'Show your Telegram ID and authorization status' },
];

await bot.telegram.setMyCommands(baseCommands);

// Extra commands visible only in the admin's DM with the bot.
await bot.telegram.setMyCommands(
  [
    ...baseCommands,
    { command: 'allow', description: 'Allow a user — /allow <user_id>' },
    { command: 'deny', description: 'Deny a user — /deny <user_id>' },
    { command: 'list', description: 'List allowed users' },
  ],
  { scope: { type: 'chat', chat_id: cfg.adminUserId } },
);

bot.launch();
