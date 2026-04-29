const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ── PostgreSQL database ───────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── Helpers ──────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nowBR() {
  const now = new Date();
  return {
    data: now.toLocaleDateString('pt-BR'),
    hora: now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  };
}

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + 'bipagem_salt_2024').digest('hex');
}

function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

function toISO(row) {
  if (!row) return row;
  if (row.criado_em instanceof Date) row.criado_em = row.criado_em.toISOString();
  return row;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// ── Init database ─────────────────────────────────────────────
async function initDB() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não encontrada. No Railway, conecte o Postgres ao serviço do app em Variables > Add Variable Reference.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      nome TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS colaboradores (
      id SERIAL PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS marketplaces (
      id SERIAL PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      cor TEXT NOT NULL DEFAULT '#00e5a0',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bipagens (
      id TEXT PRIMARY KEY,
      etiqueta TEXT UNIQUE NOT NULL,
      marketplace_id INTEGER,
      marketplace_nome TEXT,
      colaborador_id INTEGER,
      colaborador_nome TEXT,
      usuario_id INTEGER,
      usuario_nome TEXT,
      data TEXT,
      hora TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bipagens_etiqueta ON bipagens(etiqueta);
    CREATE INDEX IF NOT EXISTS idx_bipagens_criado_em ON bipagens(criado_em);

    CREATE TABLE IF NOT EXISTS pendencias (
      id TEXT PRIMARY KEY,
      etiqueta TEXT NOT NULL,
      colaborador_nome TEXT DEFAULT '',
      transito TEXT DEFAULT '',
      obs TEXT DEFAULT '',
      data TEXT,
      hora TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retornos (
      id TEXT PRIMARY KEY,
      etiqueta TEXT NOT NULL,
      motivo TEXT DEFAULT '',
      data TEXT,
      hora TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const admin = await pool.query(`SELECT id FROM usuarios WHERE role = 'admin' LIMIT 1`);
  if (admin.rowCount === 0) {
    await pool.query(
      `INSERT INTO usuarios (username, senha, nome, role) VALUES ($1, $2, $3, $4)`,
      ['admin', hashSenha('admin123'), 'Administrador', 'admin']
    );
  }

  const colabs = await pool.query(`SELECT id FROM colaboradores LIMIT 1`);
  if (colabs.rowCount === 0) {
    const nomes = ['PEDRO','VITOR','GEAN','KAUAN','GABRIEL','MURILO','LIEDSON','GUNTHER','LUIS','EDSON','EDINHO'];
    for (const nome of nomes) {
      await pool.query(`INSERT INTO colaboradores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING`, [nome]);
    }
  }

  const mkts = await pool.query(`SELECT id FROM marketplaces LIMIT 1`);
  if (mkts.rowCount === 0) {
    const lista = [
      { nome: 'SHOPEE', cor: '#ff5722' },
      { nome: 'MERCADO LIVRE', cor: '#ffe600' },
      { nome: 'AMAZON', cor: '#ff9900' },
      { nome: 'SHEIN', cor: '#e91e8c' }
    ];
    for (const m of lista) {
      await pool.query(
        `INSERT INTO marketplaces (nome, cor) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING`,
        [m.nome, m.cor]
      );
    }
  }

  console.log('✅ PostgreSQL conectado e tabelas prontas');
}

// ── WebSocket broadcast ──────────────────────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

wss.on('connection', ws => ws.on('error', console.error));

// ── Middleware ───────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────────
async function autenticar(req, res, next) {
  try {
    const token = req.headers['authorization'] || req.query.token;
    if (!token) return res.status(401).json({ erro: 'Não autenticado.' });

    const result = await pool.query(`
      SELECT u.id, u.username, u.nome, u.role
      FROM sessoes s
      JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = $1
      LIMIT 1
    `, [token]);

    if (result.rowCount === 0) return res.status(401).json({ erro: 'Sessão inválida.' });

    req.usuario = result.rows[0];
    req.token = token;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno de autenticação.' });
  }
}

function apenasAdmin(req, res, next) {
  if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
  next();
}

// ── AUTH ROUTES ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, senha } = req.body;
    if (!username || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios.' });

    const userFmt = username.trim().toLowerCase();
    const result = await pool.query(`SELECT * FROM usuarios WHERE username = $1 LIMIT 1`, [userFmt]);
    const usuario = result.rows[0];

    if (!usuario || usuario.senha !== hashSenha(senha)) {
      return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
    }

    const token = gerarToken();
    await pool.query(`INSERT INTO sessoes (token, usuario_id) VALUES ($1, $2)`, [token, usuario.id]);

    res.json({
      token,
      usuario: { id: usuario.id, username: usuario.username, nome: usuario.nome, role: usuario.role }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

app.post('/api/logout', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM sessoes WHERE token = $1`, [req.token]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sair.' });
  }
});

app.get('/api/me', autenticar, (req, res) => {
  res.json({
    id: req.usuario.id,
    username: req.usuario.username,
    nome: req.usuario.nome,
    role: req.usuario.role
  });
});

// ── USUÁRIOS ─────────────────────────────────────────────────
app.get('/api/usuarios', autenticar, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, nome, role, criado_em
      FROM usuarios
      ORDER BY nome ASC
    `);
    res.json(result.rows.map(toISO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar usuários.' });
  }
});

app.post('/api/usuarios', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { username, senha, nome, role = 'user' } = req.body;
    if (!username || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios.' });

    const userFmt = username.trim().toLowerCase();
    const nomeFmt = (nome || userFmt).trim();

    const result = await pool.query(`
      INSERT INTO usuarios (username, senha, nome, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, username, nome, role, criado_em
    `, [userFmt, hashSenha(senha), nomeFmt, role]);

    const novo = toISO(result.rows[0]);
    broadcast('usuario:add', novo);
    res.json(novo);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Usuário já existe.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar usuário.' });
  }
});

app.put('/api/usuarios/:id/senha', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { senha } = req.body;
    const id = toInt(req.params.id);
    if (!senha) return res.status(400).json({ erro: 'Nova senha obrigatória.' });

    const result = await pool.query(
      `UPDATE usuarios SET senha = $1 WHERE id = $2 RETURNING id`,
      [hashSenha(senha), id]
    );

    if (result.rowCount === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    await pool.query(`DELETE FROM sessoes WHERE usuario_id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao redefinir senha.' });
  }
});

app.delete('/api/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const id = toInt(req.params.id);

    const alvo = await pool.query(`SELECT id, role FROM usuarios WHERE id = $1`, [id]);
    if (alvo.rowCount === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    if (alvo.rows[0].role === 'admin') {
      const admins = await pool.query(`SELECT COUNT(*)::int AS total FROM usuarios WHERE role = 'admin'`);
      if (admins.rows[0].total <= 1) {
        return res.status(400).json({ erro: 'Não é possível remover o único administrador.' });
      }
    }

    await pool.query(`DELETE FROM usuarios WHERE id = $1`, [id]);
    broadcast('usuario:del', { id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover usuário.' });
  }
});

// ── Estado inicial ───────────────────────────────────────────
app.get('/api/estado', autenticar, async (req, res) => {
  try {
    const [colaboradores, marketplaces, bipagens, pendencias, retornos] = await Promise.all([
      pool.query(`SELECT id, nome, criado_em FROM colaboradores ORDER BY nome ASC`),
      pool.query(`SELECT id, nome, cor, criado_em FROM marketplaces ORDER BY nome ASC`),
      pool.query(`SELECT * FROM bipagens ORDER BY criado_em DESC`),
      pool.query(`SELECT * FROM pendencias ORDER BY criado_em DESC`),
      pool.query(`SELECT * FROM retornos ORDER BY criado_em DESC`)
    ]);

    res.json({
      colaboradores: colaboradores.rows.map(toISO),
      marketplaces: marketplaces.rows.map(toISO),
      bipagens: bipagens.rows.map(toISO),
      pendencias: pendencias.rows.map(toISO),
      retornos: retornos.rows.map(toISO)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar estado inicial.' });
  }
});

// ── Colaboradores ────────────────────────────────────────────
app.post('/api/colaboradores', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });

    const nomeFmt = nome.trim().toUpperCase();
    const result = await pool.query(`
      INSERT INTO colaboradores (nome)
      VALUES ($1)
      RETURNING id, nome, criado_em
    `, [nomeFmt]);

    const colab = toISO(result.rows[0]);
    broadcast('colaborador:add', colab);
    res.json(colab);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Colaborador já existe.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar colaborador.' });
  }
});

app.delete('/api/colaboradores/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    await pool.query(`DELETE FROM colaboradores WHERE id = $1`, [id]);
    broadcast('colaborador:del', { id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover colaborador.' });
  }
});

// ── Marketplaces ─────────────────────────────────────────────
app.post('/api/marketplaces', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome, cor = '#00e5a0' } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });

    const nomeFmt = nome.trim().toUpperCase();
    const result = await pool.query(`
      INSERT INTO marketplaces (nome, cor)
      VALUES ($1, $2)
      RETURNING id, nome, cor, criado_em
    `, [nomeFmt, cor]);

    const mkt = toISO(result.rows[0]);
    broadcast('marketplace:add', mkt);
    res.json(mkt);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Marketplace já existe.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar marketplace.' });
  }
});

app.delete('/api/marketplaces/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const id = toInt(req.params.id);
    await pool.query(`DELETE FROM marketplaces WHERE id = $1`, [id]);
    broadcast('marketplace:del', { id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover marketplace.' });
  }
});

// ── Bipagens ─────────────────────────────────────────────────
app.get('/api/bipagens', autenticar, async (req, res) => {
  try {
    const { colab, mkt, de, ate } = req.query;
    const where = [];
    const vals = [];

    if (colab) {
      vals.push(colab);
      where.push(`colaborador_nome = $${vals.length}`);
    }
    if (mkt) {
      vals.push(mkt);
      where.push(`marketplace_nome = $${vals.length}`);
    }
    if (de) {
      vals.push(de);
      where.push(`criado_em >= $${vals.length}::date`);
    }
    if (ate) {
      vals.push(ate);
      where.push(`criado_em < ($${vals.length}::date + interval '1 day')`);
    }

    const sql = `SELECT * FROM bipagens ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY criado_em DESC`;
    const result = await pool.query(sql, vals);
    res.json(result.rows.map(toISO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar bipagens.' });
  }
});

app.post('/api/bipagens', autenticar, async (req, res) => {
  try {
    const { etiqueta, marketplace_id, colaborador_id } = req.body;
    if (!etiqueta || !marketplace_id || !colaborador_id) {
      return res.status(400).json({ erro: 'Etiqueta, marketplace e colaborador são obrigatórios.' });
    }

    const etiqFmt = etiqueta.trim().toUpperCase();
    if (etiqFmt.length < 5) return res.status(400).json({ erro: 'Etiqueta inválida.' });

    const dup = await pool.query(`SELECT * FROM bipagens WHERE etiqueta = $1 LIMIT 1`, [etiqFmt]);
    if (dup.rowCount > 0) {
      return res.status(409).json({ erro: 'ETIQUETA DUPLICADA', duplicata: toISO(dup.rows[0]) });
    }

    const [mktResult, colabResult] = await Promise.all([
      pool.query(`SELECT id, nome, cor FROM marketplaces WHERE id = $1`, [toInt(marketplace_id)]),
      pool.query(`SELECT id, nome FROM colaboradores WHERE id = $1`, [toInt(colaborador_id)])
    ]);

    const mkt = mktResult.rows[0];
    const colab = colabResult.rows[0];

    if (!mkt || !colab) return res.status(400).json({ erro: 'Marketplace ou colaborador inválido.' });

    const { data, hora } = nowBR();
    const bip = {
      id: uid(),
      etiqueta: etiqFmt,
      marketplace_id: mkt.id,
      marketplace_nome: mkt.nome,
      colaborador_id: colab.id,
      colaborador_nome: colab.nome,
      usuario_id: req.usuario.id,
      usuario_nome: req.usuario.nome,
      data,
      hora
    };

    const result = await pool.query(`
      INSERT INTO bipagens (
        id, etiqueta, marketplace_id, marketplace_nome,
        colaborador_id, colaborador_nome, usuario_id, usuario_nome,
        data, hora
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      bip.id, bip.etiqueta, bip.marketplace_id, bip.marketplace_nome,
      bip.colaborador_id, bip.colaborador_nome, bip.usuario_id, bip.usuario_nome,
      bip.data, bip.hora
    ]);

    const salvo = toISO(result.rows[0]);
    broadcast('bipagem:add', salvo);
    res.json(salvo);
  } catch (e) {
    if (e.code === '23505') {
      const etiqueta = (req.body.etiqueta || '').trim().toUpperCase();
      const dup = await pool.query(`SELECT * FROM bipagens WHERE etiqueta = $1 LIMIT 1`, [etiqueta]);
      return res.status(409).json({ erro: 'ETIQUETA DUPLICADA', duplicata: toISO(dup.rows[0]) });
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar bipagem.' });
  }
});

app.delete('/api/bipagens/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM bipagens WHERE id = $1`, [req.params.id]);
    broadcast('bipagem:del', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover bipagem.' });
  }
});

// ── Pendências ───────────────────────────────────────────────
app.post('/api/pendencias', autenticar, async (req, res) => {
  try {
    const { etiqueta, colaborador_nome = '', transito = '', obs = '' } = req.body;
    if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });

    const { data, hora } = nowBR();
    const result = await pool.query(`
      INSERT INTO pendencias (id, etiqueta, colaborador_nome, transito, obs, data, hora)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      uid(),
      etiqueta.trim().toUpperCase(),
      colaborador_nome,
      transito,
      obs,
      data,
      hora
    ]);

    const pend = toISO(result.rows[0]);
    broadcast('pendencia:add', pend);
    res.json(pend);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar pendência.' });
  }
});

app.delete('/api/pendencias/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM pendencias WHERE id = $1`, [req.params.id]);
    broadcast('pendencia:del', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover pendência.' });
  }
});

// ── Retornos (remove da bipagem automaticamente) ─────────────
app.post('/api/retornos', autenticar, async (req, res) => {
  try {
    const { etiqueta, motivo = '' } = req.body;
    if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });

    const etiqFmt = etiqueta.trim().toUpperCase();
    if (etiqFmt.length < 5) return res.status(400).json({ erro: 'Etiqueta inválida.' });

    const { data, hora } = nowBR();

    const retResult = await pool.query(`
      INSERT INTO retornos (id, etiqueta, motivo, data, hora)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `, [uid(), etiqFmt, motivo, data, hora]);

    const bipResult = await pool.query(`DELETE FROM bipagens WHERE etiqueta = $1 RETURNING *`, [etiqFmt]);

    const ret = toISO(retResult.rows[0]);
    const bipRemovida = bipResult.rows[0] ? toISO(bipResult.rows[0]) : null;

    broadcast('retorno:add', ret);
    if (bipRemovida) broadcast('bipagem:del', { id: bipRemovida.id });

    res.json({ ret, bipagem_removida: bipRemovida });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar retorno.' });
  }
});

app.delete('/api/retornos/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM retornos WHERE id = $1`, [req.params.id]);
    broadcast('retorno:del', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover retorno.' });
  }
});

// ── Health check / Railway ────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ── Start ────────────────────────────────────────────────────
initDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✓ Servidor rodando na porta ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Erro ao iniciar banco:', err);
    process.exit(1);
  });
