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
import * as status from './status.js';

const cfg = botConfig();

// The cloud Bot API's getFile limit.
const MAX_DOWNLOAD = 20 * 1024 * 1024;

const isAdmin = id => id === cfg.adminUserId;
const isAllowed = id => isAdmin(id) || allowlist.has(id);
const userTag = u => `${u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(' ')} (${u.id})`;

const bot = new Telegraf(cfg.botToken, {
  handlerTimeout: 60 * 60 * 1000, // media handlers are fire-and-forget, so this only guards command replies; keep it above the undici timeouts (config.js) so a stalled Telegram call times out there first
});

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

// Allowlist: silently ignore non-allowlisted users.
bot.use((ctx, next) => (isAllowed(ctx.from?.id) ? next() : undefined));

// Media handlers — audio + video; video runs through the same pipeline since ffmpeg extracts the audio track.
// Fire-and-forget (`void`): Telegraf won't fetch the next getUpdates batch until
// every handler resolves, so awaiting a multi-minute transcription here would
// freeze /start and all other updates for its whole duration. handle() never
// rejects, so dropping the promise is safe.
bot.on(message('voice'), ctx => void handle(ctx, ctx.message.voice));
bot.on(message('audio'), ctx => void handle(ctx, ctx.message.audio));
bot.on(message('video'), ctx => void handle(ctx, ctx.message.video));
bot.on(message('video_note'), ctx => void handle(ctx, ctx.message.video_note));
bot.on(message('document'), ctx => {
  const d = ctx.message.document;
  const mime = d.mime_type ?? '';
  if (!mime.startsWith('audio/') && !mime.startsWith('video/')) {
    return ctx.reply(`Document is not audio or video (mime: ${mime || '?'}). Ignored.`);
  }
  void handle(ctx, d);
});

// One status message per job, edited as it moves along; the transcript is a
// reply to the user's file. Never rejects: every failure ends up in the status
// message or the log.
async function handle(ctx, file) {
  if (file.file_size > MAX_DOWNLOAD) {
    await ctx.reply(`Too big: ${fmtBytes(file.file_size)}. Telegram lets bots download files up to 20 MB.`).catch(() => {});
    return;
  }
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
    await sendTranscript(ctx, text);
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

function sendTranscript(ctx, text) {
  const extra = { reply_parameters: { message_id: ctx.message.message_id } };
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
