const http = require("http");

const PORT = process.env.PORT || 3000;

// =====================================================
// SERVIDOR HTTP PARA O RENDER
// =====================================================

http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("eFootball X1 Bot online!");
}).listen(PORT, () => {
    console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// =====================================================
// DISCORD
// =====================================================

const {
    Client,
    GatewayIntentBits,
    ChannelType,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    SlashCommandBuilder
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// =====================================================
// CONFIGURAÇÕES
// =====================================================

const CATEGORIAS = {
    INFORMACOES: "📌 INFORMAÇÕES",
    MATCHMAKING: "🎮 MATCHMAKING",
    COMPETITIVO: "🏆 COMPETITIVO",
    COMUNIDADE: "💬 COMUNIDADE",
    SUPORTE: "🛠️ SUPORTE",
    STAFF: "🔒 STAFF"
};

const CANAIS = {
    INFORMACOES: [
        ["📢・anúncios", true],
        ["📜・regras", true],
        ["❓・como-jogar", true]
    ],

    MATCHMAKING: [
        ["⚔️・fila-x1", false],
        ["🔎・procurar-jogador", false],
        ["🎮・partidas", false]
    ],

    COMPETITIVO: [
        ["🏆・ranking", true],
        ["👤・perfis", true],
        ["📊・histórico", true]
    ],

    COMUNIDADE: [
        ["💬・chat", false],
        ["📸・prints-e-gols", false],
        ["🗣️・resenha", false]
    ],

    SUPORTE: [
        ["🎫・suporte", false],
        ["🚨・denúncias", false]
    ],

    STAFF: [
        ["📋・logs", false],
        ["🛡️・staff", false]
    ]
};

// =====================================================
// FILA X1
// =====================================================

const filaX1 = [];

// Partidas em andamento
const partidas = new Map();

// =====================================================
// CRIAR CATEGORIA
// =====================================================

async function criarCategoria(guild, nome, staff = false) {

    let categoria = guild.channels.cache.find(
        canal =>
            canal.type === ChannelType.GuildCategory &&
            canal.name === nome
    );

    if (categoria) return categoria;

    const permissions = [];

    if (staff) {
        permissions.push({
            id: guild.roles.everyone.id,
            deny: [
                PermissionsBitField.Flags.ViewChannel
            ]
        });
    }

    categoria = await guild.channels.create({
        name: nome,
        type: ChannelType.GuildCategory,
        permissionOverwrites: permissions
    });

    return categoria;
}

// =====================================================
// CRIAR CANAL
// =====================================================

async function criarCanal(
    guild,
    nome,
    categoria,
    somenteLeitura = false
) {

    let canal = guild.channels.cache.find(
        c =>
            c.type === ChannelType.GuildText &&
            c.name === nome
    );

    if (canal) return canal;

    const permissions = [];

    if (somenteLeitura) {

        permissions.push({
            id: guild.roles.everyone.id,

            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.ReadMessageHistory
            ],

            deny: [
                PermissionsBitField.Flags.SendMessages
            ]
        });
    }

    canal = await guild.channels.create({
        name: nome,
        type: ChannelType.GuildText,
        parent: categoria.id,
        permissionOverwrites: permissions
    });

    return canal;
}

// =====================================================
// CONFIGURAR SERVIDOR
// =====================================================

async function configurarServidor(guild) {

    console.log("⚙️ Iniciando configuração do servidor...");

    for (const [chave, nomeCategoria] of Object.entries(CATEGORIAS)) {

        const staff = chave === "STAFF";

        const categoria = await criarCategoria(
            guild,
            nomeCategoria,
            staff
        );

        const canais = CANAIS[chave] || [];

        for (const [nomeCanal, somenteLeitura] of canais) {

            await criarCanal(
                guild,
                nomeCanal,
                categoria,
                somenteLeitura
            );
        }
    }

    console.log("✅ Servidor configurado.");
}

// =====================================================
// PAINEL DA FILA
// =====================================================

function painelFila() {

    let jogadores = "Ninguém está na fila.";

    if (filaX1.length > 0) {

        jogadores = filaX1
            .map(
                (id, index) =>
                    `${index + 1}. <@${id}>`
            )
            .join("\n");
    }

    const embed = new EmbedBuilder()
        .setTitle("⚔️ FILA X1 — EFOOTBALL")
        .setDescription(
            "Entre na fila para encontrar um adversário.\n\n" +
            `👥 **Jogadores na fila:** ${filaX1.length}/2\n\n` +
            jogadores
        )
        .setColor(0x2b2d31)
        .setFooter({
            text: "eFootball X1"
        });

    const botoes = new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("entrar_fila")
                .setLabel("ENTRAR NA FILA")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId("sair_fila")
                .setLabel("SAIR DA FILA")
                .setStyle(ButtonStyle.Danger)
        );

    return {
        embeds: [embed],
        components: [botoes]
    };
}

// =====================================================
// CRIAR PARTIDA
// =====================================================

async function criarPartida(
    guild,
    jogador1,
    jogador2
) {

    const categoria = guild.channels.cache.find(
        canal =>
            canal.type === ChannelType.GuildCategory &&
            canal.name === CATEGORIAS.MATCHMAKING
    );

    const permissoes = [

        {
            id: guild.roles.everyone.id,

            deny: [
                PermissionsBitField.Flags.ViewChannel
            ]
        },

        {
            id: jogador1,

            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory
            ]
        },

        {
            id: jogador2,

            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory
            ]
        }
    ];

    const canal = await guild.channels.create({

        name:
            `x1-${jogador1.slice(-4)}-${jogador2.slice(-4)}`,

        type: ChannelType.GuildText,

        parent:
            categoria ? categoria.id : undefined,

        permissionOverwrites:
            permissoes
    });

    const embed = new EmbedBuilder()
        .setTitle("⚔️ X1 ENCONTRADO")
        .setDescription(
            `👤 **Jogador 1:** <@${jogador1}>\n` +
            `👤 **Jogador 2:** <@${jogador2}>\n\n` +

            "🎮 **Modo:** X1\n\n" +

            "A partida foi encontrada!\n\n" +

            "Realizem a partida no eFootball.\n\n" +

            "Depois adicionaremos o sistema de confirmação " +
            "e registro do resultado."
        )
        .setColor(0x2b2d31);

    await canal.send({
        content:
            `<@${jogador1}> <@${jogador2}>`,

        embeds: [embed]
    });

    partidas.set(canal.id, {
        jogador1,
        jogador2,
        criadaEm: Date.now()
    });

    return canal;
}

// =====================================================
// BOT ONLINE
// =====================================================

client.once("ready", async () => {

    console.log(
        `🤖 Bot conectado como ${client.user.tag}`
    );

    const comando = new SlashCommandBuilder()
        .setName("setup")
        .setDescription(
            "Configura a estrutura do servidor"
        );

    try {

        await client.application.commands.set([
            comando.toJSON()
        ]);

        console.log(
            "✅ Comando /setup registrado."
        );

    } catch (erro) {

        console.error(
            "❌ Erro ao registrar /setup:",
            erro
        );
    }
});

// =====================================================
// INTERAÇÕES
// =====================================================

client.on(
    "interactionCreate",
    async interaction => {

        try {

            // =============================================
            // /SETUP
            // =============================================

            if (
                interaction.isChatInputCommand() &&
                interaction.commandName === "setup"
            ) {

                await interaction.deferReply({
                    ephemeral: true
                });

                await configurarServidor(
                    interaction.guild
                );

                return interaction.editReply(
                    "✅ Estrutura do servidor configurada."
                );
            }

            // =============================================
            // BOTÕES
            // =============================================

            if (!interaction.isButton()) return;

            // =============================================
            // ENTRAR NA FILA
            // =============================================

            if (
                interaction.customId ===
                "entrar_fila"
            ) {

                const jogador =
                    interaction.user.id;

                if (filaX1.includes(jogador)) {

                    return interaction.reply({
                        content:
                            "❌ Você já está na fila.",

                        ephemeral: true
                    });
                }

                filaX1.push(jogador);

                await interaction.update(
                    painelFila()
                );

                // =========================================
                // FORMOU X1
                // =========================================

                if (filaX1.length >= 2) {

                    const jogador1 =
                        filaX1.shift();

                    const jogador2 =
                        filaX1.shift();

                    const canal =
                        await criarPartida(
                            interaction.guild,
                            jogador1,
                            jogador2
                        );

                    await interaction.channel.send(
                        `⚔️ **X1 encontrado!** <#${canal.id}>`
                    );

                    await interaction.message.edit(
                        painelFila()
                    );
                }

                return;
            }

            // =============================================
            // SAIR DA FILA
            // =============================================

            if (
                interaction.customId ===
                "sair_fila"
            ) {

                const jogador =
                    interaction.user.id;

                const index =
                    filaX1.indexOf(jogador);

                if (index === -1) {

                    return interaction.reply({
                        content:
                            "❌ Você não está na fila.",

                        ephemeral: true
                    });
                }

                filaX1.splice(index, 1);

                await interaction.update(
                    painelFila()
                );

                return;
            }

        } catch (erro) {

            console.error(
                "❌ Erro na interação:",
                erro
            );

            if (
                interaction.isRepliable() &&
                !interaction.replied &&
                !interaction.deferred
            ) {

                await interaction.reply({
                    content:
                        "❌ Ocorreu um erro no bot.",

                    ephemeral: true
                }).catch(() => {});
            }
        }
    }
);

// =====================================================
// TOKEN
// =====================================================

const TOKEN =
    process.env.DISCORD_TOKEN;

if (!TOKEN) {

    console.error(
        "❌ DISCORD_TOKEN não encontrado."
    );

    process.exit(1);
}

// =====================================================
// LOGIN
// =====================================================

client.login(TOKEN)
    .then(() => {
        console.log("🔑 Login no Discord realizado.");
    })
    .catch((erro) => {
        console.error(
            "❌ Não foi possível conectar ao Discord:",
            erro
        );

        process.exit(1);
    });