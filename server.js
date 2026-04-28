const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ── JSON database ────────────────────────────────────────────
const DB_DIR  = path.join(__dirname, 'db');
const DB_FILE = path.join(DB_DIR, 'data.json');
fs.mkdirSync(DB_DIR, { recursive: true });

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { colaboradores:[], marketplaces:[], bipagens:[], pendencias:[], retornos:[], usuarios:[], sessoes:{} };
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Seed defaults
let db = readDB();
if (!db.usuarios) db.usuarios = [];
if (!db.sessoes)  db.sessoes  = {};

if (!db.usuarios.find(u => u.role === 'admin')) {
  db.usuarios.push({
    id: 1, username: 'admin', senha: hashSenha('admin123'),
    nome: 'Administrador', role: 'admin', criado_em: new Date().toISOString()
  });
}
if (!db.colaboradores.length) {
  db.colaboradores = ['PEDRO','VITOR','GEAN','KAUAN','GABRIEL','MURILO','LIEDSON','GUNTHER','LUIS','EDSON','EDINHO']
    .map((nome, i) => ({ id: i+1, nome, criado_em: new Date().toISOString() }));
}
if (!db.marketplaces.length) {
  db.marketplaces = [
    { id:1, nome:'SHOPEE', cor:'#ff5722' },
    { id:2, nome:'MERCADO LIVRE', cor:'#ffe600' },
    { id:3, nome:'AMAZON', cor:'#ff9900' },
    { id:4, nome:'SHEIN', cor:'#e91e8c' },
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
function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + 'bipagem_salt_2024').digest('hex');
}
function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── Auth middleware ──────────────────────────────────────────
function autenticar(req, res, next) {
  const token = req.headers['authorization'] || req.query.token;
  if (!token) return res.status(401).json({ erro: 'Não autenticado.' });
  db = readDB();
  const sessao = db.sessoes[token];
  if (!sessao) return res.status(401).json({ erro: 'Sessão inválida.' });
  const usuario = db.usuarios.find(u => u.id === sessao.usuarioId);
  if (!usuario) return res.status(401).json({ erro: 'Usuário não encontrado.' });
  req.usuario = usuario;
  req.token = token;
  next();
}

function apenasAdmin(req, res, next) {
  if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
  next();
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

// ── AUTH ROUTES ──────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, senha } = req.body;
  if (!username || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios.' });
  db = readDB();
  const usuario = db.usuarios.find(u => u.username === username.trim().toLowerCase());
  if (!usuario || usuario.senha !== hashSenha(senha))
    return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  const token = gerarToken();
  if (!db.sessoes) db.sessoes = {};
  db.sessoes[token] = { usuarioId: usuario.id, criado_em: new Date().toISOString() };
  writeDB(db);
  res.json({ token, usuario: { id: usuario.id, username: usuario.username, nome: usuario.nome, role: usuario.role } });
});

app.post('/api/logout', autenticar, (req, res) => {
  db = readDB();
  delete db.sessoes[req.token];
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/me', autenticar, (req, res) => {
  res.json({ id: req.usuario.id, username: req.usuario.username, nome: req.usuario.nome, role: req.usuario.role });
});

// ── USUÁRIOS (admin only) ────────────────────────────────────
app.get('/api/usuarios', autenticar, apenasAdmin, (req, res) => {
  db = readDB();
  res.json(db.usuarios.map(u => ({ id: u.id, username: u.username, nome: u.nome, role: u.role, criado_em: u.criado_em })));
});

app.post('/api/usuarios', autenticar, apenasAdmin, (req, res) => {
  const { username, senha, nome, role = 'user' } = req.body;
  if (!username || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios.' });
  db = readDB();
  const userFmt = username.trim().toLowerCase();
  if (db.usuarios.find(u => u.username === userFmt))
    return res.status(409).json({ erro: 'Usuário já existe.' });
  const novo = { id: Date.now(), username: userFmt, senha: hashSenha(senha), nome: nome || userFmt, role, criado_em: new Date().toISOString() };
  db.usuarios.push(novo);
  writeDB(db);
  const { senha: _, ...sem } = novo;
  broadcast('usuario:add', sem);
  res.json(sem);
});

app.put('/api/usuarios/:id/senha', autenticar, apenasAdmin, (req, res) => {
  const { senha } = req.body;
  if (!senha) return res.status(400).json({ erro: 'Nova senha obrigatória.' });
  db = readDB();
  const u = db.usuarios.find(u => u.id === parseInt(req.params.id));
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  u.senha = hashSenha(senha);
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, (req, res) => {
  db = readDB();
  const id = parseInt(req.params.id);
  const u = db.usuarios.find(u => u.id === id);
  if (u && u.role === 'admin' && db.usuarios.filter(u => u.role === 'admin').length <= 1)
    return res.status(400).json({ erro: 'Não é possível remover o único administrador.' });
  db.usuarios = db.usuarios.filter(u => u.id !== id);
  // Remover sessões do usuário
  Object.keys(db.sessoes).forEach(t => { if (db.sessoes[t].usuarioId === id) delete db.sessoes[t]; });
  writeDB(db);
  broadcast('usuario:del', { id });
  res.json({ ok: true });
});

// ── Estado inicial ───────────────────────────────────────────
app.get('/api/estado', autenticar, (req, res) => {
  db = readDB();
  res.json({
    colaboradores: db.colaboradores,
    marketplaces:  db.marketplaces,
    bipagens:      db.bipagens,
    pendencias:    db.pendencias,
    retornos:      db.retornos,
  });
});

// ── Colaboradores ────────────────────────────────────────────
app.post('/api/colaboradores', autenticar, apenasAdmin, (req, res) => {
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
  db = readDB();
  const nomeFmt = nome.trim().toUpperCase();
  if (db.colaboradores.find(c => c.nome === nomeFmt))
    return res.status(409).json({ erro: 'Colaborador já existe.' });
  const colab = { id: Date.now(), nome: nomeFmt, criado_em: new Date().toISOString() };
  db.colaboradores.push(colab);
  writeDB(db);
  broadcast('colaborador:add', colab);
  res.json(colab);
});

app.delete('/api/colaboradores/:id', autenticar, apenasAdmin, (req, res) => {
  db = readDB();
  const id = parseInt(req.params.id);
  db.colaboradores = db.colaboradores.filter(c => c.id !== id);
  writeDB(db);
  broadcast('colaborador:del', { id });
  res.json({ ok: true });
});

// ── Marketplaces ─────────────────────────────────────────────
app.post('/api/marketplaces', autenticar, apenasAdmin, (req, res) => {
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

app.delete('/api/marketplaces/:id', autenticar, apenasAdmin, (req, res) => {
  db = readDB();
  const id = parseInt(req.params.id);
  db.marketplaces = db.marketplaces.filter(m => m.id !== id);
  writeDB(db);
  broadcast('marketplace:del', { id });
  res.json({ ok: true });
});

// ── Bipagens ─────────────────────────────────────────────────
app.get('/api/bipagens', autenticar, (req, res) => {
  db = readDB();
  let list = [...db.bipagens];
  const { colab, mkt, de, ate } = req.query;
  if (colab) list = list.filter(b => b.colaborador_nome === colab);
  if (mkt)   list = list.filter(b => b.marketplace_nome === mkt);
  if (de)    list = list.filter(b => new Date(b.criado_em) >= new Date(de));
  if (ate)   list = list.filter(b => new Date(b.criado_em) <= new Date(ate + 'T23:59:59'));
  res.json(list.sort((a,b) => new Date(b.criado_em) - new Date(a.criado_em)));
});

app.post('/api/bipagens', autenticar, (req, res) => {
  const { etiqueta, marketplace_id, colaborador_id } = req.body;
  if (!etiqueta || !marketplace_id || !colaborador_id)
    return res.status(400).json({ erro: 'Etiqueta, marketplace e colaborador são obrigatórios.' });
  db = readDB();
  const etiqFmt = etiqueta.trim().toUpperCase();
  if (etiqFmt.length < 5) return res.status(400).json({ erro: 'Etiqueta inválida.' });
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
    usuario_id: req.usuario.id, usuario_nome: req.usuario.nome,
    data, hora, criado_em: new Date().toISOString()
  };
  db.bipagens.unshift(bip);
  writeDB(db);
  broadcast('bipagem:add', bip);
  res.json(bip);
});

app.delete('/api/bipagens/:id', autenticar, (req, res) => {
  db = readDB();
  db.bipagens = db.bipagens.filter(b => b.id !== req.params.id);
  writeDB(db);
  broadcast('bipagem:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Pendências ───────────────────────────────────────────────
app.post('/api/pendencias', autenticar, (req, res) => {
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

app.delete('/api/pendencias/:id', autenticar, (req, res) => {
  db = readDB();
  db.pendencias = db.pendencias.filter(p => p.id !== req.params.id);
  writeDB(db);
  broadcast('pendencia:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Retornos (remove da bipagem automaticamente) ─────────────
app.post('/api/retornos', autenticar, (req, res) => {
  const { etiqueta, motivo = '' } = req.body;
  if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
  const etiqFmt = etiqueta.trim().toUpperCase();
  if (etiqFmt.length < 5) return res.status(400).json({ erro: 'Etiqueta inválida.' });
  db = readDB();
  const { data, hora } = nowBR();
  const ret = { id: uid(), etiqueta: etiqFmt, motivo, data, hora, criado_em: new Date().toISOString() };
  db.retornos.unshift(ret);
  // Remove da bipagem automaticamente
  const bipRemovida = db.bipagens.find(b => b.etiqueta === etiqFmt);
  db.bipagens = db.bipagens.filter(b => b.etiqueta !== etiqFmt);
  writeDB(db);
  broadcast('retorno:add', ret);
  if (bipRemovida) broadcast('bipagem:del', { id: bipRemovida.id });
  res.json({ ret, bipagem_removida: bipRemovida || null });
});

app.delete('/api/retornos/:id', autenticar, (req, res) => {
  db = readDB();
  db.retornos = db.retornos.filter(r => r.id !== req.params.id);
  writeDB(db);
  broadcast('retorno:del', { id: req.params.id });
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`✓ Servidor na porta ${PORT}`));
