import { diffLines } from 'diff';

/** Splits a text into lines for diffing; an empty text has none. */
function toLines(text: string): string[] {
  return text === '' ? [] : text.replaceAll('\r\n', '\n').split('\n');
}

/**
 * A line diff of two texts as plain lines prefixed `'  '`, `'- '` or `'+ '`. Unchanged runs keep `context` lines
 * next to a change; the rest of a run folds into one `…` line. Empty when the texts are equal.
 */
export function foldedDiff(before: string, after: string, context = 1): string {
  if (before === after) return '';
  // Every line ends in a newline, so a last line without one does not differ from the same line followed by more.
  const terminated = (lines: string[]) => lines.map((line) => `${line}\n`).join('');
  const parts = diffLines(terminated(toLines(before)), terminated(toLines(after)));
  const out: string[] = [];
  parts.forEach((part, i) => {
    const partLines = part.value.replace(/\n$/, '').split('\n');
    if (part.added) out.push(...partLines.map((line) => `+ ${line}`));
    else if (part.removed) out.push(...partLines.map((line) => `- ${line}`));
    else {
      const first = i === 0;
      const last = i === parts.length - 1;
      const keep = (list: string[]) => list.map((line) => `  ${line}`);
      if (first && last) out.push(...keep(partLines));
      else if (first || last) {
        if (partLines.length <= context) out.push(...keep(partLines));
        else if (first) out.push('…', ...keep(partLines.slice(partLines.length - context)));
        else out.push(...keep(partLines.slice(0, context)), '…');
      } else if (partLines.length <= 2 * context) out.push(...keep(partLines));
      else out.push(...keep(partLines.slice(0, context)), '…', ...keep(partLines.slice(partLines.length - context)));
    }
  });
  return out.join('\n');
}
