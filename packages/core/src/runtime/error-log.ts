import { pino } from 'pino';

// Postgres error fields that can quote row values.
const VALUE_FIELDS = new Set(['detail', 'where', 'internalQuery']);

/**
 * Pino's error serializer, minus the values of failed queries: Drizzle's params, Postgres' detail and the input that
 * Postgres quotes in data exception messages. Covers every error Pino prints: causes, AggregateError members and
 * errors kept in other properties.
 */
export function serializeError(error: unknown): unknown {
  const target = containsQueryValues(error, new Set()) ? withoutQueryValues(error, new Map()) : error;
  return pino.stdSerializers.err(target as Error);
}

function fieldsOf(error: Error): Record<string, unknown> {
  return error as unknown as Record<string, unknown>;
}

/** The errors Pino serializes along with `error`. */
function nestedErrors(error: Error): unknown[] {
  const fields = fieldsOf(error);
  return [error.cause, ...(Array.isArray(fields.errors) ? fields.errors : []), ...Object.values(fields)];
}

// Drizzle's DrizzleQueryError; matched by shape, as several drizzle-orm copies can be loaded.
function isQueryError(error: Error): boolean {
  const fields = fieldsOf(error);
  return typeof fields.query === 'string' && Array.isArray(fields.params);
}

function isDataException(error: Error): boolean {
  const fields = fieldsOf(error);
  return typeof fields.severity === 'string' && typeof fields.code === 'string' && fields.code.startsWith('22');
}

function containsQueryValues(error: unknown, seen: Set<Error>): boolean {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  const carriesValues =
    isQueryError(error) || isDataException(error) || Object.keys(error).some((key) => VALUE_FIELDS.has(key));
  return carriesValues || nestedErrors(error).some((nested) => containsQueryValues(nested, seen));
}

/** Copies the error tree without query values; the original errors stay intact. */
function withoutQueryValues(error: unknown, copies: Map<Error, Error>): unknown {
  if (!(error instanceof Error)) return error;
  const existing = copies.get(error);
  if (existing !== undefined) return existing;
  // Registered before the nested errors are copied, so a cycle leads back to this copy.
  const copy = Object.create(Object.getPrototypeOf(error) as object) as Error;
  copies.set(error, copy);
  const queryError = isQueryError(error);
  const fields = fieldsOf(error);
  const copyFields = fieldsOf(copy);
  for (const [key, value] of Object.entries(fields)) {
    if (VALUE_FIELDS.has(key) || (queryError && key === 'params')) continue;
    copyFields[key] = withoutQueryValues(value, copies);
  }
  let message = error.message;
  if (queryError) message = `Failed query: ${fields.query as string}`;
  // SQLSTATE class 22 messages quote one rejected input verbatim, quotes inside it unescaped, so everything from the
  // first to the last quote is masked, e.g. `invalid input syntax for type uuid: "…"`.
  if (isDataException(error)) message = message.replace(/"[\s\S]*"/, '"…"').replace(/: [^"].*$/s, ': …');
  const define = (key: string, value: unknown) =>
    Object.defineProperty(copy, key, { value, writable: true, configurable: true });
  define('message', message);
  define('stack', error.stack?.replace(error.message, message));
  define('cause', withoutQueryValues(error.cause, copies));
  if (Array.isArray(fields.errors)) define('errors', fields.errors.map((nested) => withoutQueryValues(nested, copies)));
  return copy;
}
