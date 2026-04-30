const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;
const OAB_UF    = process.env.OAB_UF;
const API_KEY   = process.env.DATAJUD_API_KEY;

const SEEN_FILE = './seen_ids.json';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
    return new Set();
  } catch (err) {
    console.error('Erro ao carregar cache:', err.message);
    return new Set();
  }
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
  } catch (err) {
    console.error('Erro ao salvar cache:', err.message);
  }
}

// ─── CONSULTA DATAJUD ─────────────────────────────────────────────────────────
async function fetchPublications() {
  const url = `https://api-publica.datajud.cnj.jus.br/api_publica/_search`;

  const queryData = {
    size: 20,
    sort: [{ "dataHoraUltimaAtualizacao": "desc" }],
    query: {
      bool: {
        should: [
          { match: { "advogados.numeroOAB": OAB_NUM } },
          { match: { "advogados.ufOAB": OAB_UF } }
        ]
      }
    },
    _source: [
      "numeroProcesso",
      "dataHoraUltimaAtualizacao",
      "tribunal",
      "classe.nome"
    ]
  };

  const config = {
    headers: {
      'Authorization': `ApiKey ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  };

  try {
    const response = await axios.post(url, queryData, config);

    const items = response.data?.hits?.hits || [];

    return items.map(item => ({
      id: item._id,
      numeroProcesso: item._source.numeroProcesso,
      data: item._source.dataHoraUltimaAtualizacao,
      tribunal: item._source.tribunal || "N/A",
      resumo: item._source.classe?.nome || "Movimentação detectada"
    }));

  } catch (err) {
    const status = err.response?.status;

    console.error(`[DataJud] Erro ${status || ''}:`, err.message);

    return status || "ERRO";
  }
}

// ─── LÓGICA DE ENVIO ──────────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando...`);

  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs === 401) {
    await bot.sendMessage(CHAT_ID, "🔐 Erro 401: API KEY inválida ou ausente.");
    return;
  }

  if (pubs === 404) {
    await bot.sendMessage(CHAT_ID, "🚫 Erro 404: Endpoint do DataJud inválido.");
    return;
  }

  if (typeof pubs === 'string') {
    await bot.sendMessage(CHAT_ID, "⚠️ DataJud instável no momento.");
    return;
  }

  if (pubs.length === 0) {
    console.log("Nenhum resultado encontrado.");
    return;
  }

  let novos = 0;

  for (const pub of pubs) {
    if (seen.has(pub.id)) continue;

    seen.add(pub.id);
    novos++;

    const msg =
`⚖️ Nova movimentação

📋 Processo: ${pub.numeroProcesso}
🏛️ Tribunal: ${pub.tribunal}
📅 Data: ${new Date(pub.data).toLocaleString('pt-BR')}
📝 Classe: ${pub.resumo}`;

    await bot.sendMessage(CHAT_ID, msg);
  }

  if (novos === 0) {
    console.log("Sem novidades.");
  }

  saveSeen(seen);
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🤖 Bot jurídico ativo

OAB: ${OAB_NUM}/${OAB_UF}
Verificação automática: 1h

Use /verificar para rodar manualmente.`);
});

bot.onText(/\/verificar/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "🔎 Consultando DataJud...");
  await checkPublications();
});

// ─── AGENDAMENTO ──────────────────────────────────────────────────────────────
cron.schedule('0 * * * *', checkPublications);

// ─── START ────────────────────────────────────────────────────────────────────
checkPublications();
