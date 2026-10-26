# Podcast quality — expressive voice, real context, fair writer rematch
**Goal:** Johannes hears podcasts that use Gemini 3.8's expressiveness on purpose (deterministically checked), whose
writers get the context a stranger-listener needs, and he picks the voice owner from a fair blind rematch of
IU-only models on `/tts` — with a cost-per-episode next to each.
**Why:** owner verdict 2026-10-26 on the first bake-off: couldn't tell the writers apart; GLM, Kimi and Grok are out
(Grok would be self-paid — not worth it); no OpenRouter. He suspects context, expression use and segmentation matter
more than the model — the evidence below agrees.
**Gate:** `make check` here; modelpick `make check`, `make deploy`, `make verify`. **IU cap $4, enforced before every
call** (Wave 1 overran because it checked per candidate). Never push or `make deploy` audio-gateway while a podcast job
runs. **Writer default stays `claude-opus-5-5`** until the owner's blind verdict.

## Established — do not re-derive
- Previous plan (bake-off + learn-and-improve) is done; see git history of this file and modelpick
  `docs/decisions/podcast-writer.md` §2026-10-26. Harness: `scripts/writer-bakeoff.ts`, `scripts/writer-lab.ts`,
  `scripts/lib/bakeoff-{inputs,synth}.ts`; artifacts `data/writer-bakeoff/`, `data/writer-lab/` (gitignored).
- **Expressiveness is switched off in practice.** The last 6 long episodes contain **0** inline tags (2,346–7,180 words
  each); the bake-off Opus interaction draft had 1 `<short pause>`, the revision removed it. Causes:
  `src/podcast-script.ts` writer rule 6 (~601: "at most one tag every six turns … Most turns carry NO tag") plus the
  fact & speech editor's "flag over-use" (~764). Both hosts always get the constant style `"warm, conversational"`
  (`src/config.ts` ~486 `PODCAST_HOST_STYLE_A/B`), dense turns `DENSE_TURN_STYLE` (`src/podcast-synth.ts`).
- **Gemini 3.8 supports per-turn delivery:** `parts[].speechMetadata.style` per multi-speaker part, a short free-text
  string, English, never spoken; measured tempo/energy effect. Rules and traps: modelpick `docs/gemini-tts.md`
  §Style control (no persona blocks, no words from the transcript, no age/gender/accent, reuse exact strings; a
  `Style:` text prefix is SPOKEN). Allowed tags: `SPEECH_TAGS` in `src/gemini-tts-core.ts`; the doc's vocalisation
  table lists more that 3.8 accepts — only add a tag after an IU check that it is not spoken.
- **Context:** the bake-off source episode `8ee3a4df` ran with `research: false` → empty dossier, **no glossary**, so
  every writer had to introduce names blind. Research is ON by default; `--no-research` in `scripts/podcast.ts` turns
  it off. Episodes with research had 17–38 glossary terms.
- **Sonnet failure (Wave 1):** `claude-sonnet-5-5` returned `[A] …` screenplay text instead of the JSON object, twice
  (`data/writer-bakeoff/fail-claude-sonnet-5-5.json`). A format-robustness bug in the claude branch of
  `callPodcastLlm`, not a quality verdict.
- **IU availability, probed 2026-10-26** (chat completions, 200 = served): `gpt-6.1-sol` ✓, `gpt-6-sol` ✓ (older),
  `gpt-6-luna` ✓, `gemini-3.8-flash` ✓ (vertex EU), `gemini-3.1-pro-preview` ✓, `gemini-4-argon` ✓;
  `gemini-3.8-pro`, `gemini-3.8-flash-lite`, `gpt-6-terra` ✗. Claude on the native Anthropic route.
- **List prices / evidence (research 2026-10-26, verify any you put in `src/usage.ts` RATES):** Opus 5.5 $4/$20
  (cache read $0.20) · Sonnet 5.5 $2/$10 (cache read $0.10; community: verbose) · Haiku 5.5 $0.10/$0.50 ≤100k prompt ·
  gpt-6.1-sol $2/$10 (EQ-Bench CW v3 2125, slop 8.97 — best measured) · gpt-6-luna $0.10/$0.50 (concise, no creative
  evidence) · gemini-3.8-flash $0.75/$3.75 (CW 1745, slop 22.6 — sloppy) · gemini-3.1-pro $2/$12 · gemini-4-argon:
  price unknown (LMArena creative ~1519, near Opus 1516–1534) — find it. No German writing evidence exists for any.
- First bake-off cost/episode (projected, uncached): haiku $0.07, deepseek $0.11, gpt-6-sol $0.37, Opus $1.73.

## Wave 3 — Expression, context, rematch            <!-- status: active -->
- [ ] **Per-turn delivery.** Add an optional `delivery` to script turns, chosen from a small fixed English vocabulary
      in code (≈8–10 strings, e.g. curious, amused, surprised, serious, thoughtful/slower, energetic/faster, dry,
      warm — your call, each verified on IU as never spoken). Writer prompt: baseline = no delivery; set it where the
      moment changes. Synth: `style = turn.delivery ?? host baseline`; dense turns keep the slow style. ElevenLabs
      fallback lane ignores it. Revision/tightening must preserve it.
- [ ] **Tag policy from evidence, not fear.** Replace the "one tag every six turns" rule with a band (e.g. per segment
      a few well-placed pauses and real reactions; laughs only where something is funny) and make the fact & speech
      editor flag MISUSE (placement, staging, invented tags), not mere presence. Pick the band from the listening test.
- [ ] **Deterministic expression + segmentation lint** in `src/podcast-lint.ts`, fed to reviewers like the existing
      lint and recorded in the job profile: tag not in allowlist; tag as the first word of a short turn; adjacent
      tags; tags per segment below/above the band; delivery outside the vocabulary; same non-baseline delivery on 3+
      consecutive turns; delivery on a turn under N words; >1 CAPS emphasis per turn. Segmentation: every
      multi-speaker unit ≤ 3,000 chars, never across a segment, no unit that ends on a question whose answer opens
      the next unit (prefer cutting after an answer); report unit count and size spread. Tests for every rule.
- [ ] **Listening proof for expression (cheap, synth only):** take one finished improved-pipeline script segment and
      voice it 3 ways — A as today (no tags, constant style), B tag band, C tag band + per-turn delivery. Blind on
      `/tts` as a new open question "Expressiveness".
- [ ] **Context for the rematch:** regenerate the bake-off inputs with the production research stage ON (dossier with
      glossary, prior coverage) for episode `8ee3a4df`, then a fresh frozen outline from the current prompts. If
      something else in the writer's context is clearly missing for a stranger-listener (e.g. what earlier episodes
      already explained), add it only if cheap and measured — note it otherwise.
- [ ] **Fix Sonnet's format failure** in the claude branch: research the current Anthropic way to force a JSON object
      (structured outputs / `output_config.format`, or a tool) with adaptive thinking on IU; fall back to one repair
      retry. Test with a recorded screenplay reply.
- [ ] **Writer rematch, IU only**, full production per-segment flow INCLUDING tightening, Wave 2 + Wave 3 prompts,
      the research dossier, opening + interaction segments, voiced with the expressive synth: `claude-opus-5-5`
      (baseline, cached), `claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-6.1-sol`, `gpt-6-luna`, `gemini-4-argon`,
      `gemini-3.8-flash`, plus one **hybrid**: the best cheap drafter + Opus only for the revision pass. Record per
      candidate: cost/episode with caching (cache tokens from usage), words vs target, lint + expression-lint counts,
      wall time, failures. Blind on `/tts` as "Podcast writer — rematch" (old bake-off stays as reference).
- [ ] modelpick `docs/decisions/podcast-writer.md`: dated rematch section with the table and a **ranked
      recommendation** (quality evidence, cost/episode); verdict pending the owner's ears. Record the expression
      findings in `docs/gemini-tts.md` if new facts were measured.
- [ ] **(8) Expression in every lane.** Delivery vocabulary + tag allowlist as one shared module in `gemini-tts-core`
      (podcast, briefing, chat use the same words). Briefing prep: per-chunk style from the vocabulary (stable baseline,
      deviations where the content turns) and a tag band instead of "sparse" (`PREP_STYLE` / `BRIEFING_TAGS` in
      `gemini-tts.ts`). Chat lane (flash-lite, prep off): no extra LLM call — allowlisted inline tags in the INPUT pass
      through, invalid ones are stripped, optional request `style` the caller can set (Hermes writes tags itself; the
      hermes-agent side is the owner's). Listening proof per lane inside the "Expressiveness" question on `/tts`
      (briefing: baseline vs expressive; chat: plain vs tagged), synth-only.
- [ ] **(9) Research stage looks up external names.** The research-gateway tool is wired (max 2 calls) but was used once
      in ~10 episodes ("only for a fact the episode hinges on … sparingly"). The listener problem is unexplained
      third-party names (Cortex, engrams, DBOS): make the stage look up external names/projects/tools that neither
      source nor brain explains (batched into one query), feed the result into the glossary. Measure on `8ee3a4df`
      with research on: glossary size and first-mention names introduced. `PODCAST_RESEARCH_MAX_CALLS` stays bounded.
- [ ] Ship proven code (delivery field, synth wiring, lint, prompt/tag policy, Sonnet fix) with tests, `/review`, gates;
      commit per concern; push; `make deploy` on the mini only when no podcast job runs; modelpick deployed + verified
      (`/tts` 200, every new audio file resolves). Report actual IU spend.
**Left behind:**
