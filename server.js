const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'bipagem.db');

// ── Ensure db folder exists ──────────────────────────────────
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Database setup ───────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS colaboradores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    setor TEXT DEFAULT '',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS marketplaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT DEFAULT '#00e5a0',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bipagens (
    id TEXT PRIMARY KEY,
    etiqueta TEXT NOT NULL UNIQUE,
    marketplace_id INTEGER,
    colaborador_id INTEGER,
    marketplace_nome TEXT,
    colaborador_nome TEXT,
    data TEXT,
    hora TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (marketplace_id) REFERENCES marketplaces(id),
    FOREIGN KEY (colaborador_id) REFERENCES colaboradores(id)
  );

  CREATE TABLE IF NOT EXISTS pendencias (
    id TEXT PRIMARY KEY,
    etiqueta TEXT NOT NULL,
    colaborador_nome TEXT,
    transito TEXT DEFAULT '',
    obs TEXT DEFAULT '',
    data TEXT,
    hora TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS retornos (
    id TEXT PRIMARY KEY,
    etiqueta TEXT NOT NULL,
    motivo TEXT DEFAULT '',
    data TEXT,
    hora TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default data if empty
const colabCount = db.prepare('SELECT COUNT(*) as c FROM colaboradores').get().c;
if (colabCount === 0) {
  const insertColab = db.prepare('INSERT OR IGNORE INTO colaboradores (nome, setor) VALUES (?, ?)');
  ['PEDRO','VITOR','GEAN','KAUAN','GABRIEL','MURILO','LIEDSON','GUNTHER','LUIS','EDSON','EDINHO'].forEach(n => insertColab.run(n, ''));
}

const mktCount = db.prepare('SELECT COUNT(*) as c FROM marketplaces').get().c;
if (mktCount === 0) {
  const insertMkt = db.prepare('INSERT OR IGNORE INTO marketplaces (nome, cor) VALUES (?, ?)');
  [['SHOPEE','#ff5722'],['MERCADO LIVRE','#ffe600'],['AMAZON','#ff9900'],['SHEIN','#e91e8c']].forEach(([n,c]) => insertMkt.run(n, c));
}

// ── WebSocket broadcast ──────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.on('error', console.error);
});

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function nowBR() {
  const now = new Date();
  const data = now.toLocaleDateString('pt-BR');
  const hora = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { data, hora };
}

// ── API: Estado inicial ──────────────────────────────────────
app.get('/api/estado', (req, res) => {
  res.json({
    colaboradores: db.prepare('SELECT * FROM colaboradores ORDER BY nome').all(),
    marketplaces:  db.prepare('SELECT * FROM marketplaces ORDER BY nome').all(),
    bipagens:      db.prepare('SELECT * FROM bipagens ORDER BY criado_em DESC').all(),
    pendencias:    db.prepare('SELECT * FROM pendencias ORDER BY criado_em DESC').all(),
    retornos:      db.prepare('SELECT * FROM retornos ORDER BY criado_em DESC').all(),
  });
});

// ── API: Colaboradores ───────────────────────────────────────
app.get('/api/colaboradores', (req, res) => {
  res.json(db.prepare('SELECT * FROM colaboradores ORDER BY nome').all());
});

app.post('/api/colaboradores', (req, res) => {
  const { nome, setor = '' } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  const nomeFmt = nome.trim().toUpperCase();
  try {
    const result = db.prepare('INSERT INTO colaboradores (nome, setor) VALUES (?, ?)').run(nomeFmt, setor.trim());
    const colab = db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(result.lastInsertRowid);
    broadcast('colaborador:add', colab);
    res.json(colab);
  } catch (e) {
    res.status(409).json({ erro: 'Colaborador já existe.' });
  }
});

app.delete('/api/colaboradores/:id', (req, res) => {
  db.prepare('DELETE FROM colaboradores WHERE id = ?').run(req.params.id);
  broadcast('colaborador:del', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// ── API: Marketplaces ────────────────────────────────────────
app.get('/api/marketplaces', (req, res) => {
  res.json(db.prepare('SELECT * FROM marketplaces ORDER BY nome').all());
});

app.post('/api/marketplaces', (req, res) => {
  const { nome, cor = '#00e5a0' } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  const nomeFmt = nome.trim().toUpperCase();
  try {
    const result = db.prepare('INSERT INTO marketplaces (nome, cor) VALUES (?, ?)').run(nomeFmt, cor);
    const mkt = db.prepare('SELECT * FROM marketplaces WHERE id = ?').get(result.lastInsertRowid);
    broadcast('marketplace:add', mkt);
    res.json(mkt);
  } catch (e) {
    res.status(409).json({ erro: 'Marketplace já existe.' });
  }
});

app.delete('/api/marketplaces/:id', (req, res) => {
  db.prepare('DELETE FROM marketplaces WHERE id = ?').run(req.params.id);
  broadcast('marketplace:del', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// ── API: Bipagens ────────────────────────────────────────────
app.get('/api/bipagens', (req, res) => {
  const { colab, mkt, de, ate } = req.query;
  let q = 'SELECT * FROM bipagens WHERE 1=1';
  const params = [];
  if (colab) { q += ' AND colaborador_nome = ?'; params.push(colab); }
  if (mkt)   { q += ' AND marketplace_nome = ?'; params.push(mkt); }
  if (de)    { q += ' AND date(criado_em) >= date(?)'; params.push(de); }
  if (ate)   { q += ' AND date(criado_em) <= date(?)'; params.push(ate); }
  q += ' ORDER BY criado_em DESC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/bipagens', (req, res) => {
  const { etiqueta, marketplace_id, colaborador_id } = req.body;
  if (!etiqueta || !marketplace_id || !colaborador_id)
    return res.status(400).json({ erro: 'Etiqueta, marketplace e colaborador são obrigatórios.' });

  const etiqFmt = etiqueta.trim().toUpperCase();

  // Verificar duplicata
  const dup = db.prepare('SELECT * FROM bipagens WHERE etiqueta = ?').get(etiqFmt);
  if (dup) {
    return res.status(409).json({
      erro: 'ETIQUETA DUPLICADA',
      duplicata: dup
    });
  }

  const mkt   = db.prepare('SELECT * FROM marketplaces WHERE id = ?').get(marketplace_id);
  const colab = db.prepare('SELECT * FROM colaboradores WHERE id = ?').get(colaborador_id);
  if (!mkt || !colab) return res.status(400).json({ erro: 'Marketplace ou colaborador inválido.' });

  const { data, hora } = nowBR();
  const id = uid();

  db.prepare(`
    INSERT INTO bipagens (id, etiqueta, marketplace_id, colaborador_id, marketplace_nome, colaborador_nome, data, hora)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, etiqFmt, marketplace_id, colaborador_id, mkt.nome, colab.nome, data, hora);

  const bip = db.prepare('SELECT * FROM bipagens WHERE id = ?').get(id);
  broadcast('bipagem:add', bip);
  res.json(bip);
});

app.delete('/api/bipagens/:id', (req, res) => {
  db.prepare('DELETE FROM bipagens WHERE id = ?').run(req.params.id);
  broadcast('bipagem:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── API: Pendências ──────────────────────────────────────────
app.get('/api/pendencias', (req, res) => {
  res.json(db.prepare('SELECT * FROM pendencias ORDER BY criado_em DESC').all());
});

app.post('/api/pendencias', (req, res) => {
  const { etiqueta, colaborador_nome = '', transito = '', obs = '' } = req.body;
  if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
  const { data, hora } = nowBR();
  const id = uid();
  db.prepare('INSERT INTO pendencias (id, etiqueta, colaborador_nome, transito, obs, data, hora) VALUES (?,?,?,?,?,?,?)')
    .run(id, etiqueta.trim().toUpperCase(), colaborador_nome, transito, obs, data, hora);
  const pend = db.prepare('SELECT * FROM pendencias WHERE id = ?').get(id);
  broadcast('pendencia:add', pend);
  res.json(pend);
});

app.delete('/api/pendencias/:id', (req, res) => {
  db.prepare('DELETE FROM pendencias WHERE id = ?').run(req.params.id);
  broadcast('pendencia:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── API: Retornos ────────────────────────────────────────────
app.get('/api/retornos', (req, res) => {
  res.json(db.prepare('SELECT * FROM retornos ORDER BY criado_em DESC').all());
});

app.post('/api/retornos', (req, res) => {
  const { etiqueta, motivo = '' } = req.body;
  if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
  const { data, hora } = nowBR();
  const id = uid();
  db.prepare('INSERT INTO retornos (id, etiqueta, motivo, data, hora) VALUES (?,?,?,?,?)')
    .run(id, etiqueta.trim().toUpperCase(), motivo, data, hora);
  const ret = db.prepare('SELECT * FROM retornos WHERE id = ?').get(id);
  broadcast('retorno:add', ret);
  res.json(ret);
});

app.delete('/api/retornos/:id', (req, res) => {
  db.prepare('DELETE FROM retornos WHERE id = ?').run(req.params.id);
  broadcast('retorno:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✓ Servidor rodando na porta ${PORT}`);
});
