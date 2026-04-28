const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ── JSON database (no native compilation needed) ─────────────
const DB_DIR  = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'data.json');
fs.mkdirSync(DB_DIR, { recursive: true });

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return {
    colaboradores: [],
    marketplaces: [],
    bipagens: [],
    pendencias: [],
    retornos: []
  };
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Seed defaults if empty
let db = readDB();
if (!db.colaboradores.length) {
  db.colaboradores = [
    'PEDRO','VITOR','GEAN','KAUAN','GABRIEL',
    'MURILO','LIEDSON','GUNTHER','LUIS','EDSON','EDINHO'
  ].map((nome, i) => ({ id: i+1, nome, setor: '', criado_em: new Date().toISOString() }));
}
if (!db.marketplaces.length) {
  db.marketplaces = [
    { id:1, nome:'SHOPEE',         cor:'#ff5722' },
    { id:2, nome:'MERCADO LIVRE',  cor:'#ffe600' },
    { id:3, nome:'AMAZON',         cor:'#ff9900' },
    { id:4, nome:'SHEIN',          cor:'#e91e8c' },
  ].map(m => ({ ...m, criado_em: new Date().toISOString() }));
}
writeDB(db);

// ── Helpers ──────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function nowBR() {
  const now = new Date();
  return {
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
  };
}

// ── WebSocket broadcast ──────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
wss.on('connection', ws => ws.on('error', console.error));

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Estado inicial ───────────────────────────────────────────
app.get('/api/estado', (req, res) => {
  db = readDB();
  res.json(db);
});

// ── Colaboradores ────────────────────────────────────────────
app.get('/api/colaboradores', (req, res) => {
  db = readDB(); res.json(db.colaboradores);
});

app.post('/api/colaboradores', (req, res) => {
  const { nome, setor = '' } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  db = readDB();
  const nomeFmt = nome.trim().toUpperCase();
  if (db.colaboradores.find(c => c.nome === nomeFmt))
    return res.status(409).json({ erro: 'Colaborador já existe.' });
  const colab = { id: Date.now(), nome: nomeFmt, setor: setor.trim(), criado_em: new Date().toISOString() };
  db.colaboradores.push(colab);
  writeDB(db);
  broadcast('colaborador:add', colab);
  res.json(colab);
});

app.delete('/api/colaboradores/:id', (req, res) => {
  db = readDB();
  const id = parseInt(req.params.id);
  db.colaboradores = db.colaboradores.filter(c => c.id !== id);
  writeDB(db);
  broadcast('colaborador:del', { id });
  res.json({ ok: true });
});

// ── Marketplaces ─────────────────────────────────────────────
app.get('/api/marketplaces', (req, res) => {
  db = readDB(); res.json(db.marketplaces);
});

app.post('/api/marketplaces', (req, res) => {
  const { nome, cor = '#00e5a0' } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  db = readDB();
  const nomeFmt = nome.trim().toUpperCase();
  if (db.marketplaces.find(m => m.nome === nomeFmt))
    return res.status(409).json({ erro: 'Marketplace já existe.' });
  const mkt = { id: Date.now(), nome: nomeFmt, cor, criado_em: new Date().toISOString() };
  db.marketplaces.push(mkt);
  writeDB(db);
  broadcast('marketplace:add', mkt);
  res.json(mkt);
});

app.delete('/api/marketplaces/:id', (req, res) => {
  db = readDB();
  const id = parseInt(req.params.id);
  db.marketplaces = db.marketplaces.filter(m => m.id !== id);
  writeDB(db);
  broadcast('marketplace:del', { id });
  res.json({ ok: true });
});

// ── Bipagens ─────────────────────────────────────────────────
app.get('/api/bipagens', (req, res) => {
  db = readDB();
  let list = db.bipagens;
  const { colab, mkt, de, ate } = req.query;
  if (colab) list = list.filter(b => b.colaborador_nome === colab);
  if (mkt)   list = list.filter(b => b.marketplace_nome === mkt);
  if (de)    list = list.filter(b => new Date(b.criado_em) >= new Date(de));
  if (ate)   list = list.filter(b => new Date(b.criado_em) <= new Date(ate + 'T23:59:59'));
  res.json(list.sort((a,b) => new Date(b.criado_em) - new Date(a.criado_em)));
});

app.post('/api/bipagens', (req, res) => {
  const { etiqueta, marketplace_id, colaborador_id } = req.body;
  if (!etiqueta || !marketplace_id || !colaborador_id)
    return res.status(400).json({ erro: 'Etiqueta, marketplace e colaborador são obrigatórios.' });

  db = readDB();
  const etiqFmt = etiqueta.trim().toUpperCase();
  const dup = db.bipagens.find(b => b.etiqueta === etiqFmt);
  if (dup) return res.status(409).json({ erro: 'ETIQUETA DUPLICADA', duplicata: dup });

  const mkt   = db.marketplaces.find(m => m.id === parseInt(marketplace_id));
  const colab = db.colaboradores.find(c => c.id === parseInt(colaborador_id));
  if (!mkt || !colab) return res.status(400).json({ erro: 'Marketplace ou colaborador inválido.' });

  const { data, hora } = nowBR();
  const bip = {
    id: uid(), etiqueta: etiqFmt,
    marketplace_id: mkt.id, marketplace_nome: mkt.nome,
    colaborador_id: colab.id, colaborador_nome: colab.nome,
    data, hora, criado_em: new Date().toISOString()
  };
  db.bipagens.unshift(bip);
  writeDB(db);
  broadcast('bipagem:add', bip);
  res.json(bip);
});

app.delete('/api/bipagens/:id', (req, res) => {
  db = readDB();
  db.bipagens = db.bipagens.filter(b => b.id !== req.params.id);
  writeDB(db);
  broadcast('bipagem:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Pendências ───────────────────────────────────────────────
app.get('/api/pendencias', (req, res) => {
  db = readDB(); res.json(db.pendencias);
});

app.post('/api/pendencias', (req, res) => {
  const { etiqueta, colaborador_nome = '', transito = '', obs = '' } = req.body;
  if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
  db = readDB();
  const { data, hora } = nowBR();
  const pend = { id: uid(), etiqueta: etiqueta.trim().toUpperCase(), colaborador_nome, transito, obs, data, hora, criado_em: new Date().toISOString() };
  db.pendencias.unshift(pend);
  writeDB(db);
  broadcast('pendencia:add', pend);
  res.json(pend);
});

app.delete('/api/pendencias/:id', (req, res) => {
  db = readDB();
  db.pendencias = db.pendencias.filter(p => p.id !== req.params.id);
  writeDB(db);
  broadcast('pendencia:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Retornos ─────────────────────────────────────────────────
app.get('/api/retornos', (req, res) => {
  db = readDB(); res.json(db.retornos);
});

app.post('/api/retornos', (req, res) => {
  const { etiqueta, motivo = '' } = req.body;
  if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
  db = readDB();
  const { data, hora } = nowBR();
  const ret = { id: uid(), etiqueta: etiqueta.trim().toUpperCase(), motivo, data, hora, criado_em: new Date().toISOString() };
  db.retornos.unshift(ret);
  writeDB(db);
  broadcast('retorno:add', ret);
  res.json(ret);
});

app.delete('/api/retornos/:id', (req, res) => {
  db = readDB();
  db.retornos = db.retornos.filter(r => r.id !== req.params.id);
  writeDB(db);
  broadcast('retorno:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`✓ Servidor na porta ${PORT}`));
