const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) throw new Error("Token não definido");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── ARQUIVOS ─────────────────────────────────────────────────
const CLIENTES_FILE = './clientes.json';
const FINANCEIRO_FILE = './financeiro.json';
const PRAZOS_FILE = './prazos.json';

// ─── FUNÇÕES AUXILIARES ───────────────────────────────────────
function load(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file));
    }
    return [];
  } catch {
    return [];
  }
}

function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── 1. CRM DE CLIENTES ───────────────────────────────────────
bot.onText(/\/cliente novo (.+)/, (msg, match) => {
  const [nome, telefone, processo] = match[1].split('|');

  const clientes = load(CLIENTES_FILE);

  clientes.push({
    nome: nome.trim(),
    telefone: telefone?.trim(),
    processo: processo?.trim(),
    criadoEm: new Date()
  });

  save(CLIENTES_FILE, clientes);

  bot.sendMessage(msg.chat.id, "✅ Cliente cadastrado");
});

bot.onText(/\/cliente listar/, (msg) => {
  const clientes = load(CLIENTES_FILE);

  if (clientes.length === 0) {
    return bot.sendMessage(msg.chat.id, "Nenhum cliente cadastrado.");
  }

  let texto = "📋 Clientes:\n\n";

  clientes.forEach(c => {
    texto += `• ${c.nome} | ${c.processo || "sem processo"}\n`;
  });

  bot.sendMessage(msg.chat.id, texto);
});

// ─── 2. CONTROLE FINANCEIRO ───────────────────────────────────
bot.onText(/\/recebi (\d+) (.+)/, (msg, match) => {
  const valor = parseFloat(match[1]);
  const cliente = match[2];

  const dados = load(FINANCEIRO_FILE);

  dados.push({
    tipo: "entrada",
    valor,
    cliente,
    data: new Date()
  });

  save(FINANCEIRO_FILE, dados);

  bot.sendMessage(msg.chat.id, "💰 Entrada registrada");
});

bot.onText(/\/gasto (\d+) (.+)/, (msg, match) => {
  const valor = parseFloat(match[1]);
  const descricao = match[2];

  const dados = load(FINANCEIRO_FILE);

  dados.push({
    tipo: "gasto",
    valor,
    descricao,
    data: new Date()
  });

  save(FINANCEIRO_FILE, dados);

  bot.sendMessage(msg.chat.id, "💸 Gasto registrado");
});

bot.onText(/\/resumo/, (msg) => {
  const dados = load(FINANCEIRO_FILE);

  let entrada = 0;
  let gasto = 0;

  dados.forEach(d => {
    if (d.tipo === "entrada") entrada += d.valor;
    if (d.tipo === "gasto") gasto += d.valor;
  });

  const saldo = entrada - gasto;

  bot.sendMessage(msg.chat.id,
    `📊 Resumo:\n\n` +
    `Entradas: R$ ${entrada}\n` +
    `Gastos: R$ ${gasto}\n` +
    `Saldo: R$ ${saldo}`
  );
});

// ─── 3. PRAZOS ────────────────────────────────────────────────
bot.onText(/\/prazo (\d{2}\/\d{2}\/\d{4}) (.+)/, (msg, match) => {
  const data = match[1];
  const desc = match[2];

  const prazos = load(PRAZOS_FILE);

  prazos.push({ data, desc });

  save(PRAZOS_FILE, prazos);

  bot.sendMessage(msg.chat.id, "📅 Prazo salvo");
});

// Verificação diária
cron.schedule('0 9 * * *', () => {
  const hoje = new Date().toLocaleDateString('pt-BR');
  const prazos = load(PRAZOS_FILE);

  prazos.forEach(p => {
    if (p.data === hoje) {
      bot.sendMessage(process.env.TELEGRAM_CHAT_ID,
        `⏰ Prazo hoje:\n${p.desc}`
      );
    }
  });
});

// ─── 4. RESPOSTAS AUTOMÁTICAS ─────────────────────────────────
bot.onText(/\/acordo/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `Boa tarde!\n\nSegue proposta de acordo conforme conversado.`
  );
});

// ─── 5. CONSULTA BÁSICA DE PROCESSO ───────────────────────────
bot.onText(/\/processo (.+)/, (msg, match) => {
  const numero = match[1];

  if (numero.length < 10) {
    return bot.sendMessage(msg.chat.id, "❌ Número inválido");
  }

  let tribunal = "Desconhecido";

  if (numero.includes("8.21")) tribunal = "TJRS";
  if (numero.includes("8.26")) tribunal = "TJSP";

  bot.sendMessage(msg.chat.id,
    `🔎 Consulta básica:\n\n` +
    `Processo: ${numero}\n` +
    `Tribunal: ${tribunal}\n\n` +
    `⚠️ Consulta completa ainda não integrada`
  );
});

// ─── START ────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🤖 Bot jurídico ativo!");
});

console.log("🚀 Bot rodando...");
