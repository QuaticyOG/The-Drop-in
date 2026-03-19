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
  const giveawayTimeouts = new Map();

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

    // ✅ GIVEAWAYS TABLES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS giveaways (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        end_time BIGINT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS giveaway_participants (
        message_id TEXT,
        user_id TEXT,
        PRIMARY KEY (message_id, user_id)
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
  // GIVEAWAY SYSTEM
  // =========================
  async function endGiveaway(client, pool, g) {
    try {
      const participantsRes = await pool.query(
        'SELECT user_id FROM giveaway_participants WHERE message_id = $1',
        [g.message_id]
      );

      const participants = participantsRes.rows.map(r => r.user_id);

      const channel = await client.channels.fetch(g.channel_id).catch(() => null);
      if (!channel) return;

      if (participants.length === 0) {
        await channel.send('❌ Giveaway ended. No participants.');
      } else {
        const winner = participants[Math.floor(Math.random() * participants.length)];
        await channel.send(`🎉 Winner: <@${winner}>`);
      }

      await pool.query('DELETE FROM giveaways WHERE message_id = $1', [g.message_id]);
      await pool.query('DELETE FROM giveaway_participants WHERE message_id = $1', [g.message_id]);

    } catch (err) {
      console.error('Giveaway error:', err);
    }
  }

async function restoreGiveaways() {
  const res = await pool.query('SELECT * FROM giveaways');

  for (const g of res.rows) {
    const remaining = g.end_time - Date.now();

    if (remaining <= 0) {
      endGiveaway(client, pool, g);
    } else {
      const timeout = setTimeout(() => {
        endGiveaway(client, pool, g);
        giveawayTimeouts.delete(g.message_id);
      }, remaining);

      giveawayTimeouts.set(g.message_id, timeout);
    }
  }
}

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

  if (cooldowns.has(member.id) && cooldowns.get(member.id) > now) return;

  // ✅ CHECK EXISTING VC
  const existing = await getVCByOwner(member.id, guild.id);

  if (existing) {
    const ch = guild.channels.cache.get(existing.channel_id);

    if (ch) {
      setTimeout(async () => {
        try {
          await member.voice.setChannel(ch);
        } catch (err) {
          console.error('Rejoin move failed:', err);
        }
      }, 500);

      return; // 🚨 STOP HERE (no new VC)
    }
  }

  // ✅ CREATE NEW VC
  const channel = await guild.channels.create({
    name: `${member.displayName}'s Playground`,
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

  try {
    await member.voice.setChannel(channel);
  } catch (err) {
    console.error('Move failed:', err);
  }
}

  async function deleteIfEmpty(channel) {
    const db = await getVCByChannel(channel.id);
    if (!db) return;
    if (channel.members?.size) return;

    await deleteVC(channel.id);
    await channel.delete();
  }

  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);

    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL successfully.');
    await initDatabase();
    await restoreGiveaways();

    const commands = [
      new SlashCommandBuilder()
        .setName('requestjoin')
        .setDescription('Request to join a private VC')
        .addUserOption(option =>
          option.setName('user').setDescription('VC owner').setRequired(true)
        ),

new SlashCommandBuilder()
  .setName('endgiveaway')
  .setDescription('End a giveaway early')
  .addStringOption(o =>
    o.setName('messageid')
      .setDescription('Giveaway message ID')
      .setRequired(true)
  ),
      
      new SlashCommandBuilder()
        .setName('postreact')
        .setDescription('Post notification role button'),

      new SlashCommandBuilder().setName('postinfo').setDescription('Post VC system info'),
      new SlashCommandBuilder().setName('postrules').setDescription('Post VC rules'),

      // ✅ GIVEAWAY COMMAND
      new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Start a giveaway')
        .addStringOption(o => o.setName('title').setDescription('Title').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Description').setRequired(true))
        .addIntegerOption(o =>
  o.setName('time')
    .setDescription('Time amount')
    .setRequired(true)
)
.addStringOption(o =>
  o.setName('unit')
    .setDescription('Time unit')
    .setRequired(true)
    .addChoices(
      { name: 'Seconds', value: 'seconds' },
      { name: 'Hours', value: 'hours' },
      { name: 'Days', value: 'days' }
    )
)
        .addStringOption(o => o.setName('image').setDescription('Image URL').setRequired(false)),
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log('✅ Slash commands deployed');

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

  // CREATE VC
  if (
    newState.channelId === CREATE_VC_CHANNEL_ID &&
    newState.member
  ) {
    setTimeout(() => {
  createVC(newState.member);
}, 500);
  }

  // DELETE VC
  if (oldState.channel && oldState.channel.id !== CREATE_VC_CHANNEL_ID) {
    setTimeout(() => {
      deleteIfEmpty(oldState.channel);
    }, 2000);
  }
});
  
client.on(Events.InteractionCreate, async (i) => {
  
// ==============================
// BUTTON HANDLER
// ==============================
if (i.isButton()) {

  // ==============================
  // VC REQUEST BUTTONS
  // ==============================
  if (i.customId.includes('_')) {
    const [action, id] = i.customId.split('_');
    const data = requests.get(id);

    if (data) {
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

        requests.delete(id);
        return i.update({ content: '✅ Accepted', components: [] });
      }

      if (action === 'deny') {
        requests.delete(id);
        return i.update({ content: '❌ Denied', components: [] });
      }
    }
  }

  // ==============================
  // TOGGLE NOTIFICATIONS
  // ==============================
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

  // ==============================
  // GIVEAWAY JOIN
  // ==============================
  if (i.customId.startsWith('giveaway_join_')) {
    const exists = await pool.query(
      'SELECT 1 FROM giveaway_participants WHERE message_id=$1 AND user_id=$2',
      [i.message.id, i.user.id]
    );

    if (exists.rowCount > 0) {
      return i.reply({ content: '❌ Already joined!', ephemeral: true });
    }

    await pool.query(
      'INSERT INTO giveaway_participants (message_id, user_id) VALUES ($1,$2)',
      [i.message.id, i.user.id]
    );

    return i.reply({ content: '✅ Joined!', ephemeral: true });
  }
}
  
// ==============================
// COMMAND HANDLER
// ==============================
  if (i.isChatInputCommand()) {

    if (i.commandName === 'requestjoin') {

  const target = i.options.getUser('user');
  const guild = i.guild;

  // 🔍 find VC
  const vc = await getVCByOwner(target.id, guild.id);

  if (!vc) {
    return i.reply({ content: '❌ User has no private VC.', ephemeral: true });
  }

  const channel = guild.channels.cache.get(vc.channel_id);

  if (!channel) {
    return i.reply({ content: '❌ VC not found.', ephemeral: true });
  }

  const id = Date.now().toString();

  // 💾 store request
  requests.set(id, {
    owner: target.id,
    requester: i.user.id,
    channel: channel.id,
    guildId: guild.id,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${id}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId(`deny_${id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
  );

  const requestChannel = guild.channels.cache.get(REQUEST_CHANNEL_ID);

  if (!requestChannel) {
    return i.reply({ content: '❌ Request channel not set.', ephemeral: true });
  }

  await requestChannel.send({
    content: `📩 <@${target.id}>, <@${i.user.id}> wants to join your VC`,
    components: [row],
  });

  return i.reply({
    content: '✅ Request sent!',
    ephemeral: true,
  });
}
    
// ==============================
// END GIVEAWAY
// ==============================
if (i.commandName === 'endgiveaway') {

  const allowedRole = '1483822511987888243';

  if (!i.member.roles.cache.has(allowedRole)) {
    return i.reply({ content: '❌ No permission', ephemeral: true });
  }

  const messageId = i.options.getString('messageid');

  const res = await pool.query(
    'SELECT * FROM giveaways WHERE message_id = $1',
    [messageId]
  );

  const giveaway = res.rows[0];

  if (!giveaway) {
    return i.reply({ content: '❌ Giveaway not found.', ephemeral: true });
  }

  // 🧠 CLEAR TIMER
  const timeout = giveawayTimeouts.get(messageId);
  if (timeout) {
    clearTimeout(timeout);
    giveawayTimeouts.delete(messageId);
  }

  await endGiveaway(client, pool, giveaway);

  return i.reply({
    content: '✅ Giveaway ended.',
    ephemeral: true
  });
}
    
    // ==============================
    // GIVEAWAY
    // ==============================
    if (i.commandName === 'giveaway') {

      const allowedRole = '1483822511987888243';

      if (!i.member.roles.cache.has(allowedRole)) {
        return i.reply({ content: '❌ No permission', ephemeral: true });
      }

      const title = i.options.getString('title');
      const description = i.options.getString('description');
      const time = i.options.getInteger('time');
const unit = i.options.getString('unit');

let duration;

if (unit === 'seconds') duration = time;
if (unit === 'hours') duration = time * 60 * 60;
if (unit === 'days') duration = time * 60 * 60 * 24;
      const image = i.options.getString('image');

      const endTime = Date.now() + duration * 1000;

      const embed = new EmbedBuilder()
        .setColor('#f70707')
        .setTitle(`🎉 ${title}`)
        .setDescription(`${description}\n\n⏰ Ends <t:${Math.floor(endTime / 1000)}:R>`);

      if (image) embed.setImage(image);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`giveaway_join_${Date.now()}`)
          .setLabel('Join Giveaway')
          .setStyle(ButtonStyle.Danger)
      );

      const msg = await i.reply({
        embeds: [embed],
        components: [row],
        fetchReply: true,
      });

      await pool.query(
        'INSERT INTO giveaways (message_id, channel_id, guild_id, end_time) VALUES ($1,$2,$3,$4)',
        [msg.id, msg.channel.id, msg.guild.id, endTime]
      );

const timeout = setTimeout(() => {
  endGiveaway(client, pool, {
    message_id: msg.id,
    channel_id: msg.channel.id,
    guild_id: msg.guild.id,
    end_time: endTime
  });

  giveawayTimeouts.delete(msg.id);
}, duration * 1000);

giveawayTimeouts.set(msg.id, timeout);
    }

    // ==============================
    // INFO
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
      return i.reply({ content: 'Posted!', ephemeral: true });
    }

    // ==============================
    // RULES
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
      return i.reply({ content: 'Posted!', ephemeral: true });
    }

    // ==============================
    // POST REACT
    // ==============================
    if (i.commandName === 'postreact') {
      const embed = new EmbedBuilder()
        .setTitle('🔔 Notifications')
        .setDescription(
          'Click the button below to **toggle notifications** for streams or giveaways.\n\nYou will get pinged when Quaticy or Cauz goes live. Or when we are hosting a giveaway.'
        )
        .setColor('#f70707');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('toggle_notifications')
          .setLabel('Toggle Notifications')
          .setStyle(ButtonStyle.Danger)
      );

      await i.channel.send({
        embeds: [embed],
        components: [row],
      });

      return i.reply({ content: 'Posted!', ephemeral: true });
    }
  }
});
  
  await client.login(process.env.TOKEN);
})();
