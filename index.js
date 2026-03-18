require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { Pool } = require('pg');

/*
========================================================
CONFIG
========================================================
*/

const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID || '';
const CREATE_VC_CHANNEL_ID = process.env.CREATE_VC_CHANNEL_ID || '';
const PRIVATE_VC_CATEGORY_ID = process.env.PRIVATE_VC_CATEGORY_ID || '';
const VC_CREATE_COOLDOWN_MS = Number(process.env.VC_CREATE_COOLDOWN_MS || 10000);
const res = await pool.query('SELECT current_database()');
console.log('DB NAME:', res.rows[0]);

/*
========================================================
CLIENT SETUP
========================================================
*/

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

/*
========================================================
POSTGRES SETUP
========================================================
Railway provides DATABASE_URL. This works well with pg.
========================================================
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

/*
========================================================
IN-MEMORY TEMP DATA
========================================================
These are temporary runtime helpers only.
No database needed for them.
========================================================
*/

// Prevent VC creation spam
const createCooldowns = new Map();

// Track pending join requests in memory
// key = requestId, value = { guildId, ownerId, requesterId, channelId, createdAt }
const pendingRequests = new Map();

/*
========================================================
DATABASE HELPERS
========================================================
*/

async function savePrivateVC(channelId, ownerId, guildId) {
  await pool.query(
    `
    INSERT INTO private_vcs (channel_id, owner_id, guild_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (channel_id) DO NOTHING
    `,
    [channelId, ownerId, guildId]
  );
}

async function deletePrivateVC(channelId) {
  await pool.query(
    `DELETE FROM private_vcs WHERE channel_id = $1`,
    [channelId]
  );
}

async function getPrivateVCByChannelId(channelId) {
  const result = await pool.query(
    `SELECT * FROM private_vcs WHERE channel_id = $1 LIMIT 1`,
    [channelId]
  );
  return result.rows[0] || null;
}

async function getPrivateVCByOwnerId(ownerId, guildId) {
  const result = await pool.query(
    `
    SELECT * FROM private_vcs
    WHERE owner_id = $1 AND guild_id = $2
    LIMIT 1
    `,
    [ownerId, guildId]
  );
  return result.rows[0] || null;
}

async function getAllPrivateVCs() {
  const result = await pool.query(`SELECT * FROM private_vcs`);
  return result.rows;
}

/*
========================================================
UTILITY HELPERS
========================================================
*/

function botMember(guild) {
  return guild.members.me;
}

function hasPermission(guild, permission) {
  const me = botMember(guild);
  if (!me) return false;
  return me.permissions.has(permission);
}

function buildRoomName(member) {
  const name = member.displayName || member.user.username;
  return `${name}'s Room`;
}

function makeRequestId() {
  return `${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
}

async function safeReply(interaction, options) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(options);
  }
  return interaction.reply(options);
}

/*
========================================================
AUTO ROLE
========================================================
*/

async function assignAutoRole(member) {
  if (!AUTO_ROLE_ID) return;

  const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
  if (!role) {
    console.warn(`[AutoRole] Role not found: ${AUTO_ROLE_ID}`);
    return;
  }

  const me = botMember(member.guild);
  if (!me) return;

  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.warn('[AutoRole] Missing ManageRoles permission.');
    return;
  }

  if (role.position >= me.roles.highest.position) {
    console.warn('[AutoRole] Bot role must be above the auto role.');
    return;
  }

  try {
    await member.roles.add(role);
    console.log(`[AutoRole] Assigned ${role.name} to ${member.user.tag}`);
  } catch (error) {
    console.error('[AutoRole] Failed to assign role:', error);
  }
}

/*
========================================================
PRIVATE VC HELPERS
========================================================
*/

async function createPrivateVoiceChannel(member) {
  const guild = member.guild;
  const me = botMember(guild);

  if (!me) return { ok: false, reason: 'Bot member not cached yet.' };

  // Basic permission checks
  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return { ok: false, reason: 'I need the Manage Channels permission.' };
  }

  if (!me.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
    return { ok: false, reason: 'I need the Move Members permission.' };
  }

  // Cooldown
  const lastCreate = createCooldowns.get(member.id) || 0;
  const now = Date.now();
  if (now - lastCreate < VC_CREATE_COOLDOWN_MS) {
    return { ok: false, reason: 'Please wait a moment before creating another VC.' };
  }

  // If the user already owns one, just move them there if possible
  const existingRecord = await getPrivateVCByOwnerId(member.id, guild.id);
  if (existingRecord) {
    const existingChannel = guild.channels.cache.get(existingRecord.channel_id);

    if (existingChannel && existingChannel.type === ChannelType.GuildVoice) {
      try {
        await member.voice.setChannel(existingChannel);
        return { ok: true, reused: true, channel: existingChannel };
      } catch (error) {
        console.error('[VC] Failed to move member into existing VC:', error);
        return { ok: false, reason: 'I created/found your VC, but could not move you into it.' };
      }
    }

    // Stale DB row cleanup
    await deletePrivateVC(existingRecord.channel_id);
  }

  const createVCChannel = guild.channels.cache.get(CREATE_VC_CHANNEL_ID);
  if (!createVCChannel || createVCChannel.type !== ChannelType.GuildVoice) {
    return { ok: false, reason: 'The Create VC channel is missing or not a voice channel.' };
  }

  try {
    const newChannel = await guild.channels.create({
      name: buildRoomName(member),
      type: ChannelType.GuildVoice,
      parent: PRIVATE_VC_CATEGORY_ID || createVCChannel.parentId || null,
      permissionOverwrites: [
        {
          // Hide from everyone by default
          id: guild.id,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
          ],
        },
        {
          // Owner permissions
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.Stream,
            PermissionsBitField.Flags.UseVAD,
          ],
        },
        {
          // Bot permissions
          id: me.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.MoveMembers,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ],
    });

    await savePrivateVC(newChannel.id, member.id, guild.id);
    createCooldowns.set(member.id, Date.now());

    try {
      await member.voice.setChannel(newChannel);
    } catch (error) {
      console.error('[VC] Created VC but failed to move member:', error);
    }

    console.log(`[VC] Created private VC ${newChannel.name} for ${member.user.tag}`);
    return { ok: true, channel: newChannel };
  } catch (error) {
    console.error('[VC] Failed to create private VC:', error);
    return { ok: false, reason: 'Failed to create the private voice channel.' };
  }
}

async function deletePrivateVoiceChannelIfEmpty(channel) {
  if (!channel || channel.type !== ChannelType.GuildVoice) return;

  const dbRecord = await getPrivateVCByChannelId(channel.id);
  if (!dbRecord) return;

  if (channel.members.size > 0) return;

  try {
    await deletePrivateVC(channel.id);
    await channel.delete('Private VC became empty');
    console.log(`[VC] Deleted empty private VC: ${channel.name}`);
  } catch (error) {
    console.error('[VC] Failed to delete empty private VC:', error);
  }
}

async function cleanupStalePrivateVCs() {
  const records = await getAllPrivateVCs();

  for (const record of records) {
    const guild = client.guilds.cache.get(record.guild_id);
    if (!guild) continue;

    const channel = guild.channels.cache.get(record.channel_id);

    // Delete stale DB rows if the channel no longer exists
    if (!channel) {
      await deletePrivateVC(record.channel_id);
      console.log(`[Cleanup] Removed stale DB row for missing channel ${record.channel_id}`);
      continue;
    }

    // If it exists and is empty, delete it
    if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
      await deletePrivateVoiceChannelIfEmpty(channel);
    }
  }
}

/*
========================================================
SLASH COMMAND: /requestjoin
========================================================
This lets someone request access to a private VC owner.
The owner receives buttons: Accept / Deny.
========================================================
*/

async function handleRequestJoinCommand(interaction) {
  const requester = interaction.member;
  const ownerUser = interaction.options.getUser('user', true);

  if (!interaction.guild) {
    return safeReply(interaction, {
      content: 'This command can only be used inside a server.',
      ephemeral: true,
    });
  }

  if (ownerUser.bot) {
    return safeReply(interaction, {
      content: 'You cannot request to join a bot’s VC.',
      ephemeral: true,
    });
  }

  if (ownerUser.id === requester.id) {
    return safeReply(interaction, {
      content: 'You already own your own VC request target.',
      ephemeral: true,
    });
  }

  const ownerMember = await interaction.guild.members.fetch(ownerUser.id).catch(() => null);
  if (!ownerMember) {
    return safeReply(interaction, {
      content: 'That user is not in this server.',
      ephemeral: true,
    });
  }

  const record = await getPrivateVCByOwnerId(ownerUser.id, interaction.guild.id);
  if (!record) {
    return safeReply(interaction, {
      content: 'That user does not currently own a private voice channel.',
      ephemeral: true,
    });
  }

  const channel = interaction.guild.channels.cache.get(record.channel_id);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await deletePrivateVC(record.channel_id);
    return safeReply(interaction, {
      content: 'That private voice channel no longer exists.',
      ephemeral: true,
    });
  }

  const requestId = makeRequestId();

  pendingRequests.set(requestId, {
    guildId: interaction.guild.id,
    ownerId: ownerUser.id,
    requesterId: requester.id,
    channelId: channel.id,
    createdAt: Date.now(),
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_accept_${requestId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`vc_deny_${requestId}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );

  await safeReply(interaction, {
    content: `Your request was sent to **${ownerUser.tag}**.`,
    ephemeral: true,
  });

  try {
    await ownerUser.send({
      content: `**${requester.user.tag}** wants to join your private VC in **${interaction.guild.name}**.`,
      components: [row],
    });
  } catch (error) {
    console.error('[RequestJoin] Could not DM VC owner:', error);
    pendingRequests.delete(requestId);

    await interaction.followUp({
      content: 'I could not send the request because that user has DMs disabled.',
      ephemeral: true,
    });
  }
}

async function handleRequestButton(interaction) {
  if (!interaction.customId.startsWith('vc_accept_') && !interaction.customId.startsWith('vc_deny_')) {
    return;
  }

  const isAccept = interaction.customId.startsWith('vc_accept_');
  const requestId = interaction.customId.replace('vc_accept_', '').replace('vc_deny_', '');

  const data = pendingRequests.get(requestId);
  if (!data) {
    return safeReply(interaction, {
      content: 'This request has expired or was already handled.',
      ephemeral: true,
    });
  }

  if (interaction.user.id !== data.ownerId) {
    return safeReply(interaction, {
      content: 'You are not allowed to respond to this request.',
      ephemeral: true,
    });
  }

  const guild = client.guilds.cache.get(data.guildId);
  if (!guild) {
    pendingRequests.delete(requestId);
    return safeReply(interaction, {
      content: 'The server could not be found.',
      ephemeral: true,
    });
  }

  const channel = guild.channels.cache.get(data.channelId);
  const requester = await guild.members.fetch(data.requesterId).catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildVoice) {
    pendingRequests.delete(requestId);
    await deletePrivateVC(data.channelId).catch(() => {});
    return safeReply(interaction, {
      content: 'That private VC no longer exists.',
      ephemeral: true,
    });
  }

  if (!requester) {
    pendingRequests.delete(requestId);
    return safeReply(interaction, {
      content: 'The requesting user could not be found.',
      ephemeral: true,
    });
  }

  if (!isAccept) {
    pendingRequests.delete(requestId);

    await interaction.update({
      content: `You denied **${requester.user.tag}**’s request.`,
      components: [],
    });

    try {
      await requester.send(`Your request to join **${interaction.user.tag}**’s private VC was denied.`);
    } catch (_) {}

    return;
  }

  try {
    await channel.permissionOverwrites.edit(requester.id, {
      ViewChannel: true,
      Connect: true,
      Speak: true,
      Stream: true,
      UseVAD: true,
    });

    pendingRequests.delete(requestId);

    await interaction.update({
      content: `You accepted **${requester.user.tag}**’s request. They can now join your VC.`,
      components: [],
    });

    try {
      await requester.send(`Your request to join **${interaction.user.tag}**’s private VC was accepted.`);
    } catch (_) {}
  } catch (error) {
    console.error('[RequestJoin] Failed to grant access:', error);

    pendingRequests.delete(requestId);

    await interaction.update({
      content: `Something went wrong while granting access to **${requester.user.tag}**.`,
      components: [],
    });
  }
}

/*
========================================================
EVENTS
========================================================
*/

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL successfully.');
  } catch (error) {
    console.error('PostgreSQL connection failed:', error);
  }

  try {
    await cleanupStalePrivateVCs();
  } catch (error) {
    console.error('Startup cleanup failed:', error);
  }
});

client.on(Events.GuildMemberAdd, async member => {
  await assignAutoRole(member);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // User joined the Create VC channel
    if (
      newState.channelId &&
      newState.channelId === CREATE_VC_CHANNEL_ID &&
      oldState.channelId !== CREATE_VC_CHANNEL_ID
    ) {
      const result = await createPrivateVoiceChannel(member);

      if (!result.ok) {
        try {
          await member.send(`I could not create your private VC: ${result.reason}`);
        } catch (_) {}
      }
    }

    // If someone leaves a private VC, delete it if empty
    if (oldState.channelId) {
      const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
      if (oldChannel) {
        await deletePrivateVoiceChannelIfEmpty(oldChannel);
      }
    }
  } catch (error) {
    console.error('[VoiceStateUpdate] Error:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'requestjoin') {
        await handleRequestJoinCommand(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      await handleRequestButton(interaction);
    }
  } catch (error) {
    console.error('[InteractionCreate] Error:', error);

    if (interaction.isRepliable()) {
      try {
        await safeReply(interaction, {
          content: 'An unexpected error occurred.',
          ephemeral: true,
        });
      } catch (_) {}
    }
  }
});

/*
========================================================
START
========================================================
*/

if (!process.env.TOKEN) {
  throw new Error('Missing TOKEN in .env');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in .env');
}

client.login(process.env.TOKEN);
