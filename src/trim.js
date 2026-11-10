import { createHmac } from 'node:crypto';

// The Cho'rtkesar Mini App (github.com/muslimbe/chortkesar) cuts audio and
// video for this bot: it runs on the same bot token, so it can fetch a file
// the user sent here by its file_id. The link signs that file_id for the
// user who sent it, so nobody else can open it — the Mini App checks the
// signature the same way.
export const trimSignature = (fileId, userId, botToken) =>
  createHmac('sha256', botToken).update(`${fileId}:${userId}`).digest('hex').slice(0, 32);

export function trimUrl(appUrl, { fileId, userId, name, botToken }) {
  const params = new URLSearchParams({ file: fileId, sig: trimSignature(fileId, userId, botToken), name });
  return `${appUrl}/?${params}`;
}
