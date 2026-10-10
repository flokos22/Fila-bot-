
'use strict';

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  ChannelType,
  Colors,
  EmbedBuilder,
} = require('discord.js');

// Configure estas variáveis na hospedagem.
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Configure DISCORD_TOKEN, CLIENT_ID e GUILD_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('configurar-servidor')
    .setDescription('Cria e organiza os canais, cargos e regras.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('verificar-config')
    .setDescription('Verifica os canais, categorias e cargos.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(command => command.toJSON());

const ROLES = [
  { name: 'Dono', color: Colors.Red, permissions: [] },
  {
    name: 'Admin',
    color: Colors.Orange,
    permissions: [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ViewAuditLog,
    ],
  },
  {
    name: 'Moderador',
    color: Colors.Blue,
    permissions: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.ModerateMembers,
    ],
  },
  { name: 'Staff', color: Colors.Purple, permissions: [] },
  { name: 'Membro', color: Colors.Grey, permissions: [] },
];

const STRUCTURE = [
  {
    category: '📌・INFORMAÇÕES',
    channels: [
      { name: '📜・regras', type: 'text' },
      { name: '📢・anúncios', type: 'text' },
    ],
  },
  {
    category: '💬・COMUNIDADE',
    channels: [
      { name: '💬・bate-papo', type: 'text' },
      { name: '⚽・geral-efootball', type: 'text' },
      { name: '🔎・procurar-jogador', type: 'text' },
      { name: '🎬・clips', type: 'text' },
      { name: '📸・prints', type: 'text' },
    ],
  },
  {
    category: '🏆・COMPETIÇÕES',
    channels: [
      { name: '📅・eventos', type: 'text' },
      { name: '📝・inscrições', type: 'text' },
      { name: '🏆・campeonatos', type: 'text' },
      { name: '🥇・ranking', type: 'text' },
      { name: '📊・resultados', type: 'text' },
    ],
  },
  {
    category: '🎤・CALLS',
    channels: [
      { name: '🔊・criar-call', type: 'voice' },
    ],
  },
  {
    category: '🛠️・SUPORTE',
    channels: [
      { name: '🎫・abrir-ticket', type: 'text' },
    ],
  },
  {
    category: '🔐・STAFF',
    private: true,
    channels: [
      { name: '💬・chat-staff', type: 'text' },
      { name: '📋・logs', type: 'text' },
      { name: '🎫・tickets-staff', type: 'text' },
    ],
  },
];

// REGRAS DO SERVIDOR
const RULES = [
  {
    name: '01 • RESPEITO',
    value: 'Proibido ofensas, discriminação e assédio.',
  },
  {
    name: '02 • SEM SPAM',
    value: 'Evite mensagens repetidas e divulgações sem autorização.',
  },
  {
    name: '03 • FAIR PLAY',
    value: 'Proibido usar trapaças ou prejudicar partidas de propósito.',
  },
  {
    name: '04 • CANAIS',
    value: 'Utilize cada canal para sua finalidade.',
  },
  {
    name: '05 • CALLS',
    value: 'Não perturbe outros membros nem atrapalhe as conversas.',
  },
  {
    name: '06 • PRIVACIDADE',
    value: 'Não divulgue dados pessoais de outros membros.',
  },
  {
    name: '07 • PUNIÇÕES',
    value: 'O descumprimento das regras pode resultar em aviso, timeout ou banimento.',
  },
];

function buildRulesEmbed() {
  const embed = new EmbedBuilder()
    .setColor(0xD4AF37)
    .setTitle('📜 REGRAS DO SERVIDOR')
    .setDescription(
      [
        '━━━━━━━━━━━━━━━━━━━━',
        '**LEIA ANTES DE PARTICIPAR**',
        'Para manter nossa comunidade de eFootball organizada, todos devem seguir as regras abaixo.',
        '━━━━━━━━━━━━━━━━━━━━',
      ].join('\n')
    )
    .setFooter({
      text: 'eFootball • Respeite as regras e os jogadores',
    })
    .setTimestamp();

  for (const rule of RULES) {
    embed.addFields({
      name: rule.name,
      value: rule.value,
      inline: false,
    });
  }

  embed.addFields({
    name: '━━━━━━━━━━━━━━━━━━━━',
    value: 'Ao continuar no servidor, você concorda em respeitar estas regras.',
    inline: false,
  });

  return embed;
}

function normalize(text) {
  return text.normalize('NFKC').trim().toLowerCase();
}

function findRole(guild, name) {
  return guild.roles.cache.find(
    role => normalize(role.name) === normalize(name)
  );
}

function findCategory(guild, name) {
  return guild.channels.cache.find(
    channel =>
      channel.type === ChannelType.GuildCategory &&
      normalize(channel.name) === normalize(name)
  );
}

function findChannel(guild, definition) {
  const type = definition.type === 'voice'
    ? ChannelType.GuildVoice
    : ChannelType.GuildText;

  return guild.channels.cache.find(
    channel =>
      channel.type === type &&
      normalize(channel.name) === normalize(definition.name)
  );
}

async function createMissingRoles(guild) {
  const roles = {};

  for (const definition of ROLES) {
    let role = findRole(guild, definition.name);

    if (!role) {
      role = await guild.roles.create({
        name: definition.name,
        color: definition.color,
        permissions: new PermissionsBitField(definition.permissions),
        hoist: ['Dono', 'Admin', 'Moderador', 'Staff'].includes(definition.name),
        reason: 'Configuração do servidor eFootball',
      });
    }

    roles[definition.name] = role;
  }

  return roles;
}

function staffPermissions(guild, staffRoles, botMember) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...staffRoles.map(role => ({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
      ],
    })),
  ];

  if (botMember) {
    overwrites.push({
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  return overwrites;
}

async function createOrReuseCategory(guild, group, staffRoles) {
  let category = findCategory(guild, group.category);

  if (!category) {
    category = await guild.channels.create({
      name: group.category,
      type: ChannelType.GuildCategory,
      ...(group.private
        ? {
            permissionOverwrites: staffPermissions(
              guild,
              staffRoles,
              guild.members.me
            ),
          }
        : {}),
      reason: 'Organização do servidor eFootball',
    });
  } else if (group.private) {
    await category.permissionOverwrites.set(
      staffPermissions(guild, staffRoles, guild.members.me),
      'Configuração da categoria privada Staff'
    );
  }

  return category;
}

async function createOrReuseChannel(guild, definition, category, group) {
  let channel = findChannel(guild, definition);

  if (!channel) {
    channel = await guild.channels.create({
      name: definition.name,
      type: definition.type === 'voice'
        ? ChannelType.GuildVoice
        : ChannelType.GuildText,
      parent: category.id,
      reason: 'Organização do servidor eFootball',
    });
  } else if (channel.parentId !== category.id) {
    await channel.setParent(category.id, {
      lockPermissions: Boolean(group.private),
      reason: 'Organização dos canais do servidor',
    });
  }

  if (group.private && channel.parentId === category.id) {
    await channel.lockPermissions();
  }

  return channel;
}

async function publishRules(channel) {
  if (channel.type !== ChannelType.GuildText) return 'canal inválido';

  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);

  const exists = recent?.some(message =>
    message.author.id === client.user.id &&
    message.embeds.some(embed =>
      embed.title === '📜 REGRAS DO SERVIDOR'
    )
  );

  if (exists) return 'já publicadas';

  await channel.send({
    embeds: [buildRulesEmbed()],
  });

  return 'publicadas';
}

async function configureServer(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const bot = guild.members.me;

  if (!bot.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error('O bot precisa da permissão Gerenciar Canais.');
  }

  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('O bot precisa da permissão Gerenciar Cargos.');
  }

  const roles = await createMissingRoles(guild);

  const staffRoles = ['Dono', 'Admin', 'Moderador', 'Staff']
    .map(name => roles[name]);

  let categoriesCreated = 0;
  let channelsCreated = 0;
  let channelsReused = 0;
  let rulesStatus = 'não encontrado';

  for (const group of STRUCTURE) {
    const previousCategory = findCategory(guild, group.category);

    const category = await createOrReuseCategory(
      guild,
      group,
      staffRoles
    );

    if (!previousCategory) categoriesCreated++;

    for (const definition of group.channels) {
      const previousChannel = findChannel(guild, definition);

      const channel = await createOrReuseChannel(
        guild,
        definition,
        category,
        group
      );

      if (previousChannel) {
        channelsReused++;
      } else {
        channelsCreated++;
      }

      if (definition.name === '📜・regras') {
        rulesStatus = await publishRules(channel);
      }
    }
  }

  return {
    categoriesCreated,
    channelsCreated,
    channelsReused,
    rulesStatus,
  };
}

async function verifyServer(guild) {
  await guild.roles.fetch();
  await guild.channels.fetch();

  const missingRoles = ROLES
    .filter(role => !findRole(guild, role.name))
    .map(role => role.name);

  const missingCategories = [];
  const missingChannels = [];

  for (const group of STRUCTURE) {
    if (!findCategory(guild, group.category)) {
      missingCategories.push(group.category);
    }

    for (const definition of group.channels) {
      if (!findChannel(guild, definition)) {
        missingChannels.push(definition.name);
      }
    }
  }

  return { missingRoles, missingCategories, missingChannels };
}

client.once('ready', async () => {
  console.log(`Bot conectado: ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log('Comandos registrados.');
  } catch (error) {
    console.error('Erro ao registrar comandos:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.guildId !== GUILD_ID) {
    return interaction.reply({
      content: 'Este bot não está configurado para este servidor.',
      ephemeral: true,
    });
  }

  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const isAdmin = interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  );

  if (!isOwner && !isAdmin) {
    return interaction.reply({
      content: 'Somente o dono ou um administrador pode usar este comando.',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    if (interaction.commandName === 'configurar-servidor') {
      const result = await configureServer(interaction.guild);

      return interaction.editReply([
        '✅ **Configuração concluída**',
        `Categorias novas: ${result.categoriesCreated}`,
        `Canais novos: ${result.channelsCreated}`,
        `Canais reutilizados: ${result.channelsReused}`,
        `Embed das regras: ${result.rulesStatus}`,
        '',
        'Confira as permissões e a hierarquia dos cargos no Discord.',
        'Os bots externos, como Ticket Tool, Dyno e TempVoice, precisam ser configurados separadamente.',
      ].join('\n'));
    }

    if (interaction.commandName === 'verificar-config') {
      const result = await verifyServer(interaction.guild);

      return interaction.editReply([
        '**Verificação do servidor**',
        `Cargos faltando: ${result.missingRoles.join(', ') || 'nenhum'}`,
        `Categorias faltando: ${result.missingCategories.join(', ') || 'nenhuma'}`,
        `Canais faltando: ${result.missingChannels.join(', ') || 'nenhum'}`,
      ].join('\n'));
    }
  } catch (error) {
    console.error(error);

    return interaction.editReply(
      `Erro: ${error.message}\nConfira as permissões e a posição do cargo do bot.`
    );
  }
});

client.on('error', console.error);

client.login(TOKEN).catch(error => {
  console.error('Erro ao conectar. Verifique DISCORD_TOKEN:', error.message);
  process.exit(1);
});
