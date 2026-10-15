import { pino, type Logger } from 'pino';

export interface LogLine {
  level: number;
  msg: string;
  module?: string;
  [key: string]: unknown;
}

/** A logger that keeps every line in memory for assertions. */
export function captureLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = pino({ level: 'debug' }, {
    write: (line: string) => {
      lines.push(JSON.parse(line) as LogLine);
    },
  });
  return { log, lines };
}
