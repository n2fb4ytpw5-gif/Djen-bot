const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;   
const API_KEY   = process.env.DATAJUD_API_KEY || 'c3VwZXJzZWNyZXRvOnN1cGVyc2VjcmV0bw==';

const SEEN_FILE = './seen_ids.json';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
    }
    return new Set();
  } catch (err) { return new Set(); }
}

function saveSeen(set) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set])); } 
  catch (err) { console.error('Erro ao salvar cache:', err.message); }
}

// ─── CONSULTA DATAJUD ─────────────────────────────────────────────────────────
async function fetchPublications() {
  // Tentamos o TJRS primeiro
  const urls = [
    `https://api-publica.datajud.cnj.jus.br/api_publica_tjrs/_search`,
    `https://api-publica.datajud.cnj.jus.br/api_publica_public/_search`
  ];
  
  const queryData = {
    "query": { "match": { "advogado.numero_oab": OAB_NUM } },
    "_source": ["numeroProcesso", "dataHoraUltimaAtualizacao", "tribunal", "classe.nome"]
  };

  const config = {
    headers: {
      'Authorization': `ApiKey ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  };

  for (const url of urls) {
    try {
      const response = await axios.post(url, queryData, config);
      const items = response.data?.hits?.hits || [];
      if (items.length > 0 || response.status === 200) {
        return items.map(item => ({
          id: item._id,
          numeroProcesso: item._source.numeroProcesso,
          data: item._source.dataHoraUltimaAtualizacao,
          tribunal: item._source.tribunal,
          resumo: item._source.classe?.nome || "Movimentação detectada"
        }));
      }
    } catch (err) {
      console.error(`[DataJud] Falha na URL: ${url} - Erro: ${err.response?.status || err.message}`);
    }
  }
  return "ERRO_GERAL"; 
}

// ─── LÓGICA DE ENVIO ──────────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs === "ERRO_GERAL") {
    await bot.sendMessage(CHAT_ID, "⚠️ *Aviso:* O sistema DataJud (CNJ) está instável ou recusou a chave. Tentarei novamente na próxima hora.");
    return;
  }

  if (pubs.length === 0) {
    await bot.sendMessage(CHAT_ID, `🔍 *Verificação:* Nenhum novo processo para OAB ${OAB_NUM}.`);
    return;
  }

  let novos = 0;
  for (const pub of pubs) {
    if (seen.has(pub.id)) continue;
    seen.add(pub.id);
    novos++;

    const msg = `⚖️ *Nova Movimentação*\n\n` +
                `📋 *Processo:* \`${pub.numeroProcesso}\`\n` +
                `🏛️ *Tribunal:* ${pub.tribunal}\n` +
                `📅 *Data:* ${new Date(pub.data).toLocaleString('pt-BR')}\n` +
                `📝 *Classe:* ${pub.resumo}`;

    await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
  }

  if (novos === 0) {
    await bot.sendMessage(CHAT_ID, `✅ *Status:* Tudo em dia. Sem novidades na última hora.`);
  }

  saveSeen(seen);
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────
bot.onText(/\/verificar/, () => checkPublications());
bot.onText(/\/start/, (m) => bot.sendMessage(m.chat.id, "🤖 Bot Online! Verificando OAB " + OAB_NUM));

// Agendamento: de hora em hora
cron.schedule('0 * * * *', checkPublications);

// Roda ao ligar
checkPublications();
