/**
 * Minimal structured logger. Writes single-line JSON to stdout/stderr so logs
 * are greppable in `docker logs` and compatible with any JSON log aggregator.
 * Every call also emits an OTLP log record via `emitLog` (otel.ts), stamped
 * with the current trace/span id when inside a span — a no-op when OTel
 * export is disabled. Console output is unaffected either way.
 */
import { emitLog, type LogSeverity } from "./otel";

type Fields = Record<string, unknown>;

function emit(level: LogSeverity, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
  emitLog(level, msg, fields);
}

export const log = {
  info: (msg: string, fields?: Fields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields): void => emit("error", msg, fields),
};
