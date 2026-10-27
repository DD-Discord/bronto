export type Button = { label: string; topic: string } | { label: string; url: string };
export type Block = { kind: 'text'; markdown: string } | { kind: 'section'; markdown: string; button: Button };
export type Page = Block[];
export interface Topic { id: string; title: string; pages: Page[] }
/** `topics[0]` is the index topic. */
export interface ModuleDocs { summary: string; topics: Topic[] }
/** `line` is 1-based; null when the problem concerns the whole file or folder. */
export interface DocsProblem { file: string; line: number | null; message: string }
