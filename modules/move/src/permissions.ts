import { ChannelType, PermissionFlagsBits, type GuildMember, type GuildTextBasedChannel } from 'discord.js';

const SOURCE_NEEDS = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ['Manage Messages', PermissionFlagsBits.ManageMessages],
] as const;

const isThread = (channel: GuildTextBasedChannel): boolean => channel.isThread();

/** A private thread is visible to its members and to those who can manage threads. */
async function canSeeThread(channel: GuildTextBasedChannel, member: GuildMember): Promise<boolean> {
  if (!channel.isThread() || channel.type !== ChannelType.PrivateThread) return true;
  if (channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads) === true) return true;
  return (await channel.members.fetch({ member: member.id }).catch(() => null)) !== null;
}

function missing(
  who: string,
  channel: GuildTextBasedChannel,
  member: GuildMember,
  needs: ReadonlyArray<readonly [string, bigint]>,
  checkedOn: GuildTextBasedChannel = channel,
): string[] {
  const held = checkedOn.permissionsFor(member);
  return needs.filter(([, flag]) => held?.has(flag) !== true).map(([name]) => `${who}: ${name} in #${checkedOn.name}`);
}

async function threadAccess(who: string, channel: GuildTextBasedChannel, member: GuildMember): Promise<string[]> {
  return (await canSeeThread(channel, member)) ? [] : [`${who}: access to #${channel.name} (join the private thread or Manage Threads)`];
}

/**
 * Names the permissions missing for a move, as `You: <permission> in #<channel>` for the moderator and
 * `Bot: <permission> in #<channel>` for the bot. Empty when the move may go ahead.
 */
export async function checkPermissions(
  source: GuildTextBasedChannel,
  target: GuildTextBasedChannel,
  moderator: GuildMember,
  me: GuildMember,
): Promise<string[]> {
  const targetThread = isThread(target);
  const targetParent = target.isThread() ? (target.parent ?? target) : target;
  const found: string[] = [];
  for (const [who, member] of [['You', moderator], ['Bot', me]] as const) {
    found.push(...(await threadAccess(who, source, member)), ...missing(who, source, member, SOURCE_NEEDS));
    found.push(...(await threadAccess(who, target, member)));
  }
  found.push(
    ...missing('You', target, moderator, [
      ['View Channel', PermissionFlagsBits.ViewChannel],
      targetThread ? ['Send Messages in Threads', PermissionFlagsBits.SendMessagesInThreads] : ['Send Messages', PermissionFlagsBits.SendMessages],
    ]),
    ...missing('Bot', target, me, [
      ['View Channel', PermissionFlagsBits.ViewChannel],
      // Adding a reaction needs the message history.
      ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
      ['Attach Files', PermissionFlagsBits.AttachFiles],
      ['Add Reactions', PermissionFlagsBits.AddReactions],
      ['Use External Emojis', PermissionFlagsBits.UseExternalEmojis],
    ]),
    ...missing('Bot', target, me, [['Manage Webhooks', PermissionFlagsBits.ManageWebhooks]], targetParent as GuildTextBasedChannel),
  );
  return found;
}
