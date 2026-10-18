require('dotenv').config();
const http = require('http');
const zlib = require('zlib');
const assert = require('assert');
const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  SlashCommandBuilder,
} = require('discord.js');

/* =====================================================================
   LÓGICA PURA
===================================================================== */
const ALLOWED_VALUES = [1, 2, 3, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 5)];

const PLATFORMS = {
  mobile: { label: 'Mobile', emoji: '📱' },
  emulador: { label: 'Emulador', emoji: '🖥️' },
  unica: { label: 'Única', emoji: '⚽' },
};

const formatBRL = (v) => `R$ ${v}`;

function parseValues(input) {
  if (!input || !input.trim()) return { ok: true, values: [...ALLOWED_VALUES] };
  const parts = input.split(/[,;\s]+/).filter(Boolean);
  const nums = parts.map((p) => Number(p.replace(/^R\$/i, '')));
  const invalid = parts.filter((_, i) => !ALLOWED_VALUES.includes(nums[i]));
  if (invalid.length) return { ok: false, invalid };
  return { ok: true, values: [...new Set(nums)].sort((a, b) => a - b) };
}

const platformsFor = (separate) => (separate ? ['mobile', 'emulador'] : ['unica']);

function resolveReports(r1, r2) {
  if (!r1 || !r2) return { state: 'pending' };
  if (r1 === 'win' && r2 === 'loss') return { state: 'done', winner: 1 };
  if (r1 === 'loss' && r2 === 'win') return { state: 'done', winner: 2 };
  return { state: 'disputed' };
}

/* =====================================================================
   LOGO (PNG quadrado preto e azul gerado pelo código)
===================================================================== */
const S = 256;
const C_BLACK = [6, 10, 20];
const C_NAVY = [10, 24, 56];
const C_BLUE = [31, 111, 255];

const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const pentagon = (r) =>
  [...Array(5)].map((_, k) => {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
    return [S / 2 + r * Math.cos(a), S / 2 + r * Math.sin(a)];
  });

function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distSeg(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

let logoCache;
function logoPng() {
  if (logoCache) return logoCache;
  const inner = pentagon(34);
  const outer = pentagon(96);
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    for (let x = 0; x < S; x++) {
      let c = C_BLACK;
      const d = Math.hypot(x - S / 2, y - S / 2);
      if (d < 91) c = C_NAVY;
      if (Math.abs(d - 96) < 5) c = C_BLUE;
      if (inPoly(x, y, inner)) c = C_BLUE;
      for (let k = 0; k < 5; k++) if (distSeg(x, y, inner[k], outer[k]) < 3) c = C_BLUE;
      if (x < 8 || y < 8 || x >= S - 8 || y >= S - 8) c = C_BLUE;
      const i = y * (S * 4 + 1) + 1 + x * 4;
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  logoCache = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return logoCache;
}

/* =====================================================================
   ESTADO EM MEMÓRIA (zera quando o bot reinicia)
===================================================================== */
const OPEN = ['confirming', 'active', 'disputed'];
const queues = new Map();
const matches = new Map();
let nextQueueId = 1;
let nextMatchId = 1;

const seat = (m, uid) => (m.player1_id === uid ? 1 : m.player2_id === uid ? 2 : 0);
const getMatch = (id, guildId) => {
  const m = matches.get(id);
  return m && m.guild_id === guildId ? m : null;
};
const release = (m) => {
  const q = queues.get(m.queue_id);
  if (q) q.players = [];
};
const finish = (m, winnerId) => {
  m.status = 'finished';
  m.winner_id = winnerId;
  release(m);
  return m;
};

const svc = {};

svc.reset = () => {
  queues.clear();
  matches.clear();
  nextQueueId = 1;
  nextMatchId = 1;
};

svc.createQueue = (guildId, channelId, platform, value) => {
  const q = { id: nextQueueId++, guild_id: guildId, channel_id: channelId, message_id: null, platform, value, players: [] };
  queues.set(q.id, q);
  return q;
};
svc.setQueueMessage = (id, messageId) => {
  const q = queues.get(id);
  if (q) q.message_id = messageId;
};
svc.getQueue = (id) => queues.get(id) || null;
svc.listQueues = (guildId) => [...queues.values()].filter((q) => q.guild_id === guildId);
svc.deleteQueues = (guildId) => svc.listQueues(guildId).forEach((q) => queues.delete(q.id));
svc.getPlayers = (id) => [...(queues.get(id)?.players || [])];
svc.openMatchCount = (guildId) =>
  [...matches.values()].filter((m) => m.guild_id === guildId && OPEN.includes(m.status)).length;
svc.setMatchMessage = (id, messageId) => {
  const m = matches.get(id);
  if (m) m.message_id = messageId;
};

svc.join = (queueId, guildId, userId) => {
  const q = queues.get(queueId);
  if (!q || q.guild_id !== guildId) return { ok: false, reason: 'not_found' };
  const cur = svc.listQueues(guildId).find((x) => x.players.includes(userId));
  if (cur) return { ok: false, reason: cur.id === q.id ? 'already_here' : 'in_queue' };
  if (q.players.length >= 2) return { ok: false, reason: 'full' };
  q.players.push(userId);
  let match = null;
  if (q.players.length === 2) {
    match = {
      id: nextMatchId++,
      guild_id: guildId,
      queue_id: q.id,
      channel_id: q.channel_id,
      message_id: null,
      platform: q.platform,
      value: q.value,
      player1_id: q.players[0],
      player2_id: q.players[1],
      p1_confirmed: false,
      p2_confirmed: false,
      p1_report: null,
      p2_report: null,
      status: 'confirming',
      winner_id: null,
    };
    matches.set(match.id, match);
  }
  return { ok: true, queue: q, match };
};

svc.leave = (queueId, guildId, userId) => {
  const q = queues.get(queueId);
  if (!q || q.guild_id !== guildId) return { ok: false, reason: 'not_found' };
  if (!q.players.includes(userId)) return { ok: false, reason: 'not_in_queue' };
  if (q.players.length >= 2) return { ok: false, reason: 'in_match' };
  q.players = q.players.filter((p) => p !== userId);
  return { ok: true };
};

svc.confirm = (id, guildId, userId) => {
  const m = getMatch(id, guildId);
  if (!m) return { ok: false, reason: 'not_found' };
  const s = seat(m, userId);
  if (!s) return { ok: false, reason: 'not_player' };
  if (m.status !== 'confirming') return { ok: false, reason: 'bad_state' };
  if (s === 1) m.p1_confirmed = true;
  else m.p2_confirmed = true;
  if (m.p1_confirmed && m.p2_confirmed) m.status = 'active';
  return { ok: true, match: m };
};

svc.cancelByPlayer = (id, guildId, userId) => {
  const m = getMatch(id, guildId);
  if (!m) return { ok: false, reason: 'not_found' };
  if (!seat(m, userId)) return { ok: false, reason: 'not_player' };
  if (m.status !== 'confirming') return { ok: false, reason: 'bad_state' };
  m.status = 'cancelled';
  release(m);
  return { ok: true, match: m };
};

svc.cancelByAdmin = (id, guildId) => {
  const m = getMatch(id, guildId);
  if (!m) return { ok: false, reason: 'not_found' };
  if (!OPEN.includes(m.status)) return { ok: false, reason: 'bad_state' };
  m.status = 'cancelled';
  release(m);
  return { ok: true, match: m };
};

svc.report = (id, guildId, userId, result) => {
  const m = getMatch(id, guildId);
  if (!m) return { ok: false, reason: 'not_found' };
  const s = seat(m, userId);
  if (!s) return { ok: false, reason: 'not_player' };
  if (m.status !== 'active') return { ok: false, reason: 'bad_state' };
  if (s === 1) m.p1_report = result;
  else m.p2_report = result;
  const r = resolveReports(m.p1_report, m.p2_report);
  if (r.state === 'done') finish(m, r.winner === 1 ? m.player1_id : m.player2_id);
  else if (r.state === 'disputed') m.status = 'disputed';
  return { ok: true, match: m };
};

svc.resolve = (id, guildId, winnerId) => {
  const m = getMatch(id, guildId);
  if (!m) return { ok: false, reason: 'not_found' };
  if (!['active', 'disputed'].includes(m.status)) return { ok: false, reason: 'bad_state' };
  if (!seat(m, winnerId)) return { ok: false, reason: 'not_player' };
  return { ok: true, match: finish(m, winnerId) };
};

svc.ranking = (guildId, limit) => {
  const t = new Map();
  const get = (uid) => {
    if (!t.has(uid)) t.set(uid, { uid, wins: 0, losses: 0 });
    return t.get(uid);
  };
  for (const m of matches.values()) {
    if (m.guild_id !== guildId || m.status !== 'finished' || !m.winner_id) continue;
    get(m.winner_id).wins++;
    get(m.winner_id === m.player1_id ? m.player2_id : m.player1_id).losses++;
  }
  return [...t.values()]
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.uid.localeCompare(b.uid))
    .slice(0, limit);
};

svc.history = (guildId, userId) =>
  [...matches.values()]
    .filter(
      (m) =>
        m.guild_id === guildId &&
        (m.player1_id === userId || m.player2_id === userId) &&
        ['finished', 'cancelled'].includes(m.status),
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, 10);

/* =====================================================================
   VISUAL (embeds e botões)
===================================================================== */
const BLUE = 0x1f6fff;
const logoFile = () => new AttachmentBuilder(logoPng(), { name: 'logo.png' });

const STATUS = {
  confirming: '⏳ Aguardando confirmação dos jogadores',
  active: '🎮 Em andamento — reportem o resultado',
  disputed: '⚠️ Resultados divergentes — aguardando um administrador',
  finished: '🏁 Finalizada',
  cancelled: '❌ Cancelada',
};

function baseFields(item) {
  const f = [
    { name: 'Formato', value: 'X1', inline: true },
    { name: 'Valor', value: formatBRL(item.value), inline: true },
  ];
  if (item.platform !== 'unica') {
    const p = PLATFORMS[item.platform];
    f.push({ name: 'Plataforma', value: `${p.emoji} ${p.label}`, inline: true });
  }
  return f;
}

function queueView(queue, players) {
  const full = players.length >= 2;
  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle('Filas eFootball')
    .setThumbnail('attachment://logo.png')
    .addFields(
      ...baseFields(queue),
      { name: 'Jogadores', value: players.length ? players.map((id) => `<@${id}>`).join('\n') : '—' },
      { name: 'Status', value: full ? '🟢 Partida completa' : `🟡 Aguardando jogador (${players.length}/2)` },
    )
    .setFooter({ text: 'eFootball • X1' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:join:${queue.id}`)
      .setLabel('Entrar na fila')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(full),
    new ButtonBuilder()
      .setCustomId(`q:leave:${queue.id}`)
      .setLabel('Sair da fila')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(full),
  );
  return { embeds: [embed], components: [row], files: [logoFile()] };
}

function matchView(m) {
  const mark = (ok) => (m.status === 'confirming' ? (ok ? ' ✅' : ' ⏳') : '');
  const fields = [
    ...baseFields(m),
    { name: 'Jogadores', value: `<@${m.player1_id}>${mark(m.p1_confirmed)}\n<@${m.player2_id}>${mark(m.p2_confirmed)}` },
    { name: 'Status', value: STATUS[m.status] },
  ];
  if (m.winner_id) fields.push({ name: 'Vencedor', value: `🏆 <@${m.winner_id}>` });

  const embed = new EmbedBuilder()
    .setColor(BLUE)
    .setTitle(`Partida #${m.id} • X1`)
    .setThumbnail('attachment://logo.png')
    .addFields(fields)
    .setFooter({ text: 'eFootball • X1' });

  const btn = (id, label, style) =>
    new ButtonBuilder().setCustomId(`m:${id}:${m.id}`).setLabel(label).setStyle(style);

  let components = [];
  if (m.status === 'confirming') {
    components = [
      new ActionRowBuilder().addComponents(
        btn('confirm', 'Confirmar', ButtonStyle.Primary),
        btn('cancel', 'Cancelar', ButtonStyle.Secondary),
      ),
    ];
  } else if (m.status === 'active') {
    components = [
      new ActionRowBuilder().addComponents(
        btn('win', 'Venci', ButtonStyle.Primary),
        btn('loss', 'Perdi', ButtonStyle.Secondary),
      ),
    ];
  }
  return { embeds: [embed], components, files: [logoFile()] };
}

/* =====================================================================
   COMANDOS SLASH
===================================================================== */
const commandDefs = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Gerencia o painel de filas (admin)')
    .addSubcommand((s) =>
      s
        .setName('publicar')
        .setDescription('Publica as filas neste canal')
        .addStringOption((o) => o.setName('valores').setDescription('Ex: 1,2,5,10 (vazio = todos)'))
        .addBooleanOption((o) =>
          o.setName('separar_plataformas').setDescription('Separar Mobile e Emulador (padrão: sim)'),
        ),
    )
    .addSubcommand((s) => s.setName('atualizar').setDescription('Reatualiza os embeds das filas'))
    .addSubcommand((s) => s.setName('remover').setDescription('Remove o painel de filas')),

  new SlashCommandBuilder()
    .setName('ranking')
    .setDescription('Ranking de vitórias')
    .addIntegerOption((o) =>
      o.setName('limite').setDescription('Quantidade (1-25)').setMinValue(1).setMaxValue(25),
    ),

  new SlashCommandBuilder()
    .setName('historico')
    .setDescription('Histórico das últimas partidas')
    .addUserOption((o) => o.setName('jogador').setDescription('Jogador (padrão: você)')),

  new SlashCommandBuilder()
    .setName('partida')
    .setDescription('Ações de administrador em partidas')
    .addSubcommand((s) =>
      s
        .setName('resolver')
        .setDescription('Define o vencedor de uma partida')
        .addIntegerOption((o) => o.setName('id').setDescription('ID da partida').setRequired(true))
        .addUserOption((o) => o.setName('vencedor').setDescription('Vencedor').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('cancelar')
        .setDescription('Cancela uma partida')
        .addIntegerOption((o) => o.setName('id').setDescription('ID da partida').setRequired(true)),
    ),
].map((c) => c.toJSON());

/* =====================================================================
   HANDLERS
===================================================================== */
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const NO_PING = { parse: [] };
const NOT_ADMIN = 'Apenas administradores (permissão Gerenciar Servidor) podem usar este comando.';

const REASONS = {
  not_found: 'Esta fila/partida não existe mais. Peça a um admin para rodar /painel publicar.',
  in_queue: 'Você já está em outra fila. Saia dela antes de entrar nesta.',
  already_here: 'Você já está nesta fila.',
  full: 'Esta fila já está com a partida completa.',
  not_in_queue: 'Você não está nesta fila.',
  in_match: 'Sua partida já foi formada. Use os botões da partida.',
  not_player: 'Você não participa desta partida.',
  bad_state: 'Esta ação não está mais disponível para esta partida.',
};
const why = (r) => REASONS[r.reason] || 'Não foi possível concluir a ação.';
const isAdmin = (i) => Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

async function editMessage(client, channelId, messageId, payload) {
  if (!channelId || !messageId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.edit(payload);
  } catch (e) {
    console.warn('Falha ao editar mensagem', messageId, e.code || e.message);
  }
}

async function refreshQueue(client, queueId) {
  const q = svc.getQueue(queueId);
  if (!q) return;
  await editMessage(client, q.channel_id, q.message_id, queueView(q, svc.getPlayers(q.id)));
}

const refreshMatch = (client, m) => editMessage(client, m.channel_id, m.message_id, matchView(m));

async function afterMatchChange(client, m) {
  await refreshMatch(client, m);
  if (['finished', 'cancelled'].includes(m.status)) await refreshQueue(client, m.queue_id);
}

async function openMatch(client, m) {
  const ch = await client.channels.fetch(m.channel_id);
  const msg = await ch.send({
    content: `<@${m.player1_id}> <@${m.player2_id}> — partida formada! Confirmem abaixo.`,
    ...matchView(m),
    allowedMentions: { users: [m.player1_id, m.player2_id] },
  });
  svc.setMatchMessage(m.id, msg.id);
}

async function removePanel(client, guildId) {
  const list = svc.listQueues(guildId);
  for (const q of list) {
    try {
      const ch = await client.channels.fetch(q.channel_id);
      const msg = await ch.messages.fetch(q.message_id);
      await msg.delete();
    } catch {
      /* mensagem já removida */
    }
  }
  svc.deleteQueues(guildId);
  return list.length;
}

async function handleButton(i, client) {
  const [scope, action, idStr] = i.customId.split(':');
  const id = Number(idStr);
  if (!['q', 'm'].includes(scope) || !Number.isInteger(id) || !i.inGuild()) return;

  await i.deferUpdate();
  const say = (t) => i.followUp(eph(t));

  if (scope === 'q') {
    if (action === 'join') {
      const r = svc.join(id, i.guildId, i.user.id);
      if (!r.ok) return say(why(r));
      await refreshQueue(client, id);
      if (r.match) await openMatch(client, r.match);
      return;
    }
    if (action === 'leave') {
      const r = svc.leave(id, i.guildId, i.user.id);
      if (!r.ok) return say(why(r));
      return refreshQueue(client, id);
    }
    return;
  }

  const actions = {
    confirm: () => svc.confirm(id, i.guildId, i.user.id),
    cancel: () => svc.cancelByPlayer(id, i.guildId, i.user.id),
    win: () => svc.report(id, i.guildId, i.user.id, 'win'),
    loss: () => svc.report(id, i.guildId, i.user.id, 'loss'),
  };
  if (!actions[action]) return;
  const r = actions[action]();
  if (!r.ok) return say(why(r));
  await afterMatchChange(client, r.match);
  if ((action === 'win' || action === 'loss') && r.match.status === 'active') {
    await say('✅ Resultado registrado. Aguardando o adversário reportar.');
  }
}

async function cmdPainel(i, client) {
  if (!isAdmin(i)) return i.reply(eph(NOT_ADMIN));
  const sub = i.options.getSubcommand();

  if (sub === 'publicar') {
    const parsed = parseValues(i.options.getString('valores'));
    if (!parsed.ok) {
      return i.reply(
        eph(`Valores inválidos: ${parsed.invalid.join(', ')}.\nPermitidos: ${ALLOWED_VALUES.join(', ')}`),
      );
    }
    const perms = i.channel?.permissionsFor(i.guild.members.me);
    const need = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ];
    if (!perms?.has(need)) {
      return i.reply(eph('Preciso das permissões Ver Canal, Enviar Mensagens, Inserir Links e