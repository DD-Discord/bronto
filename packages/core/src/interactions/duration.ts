import { UserError } from './errors.js';

const UNITS = [
  ['w', 604_800_000],
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
] as const;

const GROUP = /(\d+)\s*([wdhms])/iy;

const INVALID = 'Enter a duration like `90s`, `15m`, `1h 30m` or `14d`.';

/** Reads `<integer><unit>` groups (units w d h m s, each at most once, largest first) as milliseconds. */
export function parseDuration(text: string): number {
  const input = text.trim();
  if (input === '') throw new UserError(INVALID);
  let total = 0;
  let lastUnit = -1;
  let position = 0;
  while (position < input.length) {
    GROUP.lastIndex = position;
    const match = GROUP.exec(input);
    if (match === null) throw new UserError(INVALID);
    const unit = UNITS.findIndex(([letter]) => letter === match[2]!.toLowerCase());
    if (unit <= lastUnit) throw new UserError(INVALID);
    lastUnit = unit;
    total += Number(match[1]) * UNITS[unit]![1];
    position = GROUP.lastIndex;
    while (input[position] === ' ' || input[position] === '\t') position += 1;
  }
  if (!Number.isSafeInteger(total)) throw new UserError(INVALID);
  return total;
}

/** Writes milliseconds as `parseDuration` input: largest units first, zero parts left out, weeks only for whole weeks. */
export function formatDuration(ms: number): string {
  let rest = Math.floor(ms / 1000) * 1000;
  const parts: string[] = [];
  const weeks = rest > 0 && rest % UNITS[0][1] === 0;
  for (const [letter, size] of UNITS) {
    if (letter === 'w' && !weeks) continue;
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${count}${letter}`);
    rest -= count * size;
  }
  return parts.length === 0 ? '0s' : parts.join(' ');
}
