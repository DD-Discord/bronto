# Writing user docs

User docs are the help pages members read in Discord with `/help`. Core turns each Markdown file into a Components V2
message, so the files follow a small format with a few limits. Admin docs (`docs/admin/`) and API docs (`docs/api/`) are
ordinary GitHub Markdown and have no such rules.

## Folder and `docs`

A module keeps its user docs in `docs/user/`, one file per topic, and points core at the folder:

```ts
export default defineModule({
  name: 'sticky',
  docs: new URL('../docs/user/', import.meta.url),
  // ...
});
```

- The folder is read non-recursively; only `*.md` files count.
- `index.md` is required. It is the module's landing page and always comes first.
- A module without `docs` does not appear in `/help`. Core's own pages (`docs/user/` in this repository) are shown
  under the module key `core`.
- `/help` lists core plus the modules the deployment loads and the server has switched on.

## Topics

A file is a topic. The topic ID is the file name without `.md`.

- The ID matches `[a-z0-9-]{1,32}`, and module name plus topic ID are at most 75 characters together, so the signed
  custom ID of a button stays within Discord's 100.
- A module has at most 25 topics (the limit of a select menu).
- Topics are sorted by file name after `index.md`. Number prefixes (`02-create.md`) are allowed for ordering and never
  required.

### Title

The first line of every file is `# Title`. It is shown at the top of every page of the topic and as the topic's label in
the topic select. The title of `index.md` is the module's label in the module select; in the topic select, `index.md` is
always labelled "Overview".

### Summary

The first paragraph of `index.md` (headings are skipped; whitespace is collapsed and the text is cut to 100 characters)
is the module's description in the module select. Make it say what the module does.

### Body

The body is Discord Markdown, passed through unchanged: `##` and `###` headings, lists, bold and italic, inline code,
code fences, links, quotes and `-#` subtext. Discord renders it, so the parser does not interpret it beyond what is
described here.

## Sections

A section is a short text with a button beside it. It is a quote whose first line starts with `[!section]` and a link:

```md
> [!section] [Open](create.md)
> **`/sticky create`**
> Creates a sticky from a template and posts it right away.

> [!section] [Admin guide](https://github.com/DD-Discord/bronto/blob/main/docs/admin/running.md)
> **Hosting bronto yourself?**
> Setup, permissions and settings are in the admin docs.
```

- The link on the marker line is the button. Its label is at most 80 characters and not empty.
- The quoted lines below the marker are the text beside the button. A section needs at least one line of text.
- A target that is a topic file of the same module (`create.md`) makes a grey button that opens that topic. Several
  sections may link the same topic.
- A target that is an `https://` URL makes a link button.
- Nothing else is a valid target: not another module's topic, not `http://`, not a path or an anchor.
- A section is never split across pages.

GitHub shows the files with the literal `[!section]` markers and `-#` subtext. That is accepted: these files are
written for Discord.

## Pages

Core splits a topic into pages that fit one message. A line that contains only `---`, with a blank line before it,
starts a new page by hand. Without the blank line Markdown reads `---` as the underline of a heading, so the check
rejects it. There are no separators within a page.

Limits per page:

- **Text:** at most 4000 characters, including the `# Title` line and the blank lines between blocks.
- **Components:** at most 30 for the page's blocks. Consecutive text is one block and costs 1; a section costs 3. A page
  therefore has at most 10 sections. (The rest of the message's 40 components holds the title and the menus and buttons
  below the page.)

When a page would exceed a limit, it splits automatically before the last `##` or `###` heading that fits, otherwise at
the last blank line that fits. It never splits inside a code fence or a section. A paragraph, code block or section
that cannot fit on a page by itself is an error: shorten it or divide it.

## Menus and buttons

`/help` shows a module select, a topic select, and Back, `n / m` and Next when a topic has several pages. Section
buttons to topics and all menus need a signed custom ID, so they only work when the deployment sets
`interactions.secret`. Without it, `/help` still answers: pages appear without menus or Back/Next, sections that link to
a topic show only their text, and link buttons stay. Members then navigate with the `module`, `topic` and `page`
options of `/help`.

## What the check rejects

`checkDocs` and the startup loader reject:

- A file without `# Title` as its first line, or a folder without `index.md`.
- A topic ID that does not match `[a-z0-9-]{1,32}`, or module name plus topic ID over 75 characters.
- More than 25 topics.
- Tables (Discord does not render them).
- Unknown `[!…]` markers.
- A `[!section]` without a `[label](target)` link on its line, with an empty or over-long label, or without text.
- Section links to topics that do not exist, to other modules, or to anything but `https://` URLs and topic files.
- A `---` without a blank line before it.
- A code fence that is never closed.
- A block that cannot fit on one page.
- A docs folder that cannot be read.

At startup a module whose docs have problems is logged, one line per problem with file and line, and left out of
`/help`. The bot keeps running.

## Testing

Call `checkDocs` from `@bronto/core/testing` in the module's test suite. It runs the same loader as startup and throws
with every problem as `file:line: message`; on success it returns the parsed topics.

```ts
import { checkDocs } from '@bronto/core/testing';
import { expect, it } from 'vitest';

it('has valid user docs', () => {
  const docs = checkDocs(new URL('../docs/user/', import.meta.url), 'sticky');
  expect(docs.topics.map((topic) => topic.id)).toEqual(['index', 'create']);
});
```

The second argument is the module name, which counts towards the topic ID budget. For a complete small example, see
[`examples/notes/docs/user/`](../../examples/notes/docs/user/).
