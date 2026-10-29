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

/**
 * Strips Discord markdown, for places that show plain text such as autocomplete choices. Emphasis markers count only
 * at word boundaries and `#` only as a heading marker, so `snake_case`, `2 * 3` and mentions such as `<#id>` stay.
 */
export function plainText(value: string): string {
  return value
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(?<![\w*])\*\*(?=\S)([^*\n]*?\S)\*\*(?![\w*])/g, '$1')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)__(?=\S)([^_\n]*?\S)__(?!\w)/g, '$1')
    .replace(/(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\|\|([^|]*)\|\|/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,3}\s+/gm, '')
    .trim();
}

export function yesNo(value: boolean): 'Yes' | 'No' {
  return value ? 'Yes' : 'No';
}
