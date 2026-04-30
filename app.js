const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;   
const OAB_UF    = process.env.OAB_UF;       
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
  // URL Nacional para evitar quedas de tribunais específicos
  const url = `https://api-publica.datajud.cnj.jus.br/api_publica_public/_search`;

  const queryData = {
    "query": {
      "bool": {
        "must": [
          { "match": { "advogado.numero_oab": OAB_NUM } },
          { "match": { "advogado.uf": OAB_UF } }
        ]
      }
    }
  };

  try {
    const response = await axios.post(url, queryData, {
      headers: {
        'Authorization': `ApiKey ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    const items = response.data?.hits?.hits || [];
    return items.map(item => ({
      id: item._id,
      numeroProcesso: item._source.numeroProcesso,
      data: item._source.dataHoraUltimaAtualizacao,
      tribunal: item._source.tribunal,
      resumo: item._source.classe?.nome || "Movimentação detectada"
    }));
  } catch (err) {
    console.error('[DataJud] Detalhe do Erro:', err.response?.status || err.message);
    return null; 
  }
}

// ─── LÓGICA DE ENVIO ──────────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs === null) {
    await bot.sendMessage(CHAT_ID, "⚠️ *Erro 401/Conexão:* O DataJud recusou a chave de acesso. Verifique a variável DATAJUD_API_KEY no Railway.");
    return;
  }

  if (pubs.length === 0) {
    await bot.sendMessage(CHAT_ID, `🔍 *Verificação:* Nenhum processo encontrado para OAB ${OAB_NUM}/${OAB_UF}.`);
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
    await bot.sendMessage(CHAT_ID, `✅ *Status:* Tudo em dia. Nenhuma nova atualização na última hora.`);
  }

  saveSeen(seen);
}

// ─── COMANDOS E AGENDAMENTO ───────────────────────────────────────────────────
bot.onText(/\/verificar/, () => checkPublications());

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🚀 *Bot OAB ${OAB_NUM} Online*\nVerificações de hora em hora ativadas.`);
});

// Agendamento: minuto 0 de cada hora
cron.schedule('0 * * * *', checkPublications);

// Executa ao iniciar
checkPublications();
