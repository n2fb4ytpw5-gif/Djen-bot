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
  // Tentamos primeiro o TJRS, que é o seu tribunal principal
  let url = `https://api-publica.datajud.cnj.jus.br/api_publica_tjrs/_search`;
  
  const queryData = {
    "query": {
      "match": { "advogado.numero_oab": OAB_NUM }
    },
    "_source": ["numeroProcesso", "dataHoraUltimaAtualizacao", "tribunal", "classe.nome"]
  };

  const config = {
    headers: {
      'Authorization': `ApiKey ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 25000
  };

  try {
    let response = await axios.post(url, queryData, config);
    
    // Se a busca retornar vazia ou der erro, tentamos a base Nacional (Fallback)
    if (!response.data?.hits?.hits?.length) {
      console.log('[DataJud] Sem resultados no TJRS, tentando base Nacional...');
      url = `https://api-publica.datajud.cnj.jus.br/api_publica_public/_search`;
      response = await axios.post(url, queryData, config);
    }

    const items = response.data?.hits?.hits || [];
    return items.map(item => ({
      id: item._id,
      numeroProcesso: item._source.numeroProcesso,
      data: item._source.dataHoraUltimaAtualizacao,
      tribunal: item._source.tribunal,
      resumo: item._source.classe?.nome || "Movimentação detectada"
    }));
  } catch (err) {
    const status = err.response?.status;
    console.error(`[DataJud] Erro ${status}:`, err.message);
    return status || "ERRO"; 
  }
}

// ─── LÓGICA DE ENVIO ──────────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Verificando publicações...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  if (pubs === 401) {
    await bot.sendMessage(CHAT_ID, "🔐 *Erro 401:* Chave de acesso recusada. Verifique a `DATAJUD_API_KEY` no Railway.");
    return;
  }
  
  if (pubs === 404) {
    await bot.sendMessage(CHAT_ID, "🚫 *Erro 404:* Servidor do tribunal não encontrado. Tentarei novamente na próxima hora.");
    return;
  }

  if (typeof pubs === 'string') {
    await bot.sendMessage(CHAT_ID, "⚠️ *Erro de Conexão:* O DataJud está instável no momento.");
    return;
  }

  if (pubs.length === 0) {
    await bot.sendMessage(CHAT_ID, `🔍 *Verificação:* Nenhum processo encontrado para OAB ${OAB_NUM}.`);
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
    await bot.sendMessage(CHAT_ID, `✅ *Status:* Tudo em dia. Nenhuma movimentação nova para a OAB ${OAB_NUM}.`);
  }

  saveSeen(seen);
}

// ─── COMANDOS E AGENDAMENTO ───────────────────────────────────────────────────
bot.onText(/\/verificar/, () => checkPublications());

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🚀 *Bot OAB ${OAB_NUM} Online*\n\nVerificações automáticas a cada 1 hora.\nUse /verificar para buscar agora.`);
});

// Agendamento: minuto 0 de cada hora
cron.schedule('0 * * * *', checkPublications);

// Executa uma vez ao iniciar o servidor
checkPublications();
