import { pino } from 'pino';

// Postgres error fields that can quote row values.
const VALUE_FIELDS = new Set(['detail', 'where', 'internalQuery']);

/**
 * Pino's error serializer, minus the values of failed queries: Drizzle's params, Postgres' detail and the input that
 * Postgres quotes in data exception messages.
 */
export function serializeError(error: unknown): unknown {
  return pino.stdSerializers.err(withoutQueryValues(error) as Error);
}

function withoutQueryValues(error: unknown, seen = new Set<unknown>()): unknown {
  if (!(error instanceof Error) || seen.has(error)) return error;
  seen.add(error);
  const cause = withoutQueryValues(error.cause, seen);
  const fields = error as unknown as Record<string, unknown>;
  // Drizzle's DrizzleQueryError; matched by shape, as several drizzle-orm copies can be loaded.
  const isQueryError = typeof fields.query === 'string' && Array.isArray(fields.params);
  const hasValues = Object.keys(fields).some((key) => VALUE_FIELDS.has(key));
  const isDataException = typeof fields.severity === 'string' && typeof fields.code === 'string' && fields.code.startsWith('22');
  if (!isQueryError && !hasValues && !isDataException && cause === error.cause) return error;

  const copy = Object.create(Object.getPrototypeOf(error) as object) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (VALUE_FIELDS.has(key) || (isQueryError && key === 'params')) continue;
    copy[key] = value;
  }
  let message = error.message;
  if (isQueryError) message = `Failed query: ${fields.query as string}`;
  // SQLSTATE class 22 messages quote the rejected input, e.g. `invalid input syntax for type uuid: "…"`.
  if (isDataException) message = message.replace(/"[^"]*"/g, '"…"').replace(/: [^"].*$/s, ': …');
  Object.defineProperty(copy, 'message', { value: message, writable: true, configurable: true });
  Object.defineProperty(copy, 'stack', { value: error.stack?.replace(error.message, message), writable: true, configurable: true });
  Object.defineProperty(copy, 'cause', { value: cause, writable: true, configurable: true });
  return copy;
}
