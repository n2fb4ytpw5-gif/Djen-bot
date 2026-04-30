const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;   // ex: "123456"
const OAB_UF    = process.env.OAB_UF;       // ex: "SP"

const SEEN_FILE = './seen_ids.json';

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── PERSISTÊNCIA DE IDs JÁ ENVIADOS ──────────────────────────────────────────
function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
}

// ─── CONSULTA DJEN ────────────────────────────────────────────────────────────
async function fetchPublications() {
  const today = new Date();
  const dd    = String(today.getDate()).padStart(2, '0');
  const mm    = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy  = today.getFullYear();

  const url = `https://www.jusbrasil.com.br/diarios/busca/?q=OAB+${OAB_NUM}+${OAB_UF}&o=1`;

  // Tenta a API pública do CNJ primeiro
  try {
    const cnj = await axios.get(
      `https://djen.jus.br/comunicacoesProcessuais/pesquisa`,
      {
        params: {
          numeroOAB:   OAB_NUM,
          ufOAB:       OAB_UF,
          dataInicio:  `${yyyy}-${mm}-${dd}`,
          dataFim:     `${yyyy}-${mm}-${dd}`,
        },
        timeout: 15000,
        headers: { 'Accept': 'application/json' },
      }
    );

    const items = cnj.data?.data || cnj.data?.publicacoes || cnj.data || [];
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error('[DJEN] Erro na consulta:', err.message);
    return [];
  }
}

// ─── FORMATA MENSAGEM ──────────────────────────────────────────────────────────
function formatMsg(pub) {
  const num   = pub.numeroProcesso || pub.numero_processo || 'N/D';
  const data  = pub.dataDisponibilizacao || pub.data || 'N/D';
  const texto = pub.texto || pub.conteudo || pub.resumo || '(sem resumo)';
  const trecho = texto.length > 600 ? texto.substring(0, 600) + '…' : texto;

  return (
    `⚖️ *Nova publicação no DJEN*\n\n` +
    `📋 *Processo:* \`${num}\`\n` +
    `📅 *Data:* ${data}\n\n` +
    `📝 *Trecho:*\n${trecho}`
  );
}

// ─── VERIFICA PUBLICAÇÕES ──────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando DJEN...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs.length === 0) {
    console.log('Nenhuma publicação encontrada hoje.');
    return;
  }

  let novos = 0;
  for (const pub of pubs) {
    const id = pub.id || pub.idPublicacao || pub.numeroProcesso || JSON.stringify(pub).slice(0, 80);
    if (seen.has(id)) continue;

    seen.add(id);
    novos++;

    try {
      await bot.sendMessage(CHAT_ID, formatMsg(pub), { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Telegram] Erro ao enviar:', e.message);
    }
  }

  saveSeen(seen);
  console.log(`Novas publicações enviadas: ${novos}`);
}

// ─── COMANDOS DO BOT ──────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 *Bot DJEN ativo!*\n\n` +
    `Monitorando OAB *${OAB_NUM}/${OAB_UF}* 🔍\n\n` +
    `Verificações automáticas: *dias úteis às 8h, 12h e 18h*\n\n` +
    `Comandos:\n` +
    `/verificar — checar agora\n` +
    `/status — ver configuração`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/verificar/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔍 Verificando publicações agora...');
  await checkPublications();
  await bot.sendMessage(msg.chat.id, '✅ Verificação concluída!');
});

bot.onText(/\/status/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `⚙️ *Status do Bot*\n\n` +
    `OAB: *${OAB_NUM}/${OAB_UF}*\n` +
    `Chat ID: \`${CHAT_ID}\`\n` +
    `Agendamento: dias úteis 8h, 12h e 18h`,
    { parse_mode: 'Markdown' }
  );
});

// ─── AGENDAMENTO (dias úteis, 3x ao dia) ─────────────────────────────────────
// Seg-Sex às 08:00, 12:00 e 18:00 (horário de Brasília = UTC-3)
cron.schedule('0 11 * * 1-5', checkPublications); // 08:00 BRT
cron.schedule('0 15 * * 1-5', checkPublications); // 12:00 BRT
cron.schedule('0 21 * * 1-5', checkPublications); // 18:00 BRT

// ─── START ────────────────────────────────────────────────────────────────────
console.log('🤖 Bot DJEN iniciado!');
console.log(`   OAB: ${OAB_NUM}/${OAB_UF}`);
console.log(`   Chat ID: ${CHAT_ID}`);
checkPublications(); // roda uma vez ao iniciar
