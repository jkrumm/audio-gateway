/**
 * Minimal structured logger. Writes single-line JSON to stdout/stderr so logs
 * are greppable in `docker logs` and compatible with any JSON log aggregator.
 */

type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string, fields?: Fields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields): void => emit("error", msg, fields),
};
