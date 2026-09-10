import { audioDuration, compressForStt, detectSilence, sliceAudio, type SilenceRange } from "./audio";
import { config } from "./config";
import { log } from "./log";

// The IU upstream (`POST /audio/transcriptions`) has four measured limits:
// a 25 MiB (26,214,400-byte) request-body ceiling (HTTP 500, empty body);
// gpt-4o-transcribe 400s over 1400s of audio; plain whisper's ~230s
// processing timeout (10 min took 136s); and gpt-4o-transcribe SILENTLY
// truncating output around 20 min of audio, with no error at all. This
// module is the deep module that makes an uploaded file fit both axes: short
// clips pass through untouched (fast path, no ffmpeg); anything larger is
// compressed to 16 kHz mono mp3 (lossless for STT — Whisper-class models
// resample to 16 kHz mono internally anyway) and, if still too big or too
// long, time-sliced into upload-sized, duration-bounded chunks whose cut
// points are snapped to nearby silence (`detectSilence`/`snapBoundaries`) so
// chunk boundaries fall between words instead of through them.

export interface PreparedSttInput {
  parts: File[];
  compressed: boolean;
  totalSeconds: number;
}

/** Thrown when even the smallest allowed chunk count exceeds `config.sttMaxSttChunks` — callers map this to a 413. */
export class SttChunkLimitError extends Error {}

/**
 * Thrown when a sliced chunk is still over `config.sttMaxUploadBytes` after
 * re-encoding — resending it upstream unchanged would only reproduce the
 * empty-bodied 25 MiB 500 the chunking exists to prevent, so callers must map
 * this to a client error (413) rather than the generic ffmpeg-failure fallback.
 */
export class SttChunkTooLargeError extends Error {}

/** Slack applied to the chunk count so per-chunk rounding never leaves a chunk over the limit. */
const CHUNK_COUNT_SLACK = 1.1;

const mp3File = (name: string, bytes: ArrayBuffer): File =>
  new File([bytes], name, { type: "audio/mpeg" });

const withMp3Extension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return `${dot === -1 ? name : name.slice(0, dot)}.mp3`;
};

/**
 * Snap each hard target cut point (`targets`, e.g. `[600, 1200, 1800]`) to the
 * midpoint of the nearest silence range whose midpoint lies within
 * `opts.windowSec`, so a chunk boundary falls in a pause rather than through a
 * word. A target with no silence in its window is left unchanged. A snap is
 * discarded — falling back to the hard target — if it would make the
 * boundary sequence non-increasing, push it outside `(0, opts.totalSeconds)`,
 * or push EITHER chunk adjacent to it (the one ending at this boundary, using
 * the already-decided previous boundary; the one starting at it, using the
 * next hard target — or `opts.totalSeconds` for the last boundary, since the
 * final chunk always runs to the end of the file) over `opts.maxChunkSeconds`.
 * Without that second check, two adjacent boundaries can independently drift
 * up to `windowSec` in opposite directions and yield a chunk far longer than
 * `maxChunkSeconds` even though each snap looked valid in isolation. Pure: no
 * ffmpeg, no config reads, no I/O.
 */
export function snapBoundaries(
  targets: number[],
  silences: SilenceRange[],
  opts: { windowSec: number; totalSeconds: number; maxChunkSeconds: number },
): number[] {
  const boundaries: number[] = [];
  let prev = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i] as number;
    let snapped: number | null = null;
    let bestDist = Infinity;
    for (const range of silences) {
      const midpoint = (range.start + range.end) / 2;
      const dist = Math.abs(midpoint - target);
      if (dist <= opts.windowSec && dist < bestDist) {
        snapped = midpoint;
        bestDist = dist;
      }
    }
    const nextBound = i + 1 < targets.length ? (targets[i + 1] as number) : opts.totalSeconds;
    const isValid = (b: number): boolean =>
      b > prev &&
      b < opts.totalSeconds &&
      b - prev <= opts.maxChunkSeconds &&
      nextBound - b <= opts.maxChunkSeconds;
    const boundary = snapped !== null && isValid(snapped) ? snapped : target;
    boundaries.push(boundary);
    prev = boundary;
  }
  return boundaries;
}

/**
 * Make `file` fit the upstream's per-request size AND duration limits. Fast
 * path: a file already under both `config.sttMaxUploadBytes` and
 * `config.sttMaxChunkSeconds` is returned untouched after one cheap ffprobe
 * duration check — no re-encode, no silence detection. Otherwise compresses
 * to mp3 and, if the compressed file is still too big or too long, time-slices
 * it into `config.sttMaxSttChunks`-bounded chunks whose boundaries are snapped
 * to nearby silence (`detectSilence`/`snapBoundaries`).
 */
export async function prepareSttInput(file: File): Promise<PreparedSttInput> {
  if (file.size <= config.sttMaxUploadBytes) {
    const duration = await audioDuration(file);
    if (duration <= config.sttMaxChunkSeconds) {
      return { parts: [file], compressed: false, totalSeconds: duration };
    }
  }

  const original = new Uint8Array(await file.arrayBuffer());
  const compressedBytes = await compressForStt(original, { bitrateKbps: config.sttCompressBitrateKbps });
  const compressedU8 = new Uint8Array(compressedBytes);
  const compressedName = withMp3Extension(file.name);
  const totalSeconds = await audioDuration(compressedBytes);

  const sizeChunks = Math.ceil((compressedBytes.byteLength / config.sttMaxUploadBytes) * CHUNK_COUNT_SLACK);
  const durationChunks = Math.ceil(totalSeconds / config.sttMaxChunkSeconds);
  const chunkCount = Math.max(sizeChunks, durationChunks, 1);

  if (chunkCount <= 1) {
    return { parts: [mp3File(compressedName, compressedBytes)], compressed: true, totalSeconds };
  }

  if (chunkCount > config.sttMaxSttChunks) {
    throw new SttChunkLimitError(
      `upload too large: would need ${chunkCount} chunks, exceeding the ${config.sttMaxSttChunks}-chunk limit`,
    );
  }

  const targets = Array.from({ length: chunkCount - 1 }, (_, i) => ((i + 1) * totalSeconds) / chunkCount);
  const silences = await detectSilence(compressedU8, {
    noiseDb: config.sttSilenceNoiseDb,
    minDurationSec: config.sttSilenceMinSec,
  });
  const boundaries = snapBoundaries(targets, silences, {
    windowSec: config.sttSilenceWindowSec,
    totalSeconds,
    maxChunkSeconds: config.sttMaxChunkSeconds,
  });
  const snappedCount = boundaries.filter((b, i) => b !== targets[i]).length;
  log.info("stt chunking", { chunkCount, totalSeconds, snappedBoundaries: snappedCount, hardBoundaries: boundaries.length - snappedCount });

  // [0, ...boundaries, totalSeconds] — one array covering every cut point, so
  // start/end for chunk `i` is always `cuts[i]`/`cuts[i + 1]`, both in-bounds
  // by construction. Avoids two separately-indexed `boundaries[...]` casts
  // that could otherwise flow `NaN` into ffmpeg's `-t` on an off-by-one.
  const cuts = [0, ...boundaries, totalSeconds];

  const parts: File[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const startSec = cuts[i];
    const endSec = cuts[i + 1];
    if (startSec === undefined || endSec === undefined) {
      throw new Error(`internal error: chunk cut index ${i} out of range for ${chunkCount} chunks`);
    }
    const isLast = i === chunkCount - 1;
    // Last chunk runs to the end of the file (no `-t`), so the tail of the
    // recording is never truncated.
    const durationSec = isLast ? null : endSec - startSec;
    // Slice from the ORIGINAL upload, not the already-compressed mp3 — slicing
    // the compressed buffer would put every multi-chunk recording through two
    // lossy encodes. The compressed buffer is only used above for probing
    // duration and detecting silence; its timeline is identical to the
    // original's, so the boundaries transfer directly.
    const sliceBytes = await sliceAudio(original, startSec, durationSec, {
      bitrateKbps: config.sttCompressBitrateKbps,
    });
    if (sliceBytes.byteLength > config.sttMaxUploadBytes) {
      throw new SttChunkTooLargeError(
        `chunk ${i + 1}/${chunkCount} is still ${sliceBytes.byteLength} bytes, over the ${config.sttMaxUploadBytes}-byte upload limit`,
      );
    }
    parts.push(mp3File(`${withMp3Extension(file.name).replace(/\.mp3$/, "")}.part${i + 1}.mp3`, sliceBytes));
  }

  return { parts, compressed: true, totalSeconds };
}
