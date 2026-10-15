/** Joins lines into chunks of at most `maxLength` characters, never splitting a line; an oversized line stays alone. */
export function batchLines(lines: string[], maxLength = 2000): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (current !== '' && candidate.length > maxLength) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/** Strips Discord markdown, for places that show plain text such as autocomplete choices. */
export function plainText(value: string): string {
  return value
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\|\|([^|]*)\|\|/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/#/g, ' ')
    .trim();
}
