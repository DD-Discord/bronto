import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import type { Block, ModuleDocs, Topic } from '../docs/types.js';
import { plainText, truncate } from './format.js';
import type { ReplyMessage } from './responder.js';

const MAX_SELECT_OPTIONS = 25;
const MAX_OPTION_TEXT = 100;
const MAX_BUTTON_LABEL = 80;

/** A topic's label in the topic select and autocomplete; the start topic shares its title with the module. */
export function topicLabel(topic: Topic): string {
  return topic.id === 'index' ? 'Overview' : topic.title;
}

/** One page of one module's docs; `topic` indexes `docs.topics`, `page` is 0-based. */
export interface HelpView {
  module: string;
  docs: ModuleDocs;
  topic: number;
  page: number;
  /** The modules the user may open, core first. */
  modules: { name: string; docs: ModuleDocs }[];
}

/** Signed custom IDs for the current module's components. */
export interface HelpIds {
  module: string;
  topic: string;
  go: (topic: string, page: number) => string;
  /** A section's topic button; `slot` is the section's index on the page, which keeps each ID unique. */
  open: (topic: string, slot: number) => string;
}

const text = (content: string) => ({ type: ComponentType.TextDisplay, content });
const row = (...components: unknown[]) => ({ type: ComponentType.ActionRow, components });
const button = (label: string, customId: string, disabled = false) => ({
  type: ComponentType.Button,
  style: ButtonStyle.Secondary,
  label: truncate(label, MAX_BUTTON_LABEL),
  custom_id: customId,
  disabled,
});

/** A section, or a text display for a section linking a topic when there are no `ids`. */
function block(item: Block, ids: HelpIds | null, slot: number): unknown {
  if (item.kind === 'text') return text(item.markdown);
  let accessory;
  if ('url' in item.button) {
    const label = truncate(item.button.label, MAX_BUTTON_LABEL);
    accessory = { type: ComponentType.Button, style: ButtonStyle.Link, label, url: item.button.url };
  } else {
    if (ids === null) return text(item.markdown);
    accessory = button(item.button.label, ids.open(item.button.topic, slot));
  }
  return { type: ComponentType.Section, components: [text(item.markdown)], accessory };
}

/** Core and the first other modules; the current module takes the last place when it would not be listed. */
function selectModules(view: HelpView): HelpView['modules'] {
  const listed = view.modules.slice(0, MAX_SELECT_OPTIONS);
  if (listed.some(({ name }) => name === view.module)) return listed;
  const current = view.modules.find(({ name }) => name === view.module);
  return current === undefined ? listed : [...listed.slice(0, MAX_SELECT_OPTIONS - 1), current];
}

/** A Components V2 message with one container: the page, then with `ids` the selects and the page buttons. */
export function renderHelp(view: HelpView, ids: HelpIds | null): ReplyMessage {
  const topic = view.docs.topics[view.topic]!;
  const page = topic.pages[view.page] ?? [];
  const count = topic.pages.length;
  const paging =
    ids !== null && count > 1
      ? row(
          button('◀ Back', ids.go(topic.id, view.page - 1), view.page === 0),
          button(`${view.page + 1} / ${count}`, ids.go(topic.id, view.page), true),
          button('Next ▶', ids.go(topic.id, view.page + 1), view.page === count - 1),
        )
      : null;
  let sections = 0;
  const blocks = page.map((item) => block(item, ids, item.kind === 'section' ? sections++ : -1));
  const children: unknown[] = [text(`# ${topic.title}`), ...blocks];
  if (ids !== null) {
    const modules = selectModules(view).map(({ name, docs }) => {
      const summary = truncate(plainText(docs.summary), MAX_OPTION_TEXT);
      return {
        label: truncate(docs.topics[0]!.title, MAX_OPTION_TEXT),
        value: name,
        ...(summary === '' ? {} : { description: summary }),
        default: name === view.module,
      };
    });
    const topics = view.docs.topics.map((candidate) => ({
      label: truncate(topicLabel(candidate), MAX_OPTION_TEXT),
      value: candidate.id,
      default: candidate.id === topic.id,
    }));
    children.push(
      row({ type: ComponentType.StringSelect, custom_id: ids.module, placeholder: 'Module', options: modules }),
      row({ type: ComponentType.StringSelect, custom_id: ids.topic, placeholder: 'Topic', options: topics }),
    );
    if (paging !== null) children.push(paging);
  }
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [{ type: ComponentType.Container, components: children }] as ReplyMessage['components'],
  };
}
