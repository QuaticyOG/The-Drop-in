require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('requestjoin')
    .setDescription('Request access to someone’s private voice channel')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The owner of the private voice channel')
        .setRequired(true)
    ),
].map(command => command.toJSON());

console.log(commands);

async function deployCommands() {
  try {
    if (!process.env.TOKEN) throw new Error('Missing TOKEN in .env');
    if (!process.env.CLIENT_ID) throw new Error('Missing CLIENT_ID in .env');
    if (!process.env.GUILD_ID) throw new Error('Missing GUILD_ID in .env');

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    console.log('Deploying slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );

    console.log('Slash commands deployed successfully.');
  } catch (error) {
    console.error('Failed to deploy slash commands:', error);
  }
}

deployCommands();
