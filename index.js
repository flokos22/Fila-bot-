require('dotenv').config();
const http = require('http');
const zlib = require('zlib');
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, SlashCommandBuilder } = require('discord.js');

const VALUES = [1, 2, 3, ...Array.from({ length: 20 }, (_, i) => (i + 1) * 5)];
const PLAT = { mobile: '📱 Mobile', emulador: '🖥️ Emulador' };
const BLUE = 0x1f6fff;
const OPEN = ['confirming', 'active', 'disputed'];
const P = ButtonStyle.Primary;
const G = ButtonStyle.Secondary;

function parseValues(s) {
  if (!s || !s.trim()) return { ok: true, values: [...VALUES] };
  const parts = s.split(/[,;\s]+/).filter(Boolean);
  const nums = parts.map((p) => Number(p.replace(/^R\$/i, '')));
  const invalid = parts.filter((_, i) => !VALUES.includes(nums[i]));
  return invalid.length ? { ok: false, invalid } : { ok: true, values: [...new Set(nums)].sort((a, b) => a - b) };
}

/* ---------- logo PNG preto e azul gerado pelo código ---------- */
let logo;
function logoPng() {
  if (logo) return logo;
  const S = 256;
  const K = [[6, 10, 20], [10, 24, 56], [31, 111, 255]];
  const pent = (r) => [0, 1, 2, 3, 4].map((k) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5; return [128 + r * Math.cos(a), 128 + r * Math.sin(a)]; });
  const A = pent(34);
  const B = pent(96);
  const inPoly = (x, y) => { let o = false; for (let i = 0, j = 4; i < 5; j = i++) { const [xi, yi] = A[i]; const [xj, yj] = A[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) o = !o; } return o; };
  const seg = (x, y, [ax, ay], [bx, by]) => { const dx = bx - ax; const dy = by - ay; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - 128, y - 128);
    let c = K[0];
    if (d < 91) c = K[1];
    if (Math.abs(d - 96) < 5 || inPoly(x, y) || x < 8 || y < 8 || x >= 248 || y >= 248 || A.some((p, k) => seg(x, y, p, B[k]) < 3)) c = K[2];
    const i = y * (S * 4 + 1) + 1 + x * 4;
    raw[i] = c[0]; raw[i + 1] = c[1]; raw[i + 2] = c[2]; raw[i + 3] = 255;
  }
  const T = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const b of td) c = T[(c ^ b) & 255] ^ (c >>> 8);
    const h = Buffer.alloc(4);
    const e = Buffer.alloc(4);
    h.writeUInt32BE(data.length);
    e.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([h, td, e]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  logo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return logo;
}

/* ---------- estado em memória (zera ao reiniciar) ---------- */
const queues = new Map();
const matches = new Map();
let qSeq = 1;
let mSeq = 1;
const seat = (m, u) => (m.p1 === u ? 1 : m.p2 === u ? 2 : 0);
const qList = (g) => [...queues.values()].filter((q) => q.guild === g);
const mGet = (id, g) => { const m = matches.get(id); return m && m.guild === g ? m : null; };
const openCount = (g) => [...matches.values()].filter((m) => m.guild === g && OPEN.includes(m.status)).length;
const end = (m, status, winner = null) => { m.status = status; m.winner = winner; const q = queues.get(m.queue); if (q) q.players = []; return m; };

function newQueue(guild, channel, platform, value) {
  const q = { id: qSeq++, guild, channel, msg: null, platform, value, players: [] };
  queues.set(q.id, q);
  return q;
}

function join(id, g, u) {
  const q = queues.get(id);
  if (!q || q.guild !== g) return { err: 'nf' };
  const cur = qList(g).find((x) => x.players.includes(u));
  if (cur) return { err: cur.id === q.id ? 'here' : 'busy' };
  if (q.players.length >= 2) return { err: 'full' };
  q.players.push(u);
  if (q.players.length < 2) return {};
  const m = { id: mSeq++, guild: g, queue: q.id, channel: q.channel, msg: null, platform: q.platform, value: q.value, p1: q.players[0], p2: q.players[1], c1: false, c2: false, r1: null, r2: null, status: 'confirming', winner: null };
  matches.set(m.id, m);
  return { match: m };
}

function leave(id, g, u) {
  const q = queues.get(id);
  if (!q || q.guild !== g) return { err: 'nf' };
  if (!q.players.includes(u)) return { err: 'notin' };
  if (q.players.length >= 2) return { err: 'inmatch' };
  q.players = q.players.filter((p) => p !== u);
  return {};
}

function confirm(id, g, u) {
  const m = mGet(id, g);
  if (!m) return { err: 'nf' };
  const s = seat(m, u);
  if (!s) return { err: 'notplayer' };
  if (m.status !== 'confirming') return { err: 'state' };
  m['c' + s] = true;
  if (m.c1 && m.c2) m.status = 'active';
  return { match: m };
}

function cancel(id, g, u, admin) {
  const m = mGet(id, g);
  if (!m) return { err: 'nf' };
  if (!admin && !seat(m, u)) return { err: 'notplayer' };
  if (!admin && m.status !== 'confirming') return { err: 'state' };
  if (!OPEN.includes(m.status)) return { err: 'state' };
  return { match: end(m, 'cancelled') };
}

function report(id, g, u, res) {
  const m = mGet(id, g);
  if (!m) return { err: 'nf' };
  const s = seat(m, u);
  if (!s) return { err: 'notplayer' };
  if (m.status !== 'active') return { err: 'state' };
  m['r' + s] = res;
  if (m.r1 && m.r2) {
    if (m.r1 !== m.r2) end(m, 'finished', m.r1 === 'win' ? m.p1 : m.p2);
    else m.status = 'disputed';
  }
  return { match: m };
}

function resolve(id, g, w) {
  const m = mGet(id, g);
  if (!m) return { err: 'nf' };
  if (!['active', 'disputed'].includes(m.status)) return { err: 'state' };
  if (!seat(m, w)) return { err: 'notplayer' };
  return { match: end(m, 'finished', w) };
}

function ranking(g, limit) {
  const t = new Map();
  const rec = (u) => t.get(u) || t.set(u, { uid: u, wins: 0, losses: 0 }).get(u);
  for (const m of matches.values()) {
    if (m.guild !== g || m.status !== 'finished') continue;
    rec(m.winner).wins++;
    rec(m.winner === m.p1 ? m.p2 : m.p1).losses++;
  }
  return [...t.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.uid.localeCompare(b.uid)).slice(0, limit);
}

/* ---------- visual ---------- */
const ERR = {
  nf: 'Esta fila/partida não existe mais. Peça a um admin para rodar /painel publicar.',
  busy: 'Você já está em outra fila. Saia dela antes de entrar nesta.',
  here: 'Você já está nesta fila.',
  full: 'Esta fila já está com a partida completa.',
  notin: 'Você não está nesta fila.',
  inmatch: 'Sua partida já foi formada. Use os botões da partida.',
  notplayer: 'Você não participa desta partida.',
  state: 'Esta ação não está mais disponível para esta partida.',
};
const STATUS = {
  confirming: '⏳ Aguardando confirmação dos jogadores',
  active: '🎮 Em andamento — reportem o resultado',
  disputed: '⚠️ Resultados divergentes — aguardando um administrador',
  finished: '🏁 Finalizada',
  cancelled: '❌ Cancelada',
};
const file = () => new AttachmentBuilder(logoPng(), { name: 'logo.png' });
const btn = (id, label, style, off = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(off);
const row = (...b) => new ActionRowBuilder().addComponents(...b);
const fields = (x) => [
  { name: 'Formato', value: 'X1', inline: true },
  { name: 'Valor', value: `R$ ${x.value}`, inline: true },
  ...(PLAT[x.platform] ? [{ name: 'Plataforma', value: PLAT[x.platform], inline: true }] : []),
];

function queueView(q) {
  const full = q.players.length >= 2;
  const e = new EmbedBuilder().setColor(BLUE).setTitle('Filas eFootball').setThumbnail('attachment://logo.png')
    .addFields(...fields(q),
      { name: 'Jogadores', value: q.players.length ? q.players.map((u) => `<@${u}>`).join('\n') : '—' },
      { name: 'Status', value: full ? '🟢 Partida completa' : `🟡 Aguardando jogador (${q.players.length}/2)` })
    .setFooter({ text: 'eFootball • X1' });
  return { embeds: [e], components: [row(btn(`q:join:${q.id}`, 'Entrar na fila', P, full), btn(`q:leave:${q.id}`, 'Sair da fila', G, full))], files: [file()] };
}

function matchView(m) {
  const mk = (ok) => (m.status === 'confirming' ? (ok ? ' ✅' : ' ⏳') : '');
  const f = [...fields(m), { name: 'Jogadores', value: `<@${m.p1}>${mk(m.c1)}\n<@${m.p2}>${mk(m.c2)}` }, { name: 'Status', value: STATUS[m.status] }];
  if (m.winner) f.push({ name: 'Vencedor', value: `🏆 <@${m.winner}>` });
  const e = new EmbedBuilder().setColor(BLUE).setTitle(`Partida #${m.id} • X1`).setThumbnail('attachment://logo.png').addFields(f).setFooter({ text: 'eFootball • X1' });
  const b = (a, l, s) => btn(`m:${a}:${m.id}`, l, s);
  const components = m.status === 'confirming' ? [row(b('confirm', 'Confirmar', P), b('cancel', 'Cancelar', G))]
    : m.status === 'active' ? [row(b('win', 'Venci', P), b('loss', 'Perdi', G))] : [];
  return { embeds: [e], components, files: [file()] };
}

/* ---------- comandos slash ---------- */
const commands = [
  new SlashCommandBuilder().setName('painel').setDescription('Gerencia o painel de filas (admin)')
    .addSubcommand((s) => s.setName('publicar').setDescription('Publica as filas neste canal')
      .addStringOption((o) => o.setName('valores').setDescription('Ex: 1,2,5,10 (vazio = todos)'))
      .addBooleanOption((o) => o.setName('separar_plataformas').setDescription('Separar Mobile e Emulador (padrão: sim)')))
    .addSubcommand((s) => s.setName('atualizar').setDescription('Reatualiza os embeds das filas'))
    .addSubcommand((s) => s.setName('remover').setDescription('Remove o painel de filas')),
  new SlashCommandBuilder().setName('ranking').setDescription('Ranking de vitórias')
    .addIntegerOption((o) => o.setName('limite').setDescription('Quantidade (1-25)').setMinValue(1).setMaxValue(25)),
  new SlashCommandBuilder().setName('historico').setDescription('Histórico das últimas partidas')
    .addUserOption((o) => o.setName('jogador').setDescription('Jogador (padrão: você)')),
  new SlashCommandBuilder().setName('partida').setDescription('Ações de administrador em partidas')
    .addSubcommand((s) => s.setName('resolver').setDescription('Define o vencedor de uma partida')
      .addIntegerOption((o) => o.setName('id').setDescription('ID da partida').setRequired(true))
      .addUserOption((o) => o.setName('vencedor').setDescription('Vencedor').setRequired(true)))
    .addSubcommand((s) => s.setName('cancelar').setDescription('Cancela uma partida')
      .addIntegerOption((o) => o.setName('id').setDescription('ID da partida').setRequired(true))),
].map((c) => c.toJSON());

/* ---------- handlers ---------- */
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const isAdmin = (i) => Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));

async function edit(client, channel, msg, payload) {
  if (!msg) return;
  try { const m = await (await client.channels.fetch(channel)).messages.fetch(msg); await m.edit(payload); }
  catch (e) { console.warn('Falha ao editar mensagem:', e.code || e.message); }
}
const refreshQ = (c, q) => (q ? edit(c, q.channel, q.msg, queueView(q)) : null);
async function refreshM(c, m) {
  await edit(c, m.channel, m.msg, matchView(m));
  if (['finished', 'cancelled'].includes(m.status)) await refreshQ(c, queues.get(m.queue));
}
async function openMatch(c, m) {
  const ch = await c.channels.fetch(m.channel);
  const sent = await ch.send({ content: `<@${m.p1}> <@${m.p2}> — partida formada! Confirmem abaixo.`, ...matchView(m), allowedMentions: { users: [m.p1, m.p2] } });
  m.msg = sent.id;
}
async function removePanel(c, g) {
  const list = qList(g);
  for (const q of list) {
    try { await (await (await c.channels.fetch(q.channel)).messages.fetch(q.msg)).delete(); } catch { /* já removida */ }
  }
  list.forEach((q) => queues.delete(q.id));
  return list.length;
}

async function onButton(i, c) {
  const [scope, action, raw] = i.customId.split(':');
  const id = Number(raw);
  if (!['q', 'm'].includes(scope) || !Number.isInteger(id) || !i.inGuild()) return;
  await i.deferUpdate();
  const say = (t) => i.followUp(eph(t));
  const u = i.user.id;
  const g = i.guildId;
  let r;
  if (scope === 'q') {
    if (action === 'join') r = join(id, g, u);
    else if (action === 'leave') r = leave(id, g, u);
    else return;
    if (r.err) return say(ERR[r.err]);
    await refreshQ(c, queues.get(id));
    if (r.match) await openMatch(c, r.match);
    return;
  }
  if (action === 'confirm') r = confirm(id, g, u);
  else if (action === 'cancel') r = cancel(id, g, u, false);
  else if (action === 'win' || action === 'loss') r = report(id, g, u, action);
  else return;
  if (r.err) return say(ERR[r.err]);
  await refreshM(c, r.match);
  if (r.match.status === 'active' && (action === 'win' || action === 'loss')) await say('✅ Resultado registrado. Aguardando o adversário reportar.');
}

async function cmdPainel(i, c) {
  const sub = i.options.getSubcommand();
  const g = i.guildId;
  if (sub === 'publicar') {
    const parsed = parseValues(i.options.getString('valores'));
    if (!parsed.ok) return i.reply(eph(`Valores inválidos: ${parsed.invalid.join(', ')}.\nPermitidos: ${VALUES.join(', ')}`));
    const perms = i.channel?.permissionsFor(i.guild.members.me);
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
    if (!perms?.has(need)) return i.reply(eph('Preciso das permissões Ver Canal, Enviar Mensagens, Inserir Links e Anexar Arquivos neste canal.'));
    if (openCount(g)) return i.reply(eph('Há partidas em andamento. Finalize ou cancele-as antes de republicar o painel.'));
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await removePanel(c, g);
    const plats = (i.options.getBoolean('separar_plataformas') ?? true) ? ['mobile', 'emulador'] : ['unica'];
    let n = 0;
    for (const platform of plats) {
      for (const value of parsed.values) {
        const q = newQueue(g, i.channelId, platform, value);
        q.msg = (await i.channel.send(queueView(q))).id;
        n++;
      }
    }
    return i.editReply(`✅ Painel publicado com ${n} filas.`);
  }
  if (sub === 'atualizar') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const list = qList(g);
    for (const q of list) await refreshQ(c, q);
    return i.editReply(`✅ ${list.length} filas atualizadas.`);
  }
  if (openCount(g)) return i.reply(eph('Há partidas em andamento. Finalize ou cancele-as antes de remover o painel.'));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  return i.editReply(`🗑️ ${await removePanel(c, g)} filas removidas.`);
}

function cmdRanking(i) {
  const rows = ranking(i.guildId, i.options.getInteger('limite') ?? 10);
  const medals = ['🥇', '🥈', '🥉'];
  const desc = rows.length ? rows.map((r, k) => `${medals[k] || `**${k + 1}.**`} <@${r.uid}> — ${r.wins}V • ${r.losses}D`).join('\n') : 'Ainda não há partidas finalizadas.';
  const e = new EmbedBuilder().setColor(BLUE).setTitle('🏆 Ranking eFootball • X1').setDescription(desc);
  return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
}

function cmdHistorico(i) {
  const user = i.options.getUser('jogador') ?? i.user;
  const rows = [...matches.values()]
    .filter((m) => m.guild === i.guildId && (m.p1 === user.id || m.p2 === user.id) && ['finished', 'cancelled'].includes(m.status))
    .sort((a, b) => b.id - a.id).slice(0, 10);
  const desc = rows.length ? rows.map((m) => {
    const opp = m.p1 === user.id ? m.p2 : m.p1;
    const res = m.status === 'cancelled' ? '❌ Cancelada' : m.winner === user.id ? '🏆 Vitória' : '💀 Derrota';
    return `#${m.id} • R$ ${m.value} • ${PLAT[m.platform] || 'eFootball'} • vs <@${opp}> — ${res}`;
  }).join('\n') : 'Nenhuma partida encontrada.';
  const e = new EmbedBuilder().setColor(BLUE).setTitle(`📜 Histórico • ${user.username}`).setDescription(desc);
  return i.reply({ embeds: [e], allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
}

async function cmdPartida(i, c) {
  const id = i.options.getInteger('id', true);
  const resolving = i.options.getSubcommand() === 'resolver';
  const r = resolving ? resolve(id, i.guildId, i.options.getUser('vencedor', true).id) : cancel(id, i.guildId, null, true);
  if (r.err) return i.reply(eph(ERR[r.err]));
  await refreshM(c, r.match);
  return i.reply(eph(`✅ Partida #${id} ${resolving ? 'finalizada' : 'cancelada'}.`));
}

async function onCommand(i, c) {
  if (!i.inGuild()) return i.reply(eph('Use este comando dentro de um servidor.'));
  const n = i.commandName;
  if ((n === 'painel' || n === 'partida') && !isAdmin(i)) return i.reply(eph('Apenas administradores (permissão Gerenciar Servidor) podem usar este comando.'));
  if (n === 'painel') return cmdPainel(i, c);
  if (n === 'ranking') return cmdRanking(i);
  if (n === 'historico') return cmdHistorico(i);
  if (n === 'partida') return cmdPartida(i, c);
}

/* ---------- testes: npm test ---------- */
if (process.argv.includes('--test')) {
  const assert = require('assert');
  assert.strictEqual(VALUES.length, 23);
  assert.deepStrictEqual(parseValues('5,1,1').values, [1, 5]);
  assert.strictEqual(parseValues('4').ok, false);
  const a = newQueue('g', 'c', 'mobile', 5);
  const b = newQueue('g', 'c', 'mobile', 10);
  assert.ok(!join(a.id, 'g', 'A').err);
  assert.strictEqual(join(a.id, 'g', 'A').err, 'here');
  assert.strictEqual(join(b.id, 'g', 'A').err, 'busy');
  const m = join(a.id, 'g', 'B').match;
  assert.strictEqual(join(a.id, 'g', 'C').err, 'full');
  confirm(m.id, 'g', 'A');
  assert.strictEqual(confirm(m.id, 'g', 'B').match.status, 'active');
  report(m.id, 'g', 'A', 'win');
  assert.strictEqual(report(m.id, 'g', 'B', 'win').match.status, 'disputed');
  assert.strictEqual(resolve(m.id, 'g', 'A').match.status, 'finished');
  assert.deepStrictEqual(ranking('g', 5).map((r) => [r.uid, r.wins, r.losses]), [['A', 1, 0], ['B', 0, 1]]);
  assert.strictEqual(queueView(a).embeds[0].toJSON().title, 'Filas eFootball');
  console.log('✅ Testes ok');
  process.exit(0);
}

/* ---------- inicialização ---------- */
const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN) { console.error('Defina DISCORD_TOKEN nas variáveis de ambiente.'); process.exit(1); }
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Online como ${c.user.tag}`);
  try {
    await (GUILD_ID ? c.application.commands.set(commands, GUILD_ID) : c.application.commands.set(commands));
    console.log('Comandos registrados.');
  } catch (e) { console.error('Falha ao registrar comandos:', e); }
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await onCommand(i, client);
    else if (i.isButton()) await onButton(i, client);
  } catch (err) {
    console.error('Erro na interação:', err);
    const msg = eph('❌ Ocorreu um erro. Tente novamente em instantes.');
    try { await (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)); } catch { /* expirada */ }
  }
});

client.on(Events.Error, (e) => console.error('Erro do client:', e));

http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(process.env.PORT || 3000);
process.on('SIGTERM', () => { client.destroy(); process.exit(0); });

client.login(DISCORD_TOKEN).catch((e) => { console.error('Falha no login:', e.message); process.exit(1); });