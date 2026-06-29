type LogLevel = "info" | "warn" | "error";

export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  writeLog("info", event, fields);
}

export function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  writeLog("warn", event, fields);
}

export function logError(event: string, fields: Record<string, unknown> = {}): void {
  writeLog("error", event, fields);
}

function writeLog(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  const entry = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...stripUndefined(fields),
  });
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}
