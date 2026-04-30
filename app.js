const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const OAB_NUM   = process.env.OAB_NUMBER;   // ex: "139219"
const OAB_UF    = process.env.OAB_UF;       // ex: "RS"

const SEEN_FILE = './seen_ids.json';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── PERSISTÊNCIA ─────────────────────────────────────────────────────────────
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

// ─── CONSULTA DATAJUD (CNJ) ───────────────────────────────────────────────────
async function fetchPublications() {
  const url = `https://api-publica.datajud.cnj.jus.br/api_publica_tjrs/_search`;

  try {
    const response = await axios.post(
      url,
      {
        "query": {
          "match": {
            "advogado.numero_oab": OAB_NUM
          }
        }
      },
      {
        headers: {
          'Authorization': 'ApiKey c3VwZXJzZWNyZXRvOnN1cGVyc2VjcmV0bw==',
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const items = response.data?.hits?.hits || [];
    return items.map(item => ({
      id: item._id, // Usamos o ID único do DataJud
      numeroProcesso: item._source.numeroProcesso,
      data: item._source.dataHoraUltimaAtualizacao,
      texto: item._source.classe?.nome || "Movimentação processual identificada no TJRS."
    }));
  } catch (err) {
    console.error('[DataJud] Erro na consulta:', err.message);
    return null; // Retorna null para indicar erro de conexão
  }
}

// ─── FORMATAÇÃO ───────────────────────────────────────────────────────────────
function formatMsg(pub) {
  const num = pub.numeroProcesso;
  const data = new Date(pub.data).toLocaleString('pt-BR');
  const texto = pub.texto;

  return (
    `⚖️ *Nova publicação detectada*\n\n` +
    `📋 *Processo:* \`${num}\`\n` +
    `📅 *Atualização:* ${data}\n\n` +
    `📝 *Classe/Movimentação:*\n${texto}`
  );
}

// ─── LÓGICA DE VERIFICAÇÃO ────────────────────────────────────────────────────
async function checkPublications() {
  console.log(`[${new Date().toLocaleString('pt-BR')}] Iniciando verificação horária...`);
  const seen = loadSeen();
  const pubs = await fetchPublications();

  // Se a API falhar (retornar null)
  if (pubs === null) {
    await bot.sendMessage(CHAT_ID, "⚠️ *Aviso:* Falha na conexão com o DataJud. Tentarei novamente na próxima hora.");
    return;
  }

  // Se não houver nenhum processo na base
  if (pubs.length === 0) {
    await bot.sendMessage(CHAT_ID, "🔍 *Verificação Horária:* Não foram localizados processos ou prazos em aberto para a OAB " + OAB_NUM + ".");
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

  // Se houver processos na base, mas nenhum for "novo"
  if (novosEnviados === 0) {
    await bot.sendMessage(CHAT_ID, "✅ *Tudo em dia:* Nenhuma nova movimentação desde a última hora.");
  }

  saveSeen(seen);
  console.log(`Fim da verificação. Novas: ${novosEnviados}`);
}

// ─── COMANDOS ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 *Monitor Jurídico Ativo*\n\nVerificando OAB *${OAB_NUM}/${OAB_UF}* de hora em hora.`);
});

bot.onText(/\/verificar/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔎 Iniciando busca manual...');
  await checkPublications();
});

// ─── AGENDAMENTO (De hora em hora) ───────────────────────────────────────────
cron.schedule('0 * * * *', checkPublications);

// ─── START ────────────────────────────────────────────────────────────────────
console.log('🤖 Bot iniciado com sucesso!');
checkPublications(); 
