require('dotenv').config();

(async () => {
  const {
    Client,
    GatewayIntentBits,
    ChannelType,
    PermissionsBitField,
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
  } = require('discord.js');

  const { Pool } = require('pg');

  const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;
  const CREATE_VC_CHANNEL_ID = process.env.CREATE_VC_CHANNEL_ID;
  const PRIVATE_VC_CATEGORY_ID = process.env.PRIVATE_VC_CATEGORY_ID || '';
  const REQUEST_CHANNEL_ID = process.env.REQUEST_CHANNEL_ID;
  const STREAM_CHANNEL_ID = process.env.STREAM_NOTIFICATION_CHANNEL_ID;

  const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
  const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

  const VC_CREATE_COOLDOWN = 10000;

  let twitchToken = null;
  let liveCache = new Map();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  async function initDatabase() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS private_vcs (
        channel_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database ready');
  }

  const cooldowns = new Map();
  const requests = new Map();

  const saveVC = (cid, oid, gid) =>
    pool.query(
      `INSERT INTO private_vcs (channel_id, owner_id, guild_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [cid, oid, gid]
    );

  const deleteVC = (cid) =>
    pool.query(`DELETE FROM private_vcs WHERE channel_id=$1`, [cid]);

  const getVCByOwner = async (oid, gid) => {
    const r = await pool.query(
      `SELECT * FROM private_vcs WHERE owner_id=$1 AND guild_id=$2 LIMIT 1`,
      [oid, gid]
    );
    return r.rows[0];
  };

  const getVCByChannel = async (cid) => {
    const r = await pool.query(
      `SELECT * FROM private_vcs WHERE channel_id=$1`,
      [cid]
    );
    return r.rows[0];
  };

  // =========================
  // TWITCH
  // =========================
  async function getTwitchToken() {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
      { method: 'POST' }
    );

    const data = await res.json();
    twitchToken = data.access_token;
  }

  async function checkStreamer(username) {
    if (!twitchToken) await getTwitchToken();

    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${username}`,
      {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          Authorization: `Bearer ${twitchToken}`,
        },
      }
    );

    const data = await res.json();
    return data.data[0];
  }

  async function giveRole(member) {
    if (!AUTO_ROLE_ID) return;

    const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
    if (!role) return;

    const me = member.guild.members.me;
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
    if (role.position >= me.roles.highest.position) return;

    try {
      await member.roles.add(role);
    } catch {}
  }

  async function createVC(member) {
    const guild = member.guild;
    const now = Date.now();

    if (cooldowns.get(member.id) > now) return;

    const existing = await getVCByOwner(member.id, guild.id);
    if (existing) {
      const ch = guild.channels.cache.get(existing.channel_id);
      if (ch) return member.voice.setChannel(ch);
    }

    const channel = await guild.channels.create({
      name: `${member.displayName}'s Room`,
      type: ChannelType.GuildVoice,
      parent: PRIVATE_VC_CATEGORY_ID || null,
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
          deny: [PermissionsBitField.Flags.Connect],
        },
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.Stream,
          ],
        },
      ],
    });

    await saveVC(channel.id, member.id, guild.id);
    cooldowns.set(member.id, now + VC_CREATE_COOLDOWN);

    await member.voice.setChannel(channel);
  }

  async function deleteIfEmpty(channel) {
    const db = await getVCByChannel(channel.id);
    if (!db) return;
    if (channel.members.size > 0) return;

    await deleteVC(channel.id);
    await channel.delete();
  }

  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);

    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL successfully.');
    await initDatabase();

    const commands = [
      new SlashCommandBuilder()
        .setName('requestjoin')
        .setDescription('Request to join a private VC')
        .addUserOption(option =>
          option.setName('user').setDescription('VC owner').setRequired(true)
        ),
      
      new SlashCommandBuilder()
        .setName('postreact')
        .setDescription('Post notification role button'),
      
      new SlashCommandBuilder().setName('postinfo').setDescription('Post VC system info'),
      new SlashCommandBuilder().setName('postrules').setDescription('Post VC rules'),
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log('✅ Slash commands deployed');

    // Twitch checker (FIXED)
    setInterval(async () => {
      try {
        const channel = client.channels.cache.get(STREAM_CHANNEL_ID);
        if (!channel) return;

        const streamers = ['quaticy', 'cauzgod'];

        for (const name of streamers) {
          const stream = await checkStreamer(name);

          if (stream) {
            if (!liveCache.get(name)) {
              liveCache.set(name, true);

              await channel.send({
                content: `<@&1484186734714552360>`,
                embeds: [
                  {
                    title: `📺 ${name} is LIVE!`,
                    description: stream.title || 'Streaming now!',
                    url: `https://twitch.tv/${name}`,
                    color: 0x9146ff,
                    image: {
                      url: stream.thumbnail_url
                        .replace('{width}', '1280')
                        .replace('{height}', '720'),
                    },
                  },
                ],
              });
            }
          } else {
            liveCache.set(name, false);
          }
        }
      } catch (err) {
        console.error('Twitch error:', err);
      }
    }, 60000);
  });

  client.on(Events.GuildMemberAdd, giveRole);

  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    if (newState.channelId === CREATE_VC_CHANNEL_ID) {
      await createVC(member);
    }

    if (oldState.channelId) {
      const ch = oldState.guild.channels.cache.get(oldState.channelId);
      if (ch) await deleteIfEmpty(ch);
    }
  });

  client.on(Events.InteractionCreate, async (i) => {
    // ==============================
// BUTTON HANDLER (MERGED)
// ==============================
if (i.isButton()) {

  // 🔔 Toggle Notifications Role
  if (i.customId === 'toggle_notifications') {
    const roleId = '1484186734714552360';
    const member = await i.guild.members.fetch(i.user.id);

    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);

      return i.reply({
        content: '❌ Notifications disabled.',
        ephemeral: true,
      });
    } else {
      await member.roles.add(roleId);

      return i.reply({
        content: '✅ Notifications enabled!',
        ephemeral: true,
      });
    }
  }

  // VC request buttons
  const [action, id] = i.customId.split('_');
  const data = requests.get(id);
  if (!data) return;

  if (i.user.id !== data.owner) {
    return i.reply({ content: 'Not your request.', ephemeral: true });
  }

  const guild = client.guilds.cache.get(data.guildId);
  if (!guild) return;

  const ch = guild.channels.cache.get(data.channel);

  if (action === 'accept') {
    await ch.permissionOverwrites.edit(data.requester, {
      ViewChannel: true,
      Connect: true,
    });

    return i.update({ content: '✅ Accepted', components: [] });
  } else {
    return i.update({ content: '❌ Denied', components: [] });
  }
}
    if (i.isChatInputCommand()) {

      // ==============================
      // INFO (YOUR FULL VERSION)
      // ==============================
      if (i.commandName === 'postinfo') {
        const embed = new EmbedBuilder()
          .setTitle('🎧 Welcome to The Rubber Hose Club')
          .setDescription(
            'This server is the official community for **Quaticy** ⚡ and **Cauz** — built for chilling, gaming, and streaming together.\n\nWhether you’re here from stream or just vibing, you’re welcome 👀'
          )
          .addFields(
            {
              name: '📺 Streaming Notifications',
              value:
                'Stay updated when we go live in <#1483825983092949072> — you’ll get notified automatically when we start streaming.',
            },
            {
              name: '📜 Rules',
              value:
                'Make sure to read <#1483826481691103373> before chatting to keep everything smooth.',
            },
            {
              name: '🎧 Private Voice Channels',
              value:
                'Join the **Create VC** channel to get your own private room.',
            },
            {
              name: '👀 Visibility',
              value:
                'Everyone can see VCs, but only approved users can join.',
            },
            {
              name: '📩 Request Access',
              value:
                'Use `/requestjoin @user` to ask to join someone’s VC.',
            },
            {
              name: '🗑 Auto Cleanup',
              value:
                'Empty VCs are automatically deleted.',
            }
          )
          .setColor('#f70707')
          .setFooter({ text: 'Enjoy your stay 💜' });

        await i.channel.send({ embeds: [embed] });

        return i.reply({
          content: 'Posted!',
          ephemeral: true,
        });
      }

      // ==============================
      // RULES (YOUR FULL VERSION)
      // ==============================
      if (i.commandName === 'postrules') {
        const embed = new EmbedBuilder()
          .setTitle('📖 Server Rules & Guidelines')
          .setDescription(
            'Welcome to the **The Rubber Hose Club**!\nPlease follow these rules to keep the server safe, respectful, and enjoyable for everyone 🙌'
          )
          .addFields(
            {
              name: '📜 Discord Terms',
              value:
                '[Terms](https://discord.com/terms)\n[Guidelines](https://discord.com/guidelines)',
            },
            {
              name: '🤝 Respect Everyone',
              value:
                'No racism, discrimination, hate speech, or harassment.\nContext matters — but targeting or insulting others is never allowed.',
            },
            {
              name: '🚫 No Harassment or Spam',
              value:
                'Avoid spamming, trolling, or disruptive behavior.',
            },
            {
              name: '📢 No Advertising',
              value:
                'No self-promo or advertising other servers/services.',
            },
            {
              name: '🔞 No NSFW Content',
              value:
                'Strictly no adult or inappropriate content.',
            },
            {
              name: '⚠️ No Scamming',
              value:
                'Any scams or fraud will result in immediate action.',
            },
            {
              name: '🛡️ Protect Privacy',
              value:
                'Do not share personal or private information.',
            },
            {
              name: '🏛️ Content Rules',
              value:
                'Use correct channels and avoid political/religious debates.',
            },
            {
              name: '👮 Respect Staff',
              value:
                'Staff decisions are final — they’re here to help everyone.',
            },
            {
              name: '🎉 Giveaways',
              value:
                'Everyone can join if they meet the requirements (boosters, roles, etc).',
            },
            {
              name: '🚨 Report Issues',
              value:
                'See something wrong? Contact Mods immediately.',
            }
          )
          .setColor('#f70707')
          .setFooter({ text: 'Failure to follow rules may result in punishment.' });

        await i.channel.send({ embeds: [embed] });

        return i.reply({
          content: 'Posted!',
          ephemeral: true,
        });
      }

      // ==============================
      // POST REACT ROLE
      // ==============================
if (i.commandName === 'postreact') {
  const embed = new EmbedBuilder()
    .setTitle('🔔 Notifications')
    .setDescription(
      'Click the button below to **toggle notifications** for streams.\n\nYou will get pinged when Quaticy or Cauz goes live.'
    )
    .setColor('#f70707');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('toggle_notifications')
      .setLabel('Toggle Notifications')
      .setStyle(ButtonStyle.Danger) // red button
  );

  await i.channel.send({
    embeds: [embed],
    components: [row],
  });

  return i.reply({
    content: 'Posted!',
    ephemeral: true,
  });
}
      // REQUEST JOIN (unchanged)
      if (i.commandName === 'requestjoin') {
        const user = i.options.getUser('user');
        const vc = await getVCByOwner(user.id, i.guild.id);

        if (!vc) {
          return i.reply({ content: 'No VC found.', ephemeral: true });
        }

        const id = Date.now().toString();

        requests.set(id, {
          owner: user.id,
          requester: i.user.id,
          channel: vc.channel_id,
          guildId: i.guild.id,
        });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`accept_${id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`deny_${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
        );

        const requestChannel = i.guild.channels.cache.get(REQUEST_CHANNEL_ID);

        await requestChannel.send({
          content: `🔔 **VC Join Request**\nRequester: <@${i.user.id}>\nOwner: <@${user.id}>`,
          components: [row],
        });

        await i.reply({ content: 'Request sent!', ephemeral: true });
      }
    }
  });

  await client.login(process.env.TOKEN);
})();
