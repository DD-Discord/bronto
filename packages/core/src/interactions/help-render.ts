import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import type { Block, ModuleDocs } from '../docs/types.js';
import { plainText, truncate } from './format.js';
import type { ReplyMessage } from './responder.js';

const MAX_SELECT_OPTIONS = 25;
const MAX_OPTION_TEXT = 100;
const MAX_BUTTON_LABEL = 80;

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

/**
 * A section, or a text display when its topic button can't be shown: without `ids`, or when its custom ID is already
 * on the message (Discord rejects duplicate custom IDs).
 */
function block(item: Block, ids: HelpIds | null, used: Set<string>): unknown {
  if (item.kind === 'text') return text(item.markdown);
  let accessory;
  if ('url' in item.button) {
    const label = truncate(item.button.label, MAX_BUTTON_LABEL);
    accessory = { type: ComponentType.Button, style: ButtonStyle.Link, label, url: item.button.url };
  } else {
    const id = ids?.go(item.button.topic, 0);
    if (id === undefined || used.has(id)) return text(item.markdown);
    used.add(id);
    accessory = button(item.button.label, id);
  }
  return { type: ComponentType.Section, components: [text(item.markdown)], accessory };
}

/** A Components V2 message with one container: the page, then with `ids` the selects and the page buttons. */
export function renderHelp(view: HelpView, ids: HelpIds | null): ReplyMessage {
  const topic = view.docs.topics[view.topic]!;
  const page = topic.pages[view.page] ?? [];
  const count = topic.pages.length;
  const used = new Set<string>();
  const paging =
    ids !== null && count > 1
      ? row(
          button('◀ Back', ids.go(topic.id, view.page - 1), view.page === 0),
          button(`${view.page + 1} / ${count}`, ids.go(topic.id, view.page), true),
          button('Next ▶', ids.go(topic.id, view.page + 1), view.page === count - 1),
        )
      : null;
  for (const item of paging?.components ?? []) used.add((item as { custom_id: string }).custom_id);

  const children: unknown[] = [text(`# ${topic.title}`), ...page.map((item) => block(item, ids, used))];
  if (ids !== null) {
    const modules = view.modules.slice(0, MAX_SELECT_OPTIONS).map(({ name, docs }) => {
      const summary = truncate(plainText(docs.summary), MAX_OPTION_TEXT);
      return {
        label: truncate(docs.topics[0]!.title, MAX_OPTION_TEXT),
        value: name,
        ...(summary === '' ? {} : { description: summary }),
        default: name === view.module,
      };
    });
    const topics = view.docs.topics.map((candidate) => ({
      label: truncate(candidate.title, MAX_OPTION_TEXT),
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
