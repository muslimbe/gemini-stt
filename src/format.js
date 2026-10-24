export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '?';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

// Telegram caps messages at 4096 chars; longer transcripts ship as a file.
const MSG_THRESHOLD = 3800;

export function fmtOutput(transcript, tag) {
  if (transcript.length < MSG_THRESHOLD) {
    return { kind: 'message', text: transcript };
  }
  return { kind: 'file', filename: `transcript-${tag}.txt`, content: `${transcript}\n` };
}
