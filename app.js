const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;
const API_KEY   = process.env.DATAJUD_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !OAB_NUM || !API_KEY) {
  throw new Error("❌ Variáveis de ambiente obrigatórias não definidas.");
}

const SEEN_FILE = './seen_ids.json';

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

// ─── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
  } catch (err) {
    console.error("Erro ao salvar cache:", err.message);
  }
}

// ─── CONSULTA DATAJUD ─────────────────────────────────────────────────────────
async function fetchPublications() {

  const urls = [
    `https://api-publica.datajud.cnj.jus.br/api_publica_tjrs/_search`,
    `https://api-publica.datajud.cnj.jus.br/api_publica_public/_search`
  ];

  const queryData = {
    query: {
      bool: {
        must: [
          {
            range: {
              dataHoraUltimaAtualizacao: {
                gte: "now-3d"
              }
            }
          }
        ],
        should: [
          {
            query_string: {
              query: `"${OAB_NUM}" OR ${OAB_NUM}`
            }
          }
        ]
      }
    },
    _source: [
      "numeroProcesso",
      "dataHoraUltimaAtualizacao",
      "tribunal",
      "classe.nome"
    ],
    size: 20
  };

  const config = {
    headers: {
      Authorization: `ApiKey ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  };

  for (const url of urls) {
    try {
      console.log("🔎 Consultando:", url);

      const response = await axios.post(url, queryData, config);

      const items = response.data?.hits?.hits || [];

      console.log("📊 Total encontrados:", items.length);

      return items.map(item => ({
        id: item._id,
        numeroProcesso: item._source.numeroProcesso,
        data: item._source.dataHoraUltimaAtualizacao,
        tribunal: item._source.tribunal,
        resumo: item._source.classe?.nome || "Movimentação detectada"
      }));

    } catch (err) {
      console.error("Erro DataJud:", err.response?.status, err.message);
    }
  }

  return "ERRO_GERAL";
}

// ─── LÓGICA DE ENVIO ──────────────────────────────────────────────────────────
async function checkPublications() {
  console.log("⏱️ Verificando publicações...");

  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs === "ERRO_GERAL") {
    await bot.sendMessage(CHAT_ID, "⚠️ Erro ao consultar DataJud.");
    return;
  }

  await bot.sendMessage(CHAT_ID, `🔍 Debug: ${pubs.length} resultados encontrados`);

  if (pubs.length === 0) return;

  let novos = 0;

  for (const pub of pubs) {
    if (seen.has(pub.id)) continue;

    seen.add(pub.id);
    novos++;

    const msg =
      `⚖️ *Nova Movimentação*\n\n` +
      `📋 *Processo:* \`${pub.numeroProcesso}\`\n` +
      `🏛️ *Tribunal:* ${pub.tribunal}\n` +
      `📅 *Data:* ${new Date(pub.data).toLocaleString('pt-BR')}\n` +
      `📝 *Classe:* ${pub.resumo}`;

    try {
      await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error("Erro ao enviar mensagem:", err.message);
    }
  }

  console.log(`📨 Novos enviados: ${novos}`);

  saveSeen(seen);
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────
bot.onText(/\/verificar/, () => checkPublications());

bot.onText(/\/start/, (m) => {
  bot.sendMessage(m.chat.id, `🤖 Bot ativo!\nOAB monitorada: ${OAB_NUM}`);
});

// ─── SEGURANÇA (ANTI-TRAVAMENTO) ──────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error("Erro não tratado:", err);
});

process.on('uncaughtException', (err) => {
  console.error("Exceção:", err);
});

// ─── KEEP ALIVE (IMPORTANTE NO RAILWAY) ───────────────────────────────────────
setInterval(() => {
  console.log("🟢 Bot ativo:", new Date().toLocaleTimeString());
}, 60000);

// ─── AGENDAMENTO ──────────────────────────────────────────────────────────────
cron.schedule('0 * * * *', checkPublications);

// ─── START ────────────────────────────────────────────────────────────────────
console.log("🚀 Bot iniciado...");
bot.sendMessage(CHAT_ID, "🚨 Bot reiniciado e rodando!");
checkPublications();
