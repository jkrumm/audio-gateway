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
