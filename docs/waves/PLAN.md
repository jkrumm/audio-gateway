# Podcast writer bake-off — cheaper voice owner?
**Goal:** Johannes can listen, blind, to the same podcast segments written by each candidate voice-owner model
(everything else identical: outline, brief, dossier, show bible, reviewers, Gemini 3.8 voices) on modelpick
`/tts`, next to measured cost per 20-minute episode — and pick whether Opus stays the writer.
**Why:** `podcast-segment` on `claude-opus-5-5` cost $3.41 of the last Gemini test episode, while all audio cost
$0.10. Writing is now the dominant podcast cost. Owner wants natural, witty, non-monotonous German dialogue with
strong host interaction, and is curious whether Grok is wittier.
**Gate:** `make check` here; in modelpick `make check`, `make deploy`, `make verify`. Spend caps: IU **$4**,
OpenRouter **$0.50**. Never push or `make deploy` audio-gateway while a podcast job runs. **No production config
change** in this wave — the writer default stays `claude-opus-5-5` until the owner decides.

## Established — do not re-derive
- Pipeline: `src/podcast-script.ts` (`writePodcastScript`, `callPodcastLlm` — `claude-*` on the native
  Anthropic wire with adaptive thinking, others on OpenAI chat completions; `resolveReasoningEffort`). Roles in
  `src/config.ts`: outline/editorial/metadata `deepseek-v4.1-flash`, voice owner `PODCAST_WRITE_MODEL`
  `claude-opus-5-5`, reviewers `gemini-3.8-flash,deepseek-v4.1-flash`, synth `gemini-3.8-flash-tts`
  (Charon + Erinome, multi-speaker runs ≤3,000 chars, `src/podcast-synth.ts`). Show bible `docs/show-bible.md`.
- Source material: episode `8ee3a4df-445a-4e57-ae37-d151aea362a5` ("Factory v2.2", 20 min) — `data/podcasts/
  <id>/{brief,dossier,script}.json`, request in `data/podcasts.db` table `podcast_job.request_json`. The outline is
  NOT stored: generate it once with the production outline model and freeze it for every candidate.
- Candidates (IU unless noted; $/M out; evidence 2026-10-25 research — EQ-Bench Creative Writing v3 Elo, LMArena):
  `claude-opus-5-5` baseline ($20; LMArena creative #1, EQ 2051) · `claude-sonnet-5-5` ($10; LMArena #22) ·
  `claude-haiku-5-5` ($0.50; no evidence) · `gpt-6-sol` ($10; EQ 2125 #4) · `kimi-k3` ($15; EQ 2084, German arena
  #5) · `glm-5.3` ($4.40; EQ 2077, German #13) · `deepseek-v4.1-flash` ($1.20; German #17) · **`grok-4.7`** ($6;
  EQ 2012 but highest rubric 17.16) — NOT on IU: call OpenRouter `x-ai/grok-4.7`
  (`https://openrouter.ai/api/v1`, key `op://common/openrouter/API_KEY`, resolve with `secrets-run`; it is the
  email-gateway key with a $10/month cap, so this one-off test must stay ≤ $0.50). Keep the OpenRouter route
  script-local (an injected base URL/key for the bake-off), not a production code path.
- No German creative-writing evidence exists for any of them — the listening test is the evidence.

## Wave 1 — Write, voice, measure            <!-- status: active -->
- [ ] `scripts/writer-bakeoff.ts`: load the episode's brief + dossier, generate + freeze one outline, then for each
      candidate run the **production** per-segment flow with the candidate as voice owner (draft → the production
      reviewer panel → the candidate's revision/tightening), for **2 segments**: the opening and the segment with
      the most host interaction. Reuse exported pipeline functions; if something must be exported, do it without
      behaviour change. Production reasoning settings per model family. Cache results to disk so a rerun skips done work
- [ ] Per candidate record: words vs target, wall time, input/output tokens, cost (list price, source), retries /
      parse failures, tag-allowlist violations (`SPEECH_TAGS`), and a projected **writer cost per 20-minute episode**
      (scale by the episode's real segment count and the measured revisions)
- [ ] Synthesize every candidate's 2 segments with the production Gemini multi-speaker path (identical settings)
- [ ] modelpick: copy audio into `data/tts-compare/audio/`, add samples (new `set: "writer"`) to
      `data/tts-compare/manifest.json`, and a new open question "Podcast writer" in
      `src/server/audio/experiments.ts` — rows = segment (opening / interaction), columns = candidates, **blind by
      default** (letters only, reveal per card), the written script viewable per cell, and a compact cost/episode
      line revealed with the model name. It must feed the existing "Your picks" summary
- [ ] modelpick `docs/decisions/podcast-writer.md`: refresh the stale header (it still names opus-4-6 and
      ElevenLabs) and add a dated bake-off section — table (model, $/M out, cost/episode, words vs target, wall time,
      violations) + per-candidate notes, verdict **pending the owner's blind listening**
- [ ] Gates green, commit per concern in each repo, push, modelpick deployed + verified (`/tts` 200, every new audio
      file resolves). Report actual IU + OpenRouter spend
**Left behind:**
