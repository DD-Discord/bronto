import type { ModuleDocs } from '../docs/types.js';
import type { HandlerContext } from '../runtime/types.js';
import type { ModuleEnablement } from '../runtime/enablement.js';
import { defineCommand, type CommandDefinition } from './commands.js';
import { defineButton, defineSelect, type ComponentDefinition } from './components.js';
import { UserError } from './errors.js';
import { renderHelp, type HelpIds, type HelpView } from './help-render.js';
import { opt, type Choice } from './options.js';

const CORE = 'core';

export interface HelpOptions {
  /** Docs by module name; `core` first, then modules in load order. */
  library: ReadonlyMap<string, ModuleDocs>;
  enablement: Pick<ModuleEnablement, 'isEnabled'>;
  /** False without interactions.secret: pages render without selects and Back/Next. */
  navigation: boolean;
}

const matches = (query: string, ...values: string[]) => {
  const needle = query.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(needle));
};

/** Core's `/help` command and the components that navigate its pages. */
export function createHelp(options: HelpOptions): { command: CommandDefinition; components: ComponentDefinition[] } {
  const { library, enablement, navigation } = options;
  const core = library.get(CORE);
  if (core === undefined) throw new Error('The help library needs core\'s docs.');

  /** Core, then the modules with docs that are on in the guild, in library order. */
  const visible = (guildId: string) => [
    { name: CORE, docs: core },
    ...[...library]
      .filter(([name]) => name !== CORE && enablement.isEnabled(guildId, name))
      .map(([name, docs]) => ({ name, docs })),
  ];

  /**
   * The view for a module, topic and page. `strict` (the command) throws for an unknown module or topic; otherwise
   * (components) a missing module falls back to core's index, a missing topic to the module's index and a page out of
   * range to the first page.
   */
  function resolve(guildId: string, module: string, topic: string | null, page: number, strict: boolean): HelpView {
    const modules = visible(guildId);
    let current = modules.find((candidate) => candidate.name === module);
    if (current === undefined) {
      if (strict) throw new UserError(`There's no help for "${module}".`);
      current = modules[0]!;
      topic = null;
    }
    const { docs } = current;
    let index = topic === null ? 0 : docs.topics.findIndex((candidate) => candidate.id === topic);
    if (index === -1) {
      if (strict) throw new UserError(`There's no help topic "${topic}" in ${docs.topics[0]!.title}.`);
      index = 0;
      page = 0;
    }
    const pages = docs.topics[index]!.pages.length;
    if (!Number.isInteger(page) || page < 0 || page >= pages) page = 0;
    return { module: current.name, docs, topic: index, page, modules };
  }

  const moduleSelect = defineSelect({
    name: 'module',
    defer: 'update',
    execute: (ctx) => ctx.update(render(ctx, resolve(ctx.guildId, ctx.values[0] ?? CORE, null, 0, false))),
  });
  const topicSelect = defineSelect({
    name: 'topic',
    defer: 'update',
    execute: (ctx, [module = CORE]) =>
      ctx.update(render(ctx, resolve(ctx.guildId, module, ctx.values[0] ?? null, 0, false))),
  });
  const go = defineButton({
    name: 'go',
    defer: 'update',
    execute: (ctx, [module = CORE, topic = 'index', page = '0']) =>
      ctx.update(render(ctx, resolve(ctx.guildId, module, topic, Number(page), false))),
  });
  // Section buttons: `slot` only keeps custom IDs unique when sections link the same topic.
  const open = defineButton({
    name: 'open',
    defer: 'update',
    execute: (ctx, [module = CORE, topic = 'index']) =>
      ctx.update(render(ctx, resolve(ctx.guildId, module, topic, 0, false))),
  });
  const components: ComponentDefinition[] = [moduleSelect, topicSelect, go, open];
  for (const component of components) component.owner = CORE;

  function render(ctx: HandlerContext, view: HelpView) {
    const ids: HelpIds | null = navigation
      ? {
          module: ctx.customId(moduleSelect),
          topic: ctx.customId(topicSelect, [view.module]),
          go: (topic, page) => ctx.customId(go, [view.module, topic, String(page)]),
          open: (topic, slot) => ctx.customId(open, [view.module, topic, String(slot)]),
        }
      : null;
    return renderHelp(view, ids);
  }

  const command = defineCommand({
    description: 'Shows how to use the bot and its modules',
    ephemeral: true,
    options: {
      module: opt.string({
        description: 'The module to show help for',
        autocomplete: (ctx, query) =>
          visible(ctx.guildId)
            .filter(({ name, docs }) => matches(query, name, docs.topics[0]!.title))
            .map(({ name, docs }): Choice => ({ name: docs.topics[0]!.title, value: name })),
      }),
      topic: opt.string({
        description: 'The topic to show',
        autocomplete: (ctx, query, { module }) => {
          const name = typeof module === 'string' && module !== '' ? module : CORE;
          const docs = visible(ctx.guildId).find((candidate) => candidate.name === name)?.docs;
          return (docs?.topics ?? [])
            .filter((topic) => matches(query, topic.id, topic.title))
            .map((topic): Choice => ({ name: topic.title, value: topic.id }));
        },
      }),
    },
    execute: (ctx, { module, topic }) => ctx.reply(render(ctx, resolve(ctx.guildId, module ?? CORE, topic, 0, true))),
  });

  return { command, components };
}
