# HyperDX — "Audio" dashboard

Traces and logs land in ClickStack under `ServiceName = 'audio-gateway'` (tables `otel_traces`,
`otel_logs`; attributes in `SpanAttributes[...]`). One trace per request; the trace id equals the
`request_id` of the SQLite/Argo usage rows, so a row and its trace join directly.

Span model:

| Span | Kind | Key attributes |
|-|-|-|
| `audio.speech` (root) | server | `audio.lane` replicate/gemini/passthrough · `audio.mode` direct/prep/summary/passthrough · `audio.model` · `audio.voice` · `audio.language_code` · `audio.input_chars` · `audio.chunks` · `audio.audio_seconds` · `audio.text.input` / `audio.text.output` (600 chars, `USAGE_KEEP_TEXT`) · `http.status_code` |
| `audio.prep` | client | `llm.model` · `audio.prep.kind` prep/summary · `llm.output_tokens` |
| `audio.synth.chunk` | client | `audio.chunk_index` · `replicate.predict_time_s` · `replicate.polls` · `audio.audio_seconds` |
| `audio.delivery.fetch` · `audio.decode` · `audio.concat` · `audio.transcode` | internal | — |
| `audio.podcast` (root, one per job; trace id = job id) | server | `audio.podcast.title` · `audio.podcast.turns` · `audio.podcast.chapters` · `audio.audio_seconds` · `audio.bytes_out` · `audio.cost_usd` · `audio.podcast.published` · `audio.caller` |
| `audio.podcast.stage` | internal | `audio.podcast.stage` synth/master · `audio.podcast.turns` · `audio.audio_seconds` · `audio.bytes_out` — the wall-clock between the LLM calls and the publish |
| `audio.podcast.llm` | client | `llm.model` · `audio.podcast.stage` outline/segment/review/revise · `llm.output_tokens` · `llm.finish_reason` · `http.status_code` |
| `audio.cover` · `audio.publish.abs` | client | `http.status_code` · `abs.library_id` · `abs.item_id` · `abs.episode_id` · `abs.created` |
| `audio.transcription` (root) | server | `audio.model` · `audio.fallback` · `audio.text.output` (transcript) |
| `audio.stt.upstream` | client | `audio.model` · `http.status_code` |

No personal API key is cached on the mini, so the dashboard is created once in the UI
(Dashboards → New → add tiles). Each tile below is a HyperDX search + chart; the SQL is the
equivalent for the SQL editor / `otel` skill.

## Tiles

**1. First-sound latency by lane/mode — p50 / p95 (line)**
Search: `ServiceName:audio-gateway SpanName:audio.speech` · group by `SpanAttributes['audio.lane']`, `SpanAttributes['audio.mode']` · metric `Duration` p50 and p95.
```sql
SELECT toStartOfFiveMinutes(Timestamp) t, SpanAttributes['audio.lane'] lane, SpanAttributes['audio.mode'] mode,
       quantile(0.5)(Duration)/1e6 p50_ms, quantile(0.95)(Duration)/1e6 p95_ms, count() n
FROM otel_traces WHERE ServiceName='audio-gateway' AND SpanName='audio.speech' AND Timestamp > now() - INTERVAL 1 DAY
GROUP BY t, lane, mode ORDER BY t
```

**2. Where the time goes — stage breakdown (stacked bar)**
Search: `ServiceName:audio-gateway SpanName:(audio.prep OR audio.synth.chunk OR audio.delivery.fetch OR audio.decode OR audio.transcode OR audio.stt.upstream)` · group by `SpanName` · avg `Duration`.
```sql
SELECT SpanName, round(avg(Duration)/1e6) avg_ms, round(quantile(0.95)(Duration)/1e6) p95_ms, count() n
FROM otel_traces WHERE ServiceName='audio-gateway' AND Timestamp > now() - INTERVAL 1 DAY AND ParentSpanId != ''
GROUP BY SpanName ORDER BY avg_ms DESC
```

**3. Replicate overhead — wall vs `predict_time` (line)**
The vendor's own predict time vs what the chunk span measured; the gap is Replicate scheduling + delivery.
```sql
SELECT toStartOfFiveMinutes(Timestamp) t, round(avg(Duration)/1e6) wall_ms,
       round(avg(toFloat64OrZero(SpanAttributes['replicate.predict_time_s']))*1000) predict_ms
FROM otel_traces WHERE ServiceName='audio-gateway' AND SpanName='audio.synth.chunk' AND Timestamp > now() - INTERVAL 1 DAY
GROUP BY t ORDER BY t
```

**4. Errors (number + table)**
Search: `ServiceName:audio-gateway StatusCode:Error` · table columns `SpanName`, `SpanAttributes['audio.model']`, `StatusMessage`.
```sql
SELECT Timestamp, SpanName, SpanAttributes['audio.model'] model, StatusMessage
FROM otel_traces WHERE ServiceName='audio-gateway' AND StatusCode='Error' AND Timestamp > now() - INTERVAL 1 DAY ORDER BY Timestamp DESC
```

**5. Language split (pie)** — every root speech span: group by `SpanAttributes['audio.language_code']`.
A rising `en` share on German days means the marker heuristic in `gemini-tts-core.ts` needs words.

**6. Summary vs direct (number)** — share of `audio.mode = summary` among `audio.speech`, and avg `audio.audio_seconds` per mode. The spoken-summary threshold lives in Hermes (`voice.speak_summary_min_chars`).

**7. What was said — latest texts (table)**
Search: `ServiceName:audio-gateway SpanName:(audio.speech OR audio.transcription)` · columns `SpanAttributes['audio.mode']`, `SpanAttributes['audio.text.input']`, `SpanAttributes['audio.text.output']`, `Duration`. This is the quality-review tile: read the summary against its input, read the transcript.

**8. Logs (table)** — `ServiceName:audio-gateway` in the Logs tab; every record carries `TraceId`, click through to the trace. Production paths log only warn/error, so an empty tile is the healthy state.

Same data from the terminal: `bun run usage:tail --prod --since 2h` (rows) or the `/otel` skill
(`query.py --env prod "<sql above>"`).

## Podcast tiles

**P1. Episodes — count, duration, cost (table)**
Search: `ServiceName:audio-gateway SpanName:audio.podcast` · columns `SpanAttributes['audio.podcast.title']`, `Duration`, `SpanAttributes['audio.audio_seconds']`, `SpanAttributes['audio.cost_usd']`, `SpanAttributes['audio.podcast.published']`, `StatusCode`.
```sql
SELECT Timestamp, SpanAttributes['audio.podcast.title'] title, round(Duration/1e9) wall_s,
       toFloat64OrZero(SpanAttributes['audio.audio_seconds']) audio_s,
       toFloat64OrZero(SpanAttributes['audio.cost_usd']) cost_usd,
       SpanAttributes['audio.podcast.turns'] turns, SpanAttributes['audio.podcast.published'] published, StatusCode
FROM otel_traces WHERE ServiceName='audio-gateway' AND SpanName='audio.podcast' AND Timestamp > now() - INTERVAL 30 DAY
ORDER BY Timestamp DESC
-- KPIs (sum/avg of cost, audio seconds): add StatusCode='Ok' — a failed job carries none of these attributes.
```

**P2. Writer stages — wall time and output tokens by stage (bar)**
Search: `ServiceName:audio-gateway SpanName:audio.podcast.llm` · group by `SpanAttributes['audio.podcast.stage']` · p50/max `Duration`.
```sql
SELECT SpanAttributes['audio.podcast.stage'] stage, count() n,
       round(quantile(0.5)(Duration)/1e9) p50_s, round(max(Duration)/1e9) max_s,
       round(avg(toFloat64OrZero(SpanAttributes['llm.output_tokens']))) avg_out_tokens,
       countIf(SpanAttributes['llm.finish_reason']='length') truncated
FROM otel_traces WHERE ServiceName='audio-gateway' AND SpanName='audio.podcast.llm' AND Timestamp > now() - INTERVAL 7 DAY
GROUP BY stage ORDER BY p50_s DESC
```
`truncated > 0` means a writer budget is too small for the model's reasoning — see `writerBudget` in `podcast-script.ts`.

**P3. Synthesis fan-out per episode (line)** — `audio.synth.chunk` spans whose root is `audio.podcast`: count and p95 per trace.
```sql
SELECT TraceId, count() turns, round(quantile(0.95)(Duration)/1e6) p95_ms, round(sum(Duration)/1e9) cpu_s
FROM otel_traces WHERE ServiceName='audio-gateway' AND SpanName='audio.synth.chunk'
  AND TraceId IN (SELECT TraceId FROM otel_traces WHERE SpanName='audio.podcast' AND Timestamp > now() - INTERVAL 7 DAY)
GROUP BY TraceId
```

**P4. Writers' room health (numbers)** — logs, last 7 days: `podcast writer reply did not parse` (retries), `podcast reviewer skipped`, `podcast revision skipped`, `podcast writer returned no content`, `podcast.failed`.
```sql
SELECT Body msg, count() n FROM otel_logs
WHERE ServiceName='audio-gateway' AND Timestamp > now() - INTERVAL 7 DAY
  AND (Body LIKE 'podcast%' AND SeverityText IN ('WARN','ERROR'))
GROUP BY msg ORDER BY n DESC
```
Alert: `podcast.failed` > 0 in 1 h.

**P5. Publish path (table)** — `audio.publish.abs` spans: `abs.created`, `abs.episode_id`, duration; a null `abs.episode_id` means the ABS scan never surfaced the file.
