import ffmpeg from 'fluent-ffmpeg';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const ffprobe = promisify(ffmpeg.ffprobe);

async function probe(path) {
  let meta;
  try {
    meta = await ffprobe(path);
  } catch (err) {
    let size = '?';
    try {
      size = (await stat(path)).size;
    } catch {}
    throw new Error(`ffprobe failed on ${path} (size: ${size} bytes): ${err.message}`);
  }
  const duration = parseFloat(meta.format.duration);
  const size = Number(meta.format.size) || (await stat(path)).size;
  return { duration, size };
}

// Short clips skip FILTERS: on a few-second voice note the speedup and silence
// trim cost Gemini words ("34 ming" heard as "30-o'rin") and save next to nothing.
const MIN_FILTER_SECONDS = 120;

// Trim silences (>0.5s, <-50dB, with 0.5s padding) and speed up 1.25×.
const FILTERS =
  'silenceremove=start_periods=1:start_duration=0.5:start_silence=0.5:start_threshold=-50dB:stop_periods=-1:stop_duration=0.5:stop_silence=0.5:stop_threshold=-50dB,atempo=1.25';

export async function optimize(input, output) {
  const before = await probe(input);
  const filtered = before.duration >= MIN_FILTER_SECONDS;

  let ffmpegStderr = '';
  await new Promise((resolve, reject) => {
    ffmpeg(input, { timeout: 300 })
      .noVideo()
      .audioCodec('libopus')
      .audioBitrate('24k')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('ogg')
      .audioFilters(filtered ? FILTERS : [])
      .on('stderr', line => {
        ffmpegStderr += line + '\n';
      })
      .on('error', err => reject(new Error(`ffmpeg failed: ${err.message}\nstderr tail:\n${ffmpegStderr.slice(-800)}`)))
      .on('end', resolve)
      .save(output);
  });

  const outStat = await stat(output).catch(() => null);
  if (!outStat || (filtered && outStat.size < 1000)) {
    throw new Error(`Optimization produced empty/tiny output (${outStat?.size ?? 'no file'} bytes); silenceremove consumed (almost) the entire input.`);
  }

  const after = await probe(output);

  return {
    originalDuration: before.duration,
    optimizedDuration: after.duration,
    originalSize: before.size,
    optimizedSize: after.size,
    durationSavings: 1 - after.duration / before.duration,
  };
}
