import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// Cloud Bot API: files up to 20 MB, fetched over HTTPS.
export async function downloadFile(telegram, fileId, destPath) {
  const url = await telegram.getFileLink(fileId);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(destPath));
}
