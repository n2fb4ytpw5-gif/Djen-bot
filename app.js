const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIGURAÇÃO ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;   // No Railway deve ser: 139219
const OAB_UF    = process.env.OAB_UF;       // No Railway deve ser: RS

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
    return new Set();
  }
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
  } catch (err) {
    console.error('Erro ao salvar visto:', err.message);
  }
}

// ─── CONSULTA DATAJUD (CNJ) ───────────────────────────────────────────────────
async function fetchPublications() {
  // Usando a URL pública nacional para maior estabilidade
  const url = `https://api-publica.datajud.cnj.jus.br/api_publica_public/_search`;

  try {
    const response = await axios.post(
      url,
      {
        "query": {
          "bool": {
            "must": [
              { "match": { "advogado.numero_oab": OAB_NUM } },
              { "match": { "advogado.uf": OAB_UF } }
            ]
          }
        }
      },
      {
        headers: {
          'Authorization': 'ApiKey c3VwZXJzZWNyZXRvOnN1cGVyc2VjcmV0bw==',
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const items = response.data?.hits?.hits || [];
    return items.map(item => ({
      id: item._id,
      numeroProcesso: item._source.numeroProcesso,
      data: item._source.dataHoraUltimaAtualizacao,
      tribunal: item._source.tribunal,
      classe: item._source.classe?.nome || "Movimentação Processual"
    }));
  } catch (err) {
    console.error('[DataJud] Erro na consulta:', err.message);
    return null; 
  }
}

// ─── FORMATAÇÃO ───────────────────────────────────────────────────────────────
function formatMsg(pub) {
  const data = new Date(pub.data).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  
  return (
    `⚖️ *Nova atualização localizada*\n\n` +
    `📋 *Processo:* \`${pub.numeroProcesso}\`\n` +
    `🏛️ *Tribunal:* ${pub.tribunal}\n` +
    `📅 *Data:* ${data}\n\n` +
    `📝 *Descrição:* ${pub.classe}`
  );
}

// ─── LÓGICA DE VERIFICAÇÃO ────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Iniciando checagem...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  // Caso ocorra erro de conexão/autenticação
  if (pubs === null) {
    await bot.sendMessage(CHAT_ID, "⚠️ *Aviso:* Falha na conexão com o DataJud. Verificarei novamente na próxima hora.");
    return;
  }

  // Caso não existam processos para essa OAB
  if (pubs.length === 0) {
    await bot.sendMessage(CHAT_ID, "🔍 *Verificação:* Nenhum processo ou prazo em aberto localizado para OAB " + OAB_NUM + ".");
    return;
  }

  let novosEnviados = 0;
  for (const pub of pubs) {
    if (seen.has(pub.id)) continue;

    seen.add(pub.id);
    novosEnviados++;

    try {
      await bot.sendMessage(CHAT_ID, formatMsg(pub), { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('[Telegram] Erro ao enviar:', e.message);
    }
  }

  // Se a lista não estiver vazia, mas todos já foram vistos
  if (novosEnviados === 0) {
    await bot.sendMessage(CHAT_ID, "✅ *Tudo em dia:* Nenhuma movimentação nova para a OAB " + OAB_NUM + ".");
  }

  saveSeen(seen);
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 *Monitor Jurídico Ativo*\n\nMonitorando OAB *${OAB_NUM}/${OAB_UF}*.\nVerificações automáticas de hora em hora.`);
});

bot.onText(/\/verificar/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔎 Iniciando busca manual...');
  await checkPublications();
});

bot.onText(/\/status/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚙️ *Configuração*\nOAB: ${OAB_NUM}\nUF: ${OAB_UF}\nFrequência: 1h/1h`);
});

// ─── AGENDAMENTO (Hora em Hora) ───────────────────────────────────────────────
cron.schedule('0 * * * *', checkPublications);

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
console.log('🤖 Bot iniciado com sucesso!');
checkPublications(); 
