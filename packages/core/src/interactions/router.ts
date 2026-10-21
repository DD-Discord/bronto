import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ModalSubmitInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { ConfigError } from '../config/errors.js';
import type { ModuleRuntime } from '../runtime/context.js';
import type { Dispatcher } from '../runtime/dispatcher.js';
import type { ModuleEnablement } from '../runtime/enablement.js';
import type { HandlerContext } from '../runtime/types.js';
import { checkCommand, commandToJson, findHandler, subcommandPath, type CommandDefinition } from './commands.js';
import { checkCustomId, parseCustomId, type ComponentDefinition, type CustomIdCheck } from './components.js';
import { interactionContext, type ButtonContext, type CommandContext, type ModalContext } from './context.js';
import { isUserError } from './errors.js';
import { truncate } from './format.js';
import { readOptions, type Choice } from './options.js';
import { GENERIC_FAILURE, Responder, type ResponseTarget } from './responder.js';
import type { ComponentSigner } from './signing.js';

export const NOT_AVAILABLE = 'This command is not available here.';
export const COMPONENT_UNAVAILABLE = 'This is not available here.';
export const COMPONENT_GONE = 'This no longer works.';
export const COMPONENT_EXPIRED = 'This has expired.';
export const NOT_READY = 'The bot is not ready in this server yet. Try again in a moment.';

const MAX_CHOICES = 25;
const MAX_CHOICE_LENGTH = 100;

export interface InteractionSource {
  runtime: ModuleRuntime;
  commands: Record<string, CommandDefinition>;
  components: ComponentDefinition[];
  /** Core's own commands: never switched off per guild. */
  alwaysEnabled?: boolean;
}

export interface RouterOptions {
  sources: InteractionSource[];
  dispatcher: Dispatcher;
  enablement: ModuleEnablement;
  /** Resolves true once the guild is set up; interactions wait for it like gateway events. */
  guildGate: (guildId: string) => Promise<boolean>;
  log: Logger;
  /** Defers answers not sent after this long; Discord drops interactions not answered within 3 s. */
  deferAfterMs?: number;
  /** Verifies component custom IDs; null refuses every button and modal. */
  signer: ComponentSigner | null;
  /** Clock for custom ID expiry, in milliseconds. */
  now?: () => number;
}

interface Owned<T> {
  source: InteractionSource;
  value: T;
}

type ComponentInteraction = ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

/** Routes commands, autocomplete, buttons and modals to the module that owns them. */
export class InteractionRouter {
  private readonly commands = new Map<string, Owned<CommandDefinition>>();
  private readonly components = new Map<string, Owned<ComponentDefinition>>();
  private readonly dispatcher: Dispatcher;
  private readonly enablement: ModuleEnablement;
  private readonly guildGate: (guildId: string) => Promise<boolean>;
  private readonly log: Logger;
  private readonly deferAfterMs: number;
  private readonly signer: ComponentSigner | null;
  private readonly now: () => number;

  constructor(options: RouterOptions) {
    this.dispatcher = options.dispatcher;
    this.enablement = options.enablement;
    this.guildGate = options.guildGate;
    this.log = options.log;
    this.deferAfterMs = options.deferAfterMs ?? 2000;
    this.signer = options.signer;
    this.now = options.now ?? Date.now;
    const problems: string[] = [];
    for (const source of options.sources) {
      for (const [name, command] of Object.entries(source.commands)) {
        // Sync builds this JSON per guild; checking it at startup keeps one bad command from failing every sync.
        try {
          checkCommand(name, command);
          commandToJson(name, command);
        } catch (error) {
          problems.push(`modules: command /${name} (${source.runtime.name}): ${(error as Error).message}`);
        }
        const existing = this.commands.get(name);
        if (existing !== undefined) {
          problems.push(
            `modules: command /${name} is defined by both "${existing.source.runtime.name}" and "${source.runtime.name}"`,
          );
          continue;
        }
        this.commands.set(name, { source, value: command });
      }
      for (const component of source.components) {
        this.components.set(componentKey(source.runtime.name, component.kind, component.name), { source, value: component });
      }
    }
    if (problems.length > 0) throw new ConfigError(problems);
  }

  commandsFor(guildId: string): Array<[string, CommandDefinition]> {
    return [...this.commands.entries()]
      .filter(([, { source }]) => this.enabled(source, guildId))
      .map(([name, { value }]): [string, CommandDefinition] => [name, value]);
  }

  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      // Direct messages are not supported; a guild the client has not cached yet gets a polite "not ready".
      if (!interaction.inGuild()) return;
      if (interaction.isAutocomplete()) return this.answer(interaction.respond([]), `/${interaction.commandName} autocomplete`);
      if (interaction.isRepliable()) {
        return this.answer(new Responder(interaction as ResponseTarget, true).fail(NOT_READY), 'uncached guild');
      }
      return;
    }
    if (interaction.isChatInputCommand()) return this.command(interaction);
    if (interaction.isAutocomplete()) return this.autocomplete(interaction);
    if (interaction.isButton() || interaction.isModalSubmit()) return this.component(interaction);
  }

  private async command(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    const entry = this.commands.get(interaction.commandName);
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const handler = entry === undefined ? null : findHandler(entry.value, group, subcommand);
    const responder = new Responder(interaction as ResponseTarget, handler?.ephemeral ?? false);
    const label = ['/' + interaction.commandName, subcommandPath(group, subcommand)].filter((part) => part !== '').join(' ');
    const stopTimer = this.startDeferTimer(responder, label);
    if (!(await this.ready(interaction.guildId))) return this.answer(responder.fail(NOT_READY), label, stopTimer);
    if (entry === undefined || handler === null || !this.enabled(entry.source, interaction.guildId)) {
      return this.answer(responder.fail(NOT_AVAILABLE), label, stopTimer);
    }
    await this.run(entry.source, interaction, responder, label, stopTimer, (ctx) => {
      const options = readOptions(handler.options ?? {}, interaction.options);
      const context: CommandContext = {
        ...interactionContext(ctx, interaction.channelId, responder),
        interaction,
        showModal: (modal) => responder.showModal(modal),
      };
      return handler.execute(context, options);
    });
  }

  private async autocomplete(interaction: AutocompleteInteraction<'cached'>): Promise<void> {
    const entry = this.commands.get(interaction.commandName);
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    const handler = entry === undefined ? null : findHandler(entry.value, group, subcommand);
    const focused = interaction.options.getFocused(true);
    const options = handler?.options ?? {};
    const option = Object.hasOwn(options, focused.name) ? options[focused.name] : undefined;
    const suggest = option?.autocomplete;
    if (entry === undefined || suggest === undefined || !(await this.ready(interaction.guildId)) || !this.enabled(entry.source, interaction.guildId)) {
      return this.respond(interaction, []);
    }
    let choices: Choice[] = [];
    const label = `/${[interaction.commandName, subcommandPath(group, subcommand)].filter((part) => part !== '').join(' ')} ${focused.name}`;
    const result = await this.dispatcher.runHandler(entry.source.runtime, interaction.guildId, interaction.user.id, label, async (ctx) => {
      choices = await suggest(ctx, String(focused.value));
    }, { expectedError: isUserError });
    await this.respond(interaction, result.ok ? choices : []);
  }

  private async component(interaction: ComponentInteraction): Promise<void> {
    const kind = interaction.isButton() ? 'button' : 'modal';
    const parsed = parseCustomId(interaction.customId);
    const entry = parsed === null ? undefined : this.components.get(componentKey(parsed.module, kind, parsed.name));
    const responder = new Responder(interaction as ResponseTarget, entry?.value.ephemeral ?? false);
    const label = `${kind}:${parsed?.name ?? interaction.customId}`;
    const stopTimer = this.startDeferTimer(responder, label, entry?.value.defer);
    if (!(await this.ready(interaction.guildId))) return this.answer(responder.fail(NOT_READY), label, stopTimer);
    if (entry === undefined || parsed === null) return this.answer(responder.fail(COMPONENT_GONE), label, stopTimer);
    if (!this.enabled(entry.source, interaction.guildId)) {
      return this.answer(responder.fail(COMPONENT_UNAVAILABLE), label, stopTimer);
    }
    const component = entry.value;
    const target = { guildId: interaction.guildId, userId: interaction.user.id, channelId: interaction.channelId };
    const check: CustomIdCheck =
      this.signer === null
        ? { ok: false, reason: 'invalid' }
        : checkCustomId(this.signer, component, interaction.customId, target, this.now());
    if (!check.ok) {
      if (check.reason === 'expired') return this.answer(responder.fail(COMPONENT_EXPIRED), label, stopTimer);
      this.log.debug({ handler: label }, 'Rejected a component custom ID');
      return this.answer(responder.fail(COMPONENT_GONE), label, stopTimer);
    }
    await this.run(entry.source, interaction, responder, label, stopTimer, (ctx) => {
      const base = interactionContext(ctx, interaction.channelId, responder);
      if (component.kind === 'button') {
        const context: ButtonContext = {
          ...base,
          interaction: interaction as ButtonInteraction<'cached'>,
          showModal: (modal) => responder.showModal(modal),
          update: (message) => responder.update(message),
          deferUpdate: () => responder.deferUpdate(),
        };
        return component.execute(context, check.args);
      }
      const submitted = interaction as ModalSubmitInteraction<'cached'>;
      const context: ModalContext = {
        ...base,
        interaction: submitted,
        field: (customId) => submitted.fields.getTextInputValue(customId),
        update: (message) => responder.update(message),
        deferUpdate: () => responder.deferUpdate(),
      };
      return component.execute(context, check.args);
    });
  }

  private async run(
    source: InteractionSource,
    interaction: ChatInputCommandInteraction<'cached'> | ComponentInteraction,
    responder: Responder,
    label: string,
    stopTimer: () => void,
    fn: (ctx: HandlerContext) => unknown,
  ): Promise<void> {
    let result;
    try {
      result = await this.dispatcher.runHandler(source.runtime, interaction.guildId, interaction.user.id, label, fn, {
        expectedError: isUserError,
      });
    } finally {
      stopTimer();
    }
    const answer = result.ok
      ? responder.finish()
      : responder.fail(isUserError(result.error) ? result.error.message : GENERIC_FAILURE);
    await this.answer(answer, label);
  }

  /** Starts the defer clock when handling begins, so waiting for the guild gate counts against Discord's 3 s window. */
  private startDeferTimer(responder: Responder, label: string, mode: 'reply' | 'update' = 'reply'): () => void {
    const timer = setTimeout(() => {
      (mode === 'update' ? responder.deferUpdate() : responder.defer()).catch((error: unknown) => {
        this.log.warn({ err: error, handler: label }, 'Answering an interaction failed');
      });
    }, this.deferAfterMs);
    return () => clearTimeout(timer);
  }

  private async respond(interaction: AutocompleteInteraction<'cached'>, choices: Choice[]): Promise<void> {
    // Discord rejects the whole list if any choice has an empty name, so such choices are named after their value.
    const valid = choices
      .filter((choice) => typeof choice.value !== 'string' || choice.value.length <= MAX_CHOICE_LENGTH)
      .map((choice) => {
        const name = choice.name.trim() === '' ? String(choice.value) : choice.name;
        return { name: truncate(name, MAX_CHOICE_LENGTH), value: choice.value };
      })
      .filter((choice) => choice.name.trim() !== '')
      .slice(0, MAX_CHOICES);
    await this.answer(interaction.respond(valid), `/${interaction.commandName} autocomplete`);
  }

  private async answer(work: Promise<unknown>, label: string, stopTimer?: () => void): Promise<void> {
    stopTimer?.();
    try {
      await work;
    } catch (error) {
      this.log.warn({ err: error, handler: label }, 'Answering an interaction failed');
    }
  }

  private async ready(guildId: string): Promise<boolean> {
    try {
      return await this.guildGate(guildId);
    } catch {
      return false;
    }
  }

  private enabled(source: InteractionSource, guildId: string): boolean {
    return source.alwaysEnabled === true || this.enablement.isEnabled(guildId, source.runtime.name);
  }
}

function componentKey(module: string, kind: string, name: string): string {
  return `${module}:${kind}:${name}`;
}
