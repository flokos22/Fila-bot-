const http = require("http");

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("eFootball X1 Bot online!");
}).listen(PORT, () => {
    console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

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
    intents: [GatewayIntentBits.Guilds]
});

// =====================================================
// CONFIGURAÇÃO
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
// FILA
// =====================================================

const filaX1 = [];
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

    const permissionOverwrites = [];

    if (staff) {
        permissionOverwrites.push({
            id: guild.roles.everyone.id,
            deny: [
                PermissionsBitField.Flags.ViewChannel
            ]
        });
    }

    return await guild.channels.create({
        name: nome,
        type: ChannelType.GuildCategory,
        permissionOverwrites
    });
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

    const permissionOverwrites = [];

    if (somenteLeitura) {
        permissionOverwrites.push({
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

    return await guild.channels.create({
        name: nome,
        type: ChannelType.GuildText,
        parent: categoria.id,
        permissionOverwrites
    });
}

// =====================================================
// CONFIGURAR SERVIDOR
// =====================================================

async function configurarServidor(guild) {

    for (const [chave, nomeCategoria] of Object.entries(CATEGORIAS)) {

        const categoria = await criarCategoria(
            guild,
            nomeCategoria,
            chave === "STAFF"
        );

        for (const [nomeCanal, somenteLeitura] of CANAIS[chave]) {

            await criarCanal(
                guild,
                nomeCanal,
                categoria,
                somenteLeitura
            );
        }
    }

    console.log("✅ Estrutura do servidor configurada.");
}

// =====================================================
// PAINEL DA FILA
// =====================================================

function criarPainelFila() {

    let jogadores = "Ninguém está aguardando.";

    if (filaX1.length > 0) {

        jogadores = filaX1
            .map(
                (id, index) =>
                    `**${index + 1}.** <@${id}>`
            )
            .join("\n");
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("⚔️ EFOOTBALL • FILA X1")
        .setDescription(
            "Entre na fila e aguarde um adversário.\n" +
            "Quando dois jogadores entrarem, uma sala privada será criada automaticamente.\n\n" +

            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +

            "👥 **JOGADORES NA FILA**\n" +
            `${jogadores}\n\n` +

            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +

            "🎮 **Modo:** X1\n" +
            "⚡ **Jogadores necessários:** 2\n" +
            "🔒 **Sala:** Privada"
        )
        .setFooter({
            text: "eFootball X1 • Matchmaking automático"
        })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId("entrar_fila")
                .setLabel("ENTRAR NA FILA")
                .setEmoji("⚔️")
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId("sair_fila")
                .setLabel("SAIR DA FILA")
                .setEmoji("🚪")
                .setStyle(ButtonStyle.Danger)
        );

    return {
        embeds: [embed],
        components: [row]
    };
}

// =====================================================
// CRIAR PARTIDA
// =====================================================

async function criarPartida(guild, jogador1, jogador2) {

    const categoria = guild.channels.cache.find(
        canal =>
            canal.type === ChannelType.GuildCategory &&
            canal.name === CATEGORIAS.MATCHMAKING
    );

    const permissionOverwrites = [

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

        name: `x1-${jogador1.slice(-4)}-${jogador2.slice(-4)}`,

        type: ChannelType.GuildText,

        parent: categoria?.id,

        permissionOverwrites
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("⚔️ X1 ENCONTRADO!")
        .setDescription(
            "O matchmaking encontrou dois jogadores.\n\n" +

            `👤 **Jogador 1:** <@${jogador1}>\n` +
            `👤 **Jogador 2:** <@${jogador2}>\n\n` +

            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +

            "🎮 **Modo:** X1\n" +
            "🔒 **Sala:** Privada\n\n" +

            "Entrem na partida e realizem o confronto no eFootball.\n\n" +

            "📌 **Boa partida!**"
        )
        .setFooter({
            text: "eFootball X1"
        })
        .setTimestamp();

    await canal.send({
        content: `<@${jogador1}> <@${jogador2}>`,
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

    console.log(`🤖 Bot conectado como ${client.user.tag}`);

    const comandos = [

        new SlashCommandBuilder()
            .setName("setup")
            .setDescription("Configura a estrutura do servidor"),

        new SlashCommandBuilder()
            .setName("painel")
            .setDescription("Envia o painel da fila X1")
    ];

    try {

        // Registra os comandos
        await client.application.commands.set(
            comandos.map(comando => comando.toJSON())
        );

        console.log("✅ /setup e /painel registrados.");

        console.log(
            `🌐 Bot está em ${client.guilds.cache.size} servidor(es).`
        );

    } catch (erro) {

        console.error(
            "❌ Erro ao registrar comandos:",
            erro
        );
    }
});

// =====================================================
// INTERAÇÕES
// =====================================================

client.on("interactionCreate", async interaction => {

    try {

        // =================================================
        // /SETUP
        // =================================================

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

            return await interaction.editReply(
                "✅ Estrutura do servidor configurada."
            );
        }

        // =================================================
        // /PAINEL
        // =================================================

        if (
            interaction.isChatInputCommand() &&
            interaction.commandName === "painel"
        ) {

            if (
                interaction.channel.name !==
                "⚔️・fila-x1"
            ) {

                return await interaction.reply({
                    content:
                        "❌ Use o comando `/painel` dentro do canal `⚔️・fila-x1`.",
                    ephemeral: true
                });
            }

            await interaction.channel.send(
                criarPainelFila()
            );

            return await interaction.reply({
                content:
                    "✅ Painel da fila X1 enviado.",
                ephemeral: true
            });
        }

        // =================================================
        // BOTÕES
        // =================================================

        if (!interaction.isButton()) return;

        // =================================================
        // ENTRAR NA FILA
        // =================================================

        if (interaction.customId === "entrar_fila") {

            const jogador = interaction.user.id;

            if (filaX1.includes(jogador)) {

                return await interaction.reply({
                    content:
                        "❌ Você já está na fila.",
                    ephemeral: true
                });
            }

            filaX1.push(jogador);

            await interaction.update(
                criarPainelFila()
            );

            // =================================================
            // FORMAR X1
            // =================================================

            if (filaX1.length >= 2) {

                const jogador1 = filaX1.shift();
                const jogador2 = filaX1.shift();

                const canal = await criarPartida(
                    interaction.guild,
                    jogador1,
                    jogador2
                );

                await interaction.channel.send(
                    `⚔️ **X1 encontrado!** <#${canal.id}>`
                );

                await interaction.message.edit(
                    criarPainelFila()
                );
            }

            return;
        }

        // =================================================
        // SAIR DA FILA
        // =================================================

        if (interaction.customId === "sair_fila") {

            const jogador = interaction.user.id;

            const index = filaX1.indexOf(jogador);

            if (index === -1) {

                return await interaction.reply({
                    content:
                        "❌ Você não está na fila.",
                    ephemeral: true
                });
            }

            filaX1.splice(index, 1);

            await interaction.update(
                criarPainelFila()
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
});

// =====================================================
// LOGIN
// =====================================================

const TOKEN = process.env.DISCORD_TOKEN;

if (!TOKEN) {

    console.error(
        "❌ DISCORD_TOKEN não encontrado."
    );

    process.exit(1);
}

client.login(TOKEN)
    .then(() => {

        console.log(
            "🔑 Login no Discord realizado."
        );

    })
    .catch(erro => {

        console.error(
            "❌ Erro ao conectar ao Discord:",
            erro
        );

        process.exit(1);
    });