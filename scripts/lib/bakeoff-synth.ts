/** Shared by the writer harnesses: voice one segment through the production Gemini multi-speaker path into an mp3. */
import { writeFile } from "node:fs/promises";
import type { PodcastScriptRequest, ScriptSegment } from "../../src/podcast-script";

export async function synthesizeSegment(req: PodcastScriptRequest, segment: ScriptSegment, outPath: string): Promise<void> {
  // Dynamic imports: the harness sets USAGE_DB before the first config/usage import, which a static import here would defeat.
  const { config } = await import("../../src/config");
  const synth = await import("../../src/podcast-synth");
  const mux = await import("../../src/podcast-mux");
  const podcasts = await import("../../src/podcasts");
  const turns = synth.turnsForSynthesis([segment], req.hosts, req.language, {
    denseThreshold: config.podcastDenseTurnThreshold,
    denseSlowdown: config.podcastDenseTurnSlowdown,
  });
  const units = synth.unitsForMultiSpeaker(turns, [segment.turns.length], config.podcastMultiSpeakerMaxChars);
  const outputs = await synth.synthesizeGeminiUnits(turns, units, {
    model: config.podcastTtsModel,
    concurrency: config.ttsConcurrency,
    hostStyles: config.podcastHostStyles,
  });
  const levelled = await mux.matchHostLoudness(
    outputs.map((o, u) => {
      const speakers = new Set((units[u]?.turnIndexes ?? []).map((t) => turns[t]?.speaker));
      return { ...o, speaker: speakers.size === 1 ? [...speakers][0] ?? "AB" : "AB" };
    }),
    podcasts.PRE_MASTER_HOST_LUFS,
  );
  const muxTurns = podcasts.buildMuxTurns({
    synthOutputs: levelled.turns,
    turnTexts: units.map((unit) => turns[unit.turnIndexes[0] ?? 0]?.text ?? ""),
    gapMs: config.podcastGapMs,
    shortGapMs: config.podcastShortGapMs,
  });
  const joined = mux.concatWithGaps(muxTurns);
  const mp3 = await mux.masterPodcastMp3(joined.pcm, joined.sampleRate, {
    chapters: [{ title: segment.title, startMs: 0 }],
    tags: {
      title: segment.title, album: "writer bake-off", artist: "bake-off", albumArtist: "bake-off", comment: "",
      date: new Date().toISOString().slice(0, 10), genre: "Podcast", language: "deu", track: 1,
    },
    bitrateKbps: config.podcastBitrateKbps,
  });
  await writeFile(outPath, mp3);
}
