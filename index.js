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
const { Pool } = require('pg');

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
   BANCO DE DADOS (PostgreSQL)
===================================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
});
pool.on('error', (e) => console.error('Erro no pool PG:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('mobile','emulador','unica')),
  value INTEGER NOT NULL CHECK (value > 0 AND value <= 100),
  UNIQUE (guild_id, platform, value)
);
CREATE TABLE IF NOT EXISTS queue_players (
  queue_id INTEGER NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  queue_id INTEGER REFERENCES queues(id) ON DELETE SET NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  platform TEXT NOT NULL,
  value INTEGER NOT NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  p1_confirmed BOOLEAN NOT NULL DEFAULT false,
  p2_confirmed BOOLEAN NOT NULL DEFAULT false,
  p1_report TEXT,
  p2_report TEXT,
  status TEXT NOT NULL DEFAULT 'confirming'
    CHECK (status IN ('confirming','active','disputed','finished','cancelled')),
  winner_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_matches_guild_status ON matches (guild_id, status);
`;

const migrate = () => pool.query(SCHEMA);

const OPEN = ['confirming', 'active', 'disputed'];

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const seat = (m, uid) => (m.player1_id === uid ? 1 : m.player2_id === uid ? 2 : 0);
const lockMatch = async (c, id, guildId) =>
  (await c.query('SELECT * FROM matches WHERE id=$1 AND guild_id=$2 FOR UPDATE', [id, guildId])).rows[0];
const release = (c, m) =>
  m.queue_id ? c.query('DELETE FROM queue_players WHERE queue_id=$1', [m.queue_id]) : null;

async function finish(c, id, winnerId) {
  const m = (
    await c.query(
      `UPDATE matches SET status='finished', winner_id=$2, finished_at=now() WHERE id=$1 RETURNING *`,
      [id, winnerId],
    )
  ).rows[0];
  await release(c, m);
  return m;
}

const svc = {};

svc.createQueue = async (guildId, channelId, platform, value) =>
  (
    await pool.query(
      'INSERT INTO queues (guild_id, channel_id, platform, value) VALUES ($1,$2,$3,$4) RETURNING *',
      [guildId, channelId, platform, value],
    )
  ).rows[0];

svc.setQueueMessage = (id, messageId) =>
  pool.query('UPDATE queues SET message_id=$2 WHERE id=$1', [id, messageId]);

svc.getQueue = async (id) => (await pool.query('SELECT * FROM queues WHERE id=$1', [id])).rows[0] || null;

svc.listQueues = async (guildId) =>
  (await pool.query('SELECT * FROM queues WHERE guild_id=$1 ORDER BY id', [guildId])).rows;

svc.deleteQueues = (guildId) => pool.query('DELETE FROM queues WHERE guild_id=$1', [guildId]);

svc.getPlayers = async (queueId) =>
  (
    await pool.query('SELECT user_id FROM queue_players WHERE queue_id=$1 ORDER BY joined_at, user_id', [
      queueId,
    ])
  ).rows.map((r) => r.user_id);

svc.openMatchCount = async (guildId) =>
  (
    await pool.query('SELECT count(*)::int AS c FROM matches WHERE guild_id=$1 AND status = ANY($2)', [
      guildId,
      OPEN,
    ])
  ).rows[0].c;

svc.join = async (queueId, guildId, userId) => {
  try {
    return await tx(async (c) => {
      const q = (await c.query('SELECT * FROM queues WHERE id=$1 FOR UPDATE', [queueId])).rows[0];
      if (!q || q.guild_id !== guildId) return { ok: false, reason: 'not_found' };

      const cur = (
        await c.query('SELECT queue_id FROM queue_players WHERE guild_id=$1 AND user_id=$2', [guildId, userId])
      ).rows[0];
      if (cur) return { ok: false, reason: cur.queue_id === q.id ? 'already_here' : 'in_queue' };

      const count = Number(
        (await c.query('SELECT count(*) FROM queue_players WHERE queue_id=$1', [q.id])).rows[0].count,
      );
      if (count >= 2) return { ok: false, reason: 'full' };

      await c.query('INSERT INTO queue_players (queue_id, guild_id, user_id) VALUES ($1,$2,$3)', [
        q.id,
        guildId,
        userId,
      ]);

      let match = null;
      if (count + 1 === 2) {
        const [p1, p2] = (
          await c.query('SELECT user_id FROM queue_players WHERE queue_id=$1 ORDER BY joined_at, user_id', [q.id])
        ).rows.map((r) => r.user_id);
        match = (
          await c.query(
            `INSERT INTO matches (guild_id, queue_id, channel_id, platform, value, player1_id, player2_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [guildId, q.id, q.channel_id, q.platform, q.value, p1, p2],
          )
        ).rows[0];
      }
      return { ok: true, queue: q, match };
    });
  } catch (e) {
    if (e.code === '23505') return { ok: false, reason: 'in_queue' };
    throw e;
  }
};

svc.leave = (queueId, guildId, userId) =>
  tx(async (c) => {
    const q = (await c.query('SELECT * FROM queues WHERE id=$1 FOR UPDATE', [queueId])).rows[0];
    if (!q || q.guild_id !== guildId) return { ok: false, reason: 'not_found' };
    const mine = (
      await c.query('SELECT 1 FROM queue_players WHERE queue_id=$1 AND user_id=$2', [q.id, userId])
    ).rows[0];
    if (!mine) return { ok: false, reason: 'not_in_queue' };
    const count = Number(
      (await c.query('SELECT count(*) FROM queue_players WHERE queue_id=$1', [q.id])).rows[0].count,
    );
    if (count >= 2) return { ok: false, reason: 'in_match' };
    await c.query('DELETE FROM queue_players WHERE queue_id=$1 AND user_id=$2', [q.id, userId]);
    return { ok: true };
  });

svc.setMatchMessage = (id, messageId) =>
  pool.query('UPDATE matches SET message_id=$2 WHERE id=$1', [id, messageId]);

svc.confirm = (id, guildId, userId) =>
  tx(async (c) => {
    const m = await lockMatch(c, id, guildId);
    if (!m) return { ok: false, reason: 'not_found' };
    const s = seat(m, userId);
    if (!s) return { ok: false, reason: 'not_player' };
    if (m.status !== 'confirming') return { ok: false, reason: 'bad_state' };
    const col = s === 1 ? 'p1_confirmed' : 'p2_confirmed';
    let row = (await c.query(`UPDATE matches SET ${col}=true WHERE id=$1 RETURNING *`, [id])).rows[0];
    if (row.p1_confirmed && row.p2_confirmed) {
      row = (await c.query(`UPDATE matches SET status='active' WHERE id=$1 RETURNING *`, [id])).rows[0];
    }
    return { ok: true, match: row };
  });

svc.cancelByPlayer = (id, guildId, userId) =>
  tx(async (c) => {
    const m = await lockMatch(c, id, guildId);
    if (!m) return { ok: false, reason: 'not_found' };
    if (!seat(m, userId)) return { ok: false, reason: 'not_player' };
    if (m.status !== 'confirming') return { ok: false, reason: 'bad_state' };
    const row = (
      await c.query(`UPDATE matches SET status='cancelled', finished_at=now() WHERE id=$1 RETURNING *`, [id])
    ).rows[0];
    await release(c, row);
    return { ok: true, match: row };
  });

svc.cancelByAdmin = (id, guildId) =>
  tx(async (c) => {
    const m = await lockMatch(c, id, guildId);
    if (!m) return { ok: false, reason: 'not_found' };
    if (!OPEN.includes(m.status)) return { ok: false, reason: 'bad_state' };
    const row = (
      await c.query(`UPDATE matches SET status='cancelled', finished_at=now() WHERE id=$1 RETURNING *`, [id])
    ).rows[0];
    await release(c, row);
    return { ok: true, match: row };
  });

svc.report = (id, guildId, userId, result) =>
  tx(async (c) => {
    const m = await lockMatch(c, id, guildId);
    if (!m) return { ok: false, reason: 'not_found' };
    const s = seat(m, userId);
    if (!s) return { ok: false, reason: 'not_player' };
    if (m.status !== 'active') return { ok: false, reason: 'bad_state' };
    const col = s === 1 ? 'p1_report' : 'p2_report';
    let row = (await c.query(`UPDATE matches SET ${col}=$2 WHERE id=$1 RETURNING *`, [id, result])).rows[0];
    const r = resolveReports(row.p1_report, row.p2_report);
    if (r.state === 'done') {
      row = await finish(c, id, r.winner === 1 ? row.player1_id : row.player2_id);
    } else if (r.state === 'disputed') {
      row = (await c.query(`UPDATE matches SET status='disputed' WHERE id=$1 RETURNING *`, [id])).rows[0];
    }
    return { ok: true, match: row };
  });

svc.resolve = (id, guildId, winnerId) =>
  tx(async (c) => {
    const m = await lockMatch(c, id, guildId);
    if (!m) return { ok: false, reason: 'not_found' };
    if (!['active', 'disputed'].includes(m.status)) return { ok: false, reason: 'bad_state' };
    if (!seat(m, winnerId)) return { ok: false, reason: 'not_player' };
    return { ok: true, match: await finish(c, id, winnerId) };
  });

svc.ranking = async (guildId, limit) =>
  (
    await pool.query(
      `SELECT uid, SUM(w)::int AS wins, SUM(l)::int AS losses FROM (
         SELECT winner_id AS uid, 1 AS w, 0 AS l FROM matches
           WHERE guild_id=$1 AND status='finished' AND winner_id IS NOT NULL
         UNION ALL
         SELECT CASE WHEN winner_id=player1_id THEN player2_id ELSE player1_id END, 0, 1 FROM matches
           WHERE guild_id=$1 AND status='finished' AND winner_id IS NOT NULL
       ) t GROUP BY uid ORDER BY wins DESC, losses ASC, uid LIMIT $2`,
      [guildId, limit],
    )
  ).rows;

svc.history = async (guildId, userId) =>
  (
    await pool.query(
      `SELECT * FROM matches
       WHERE guild_id=$1 AND (player1_id=$2 OR player2_id=$2) AND status IN ('finished','cancelled')
       ORDER BY id DESC LIMIT 10`,
      [guildId, userId],
    )
  ).rows;

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
  not_found: 'Esta fila/partida não existe mais.',
  in_queue: 'Você já está em o