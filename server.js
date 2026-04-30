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

function codigoEEA() {
  return 'EEA' + Math.floor(100 + Math.random() * 900);
}

function nowBR() {
  const now = new Date();

  return {
    data: now.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo'
    }),
    hora: now.toLocaleTimeString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
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

    CREATE TABLE IF NOT EXISTS producao_pedidos (
  id TEXT PRIMARY KEY,
  produto TEXT NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 0,
  fabricante TEXT DEFAULT '',
  produzido INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'PENDENTE',
  obs TEXT DEFAULT '',
  data TEXT,
  hora TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS producao_entradas (

  id TEXT PRIMARY KEY,
  pedido_id TEXT,
  produto TEXT,
  quantidade INTEGER NOT NULL DEFAULT 0,
  obs TEXT DEFAULT '',
  data TEXT,
  hora TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS producao_fornecedores (
  id TEXT PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL,
  contato TEXT DEFAULT '',
  obs TEXT DEFAULT '',
  data TEXT,
  hora TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS producao_insumos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  fornecedor_id TEXT REFERENCES producao_fornecedores(id) ON DELETE SET NULL,
  fornecedor_nome TEXT DEFAULT '',
  unidade TEXT DEFAULT 'UN',
  valor_unitario NUMERIC(12,2) DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS producao_pedido_insumos (
  id TEXT PRIMARY KEY,
  pedido_id TEXT REFERENCES producao_pedidos(id) ON DELETE CASCADE,
  insumo_id TEXT REFERENCES producao_insumos(id) ON DELETE SET NULL,
  insumo_nome TEXT DEFAULT '',
  fornecedor_nome TEXT DEFAULT '',
  unidade TEXT DEFAULT 'UN',
  quantidade NUMERIC(12,2) DEFAULT 0,
  valor_unitario NUMERIC(12,2) DEFAULT 0,
  valor_total NUMERIC(12,2) DEFAULT 0,
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
// ── Produtividade ────────────────────────────────────────────
app.get('/api/produtividade', autenticar, async (req, res) => {
  try {
    const { dia, mes } = req.query;

    let where = [];
    let valores = [];

    if (dia) {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}`);
      valores.push(dia);
    } else if (mes) {
      const [ano, mesNum] = mes.split('-');

      where.push(`
        EXTRACT(YEAR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}
        AND EXTRACT(MONTH FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 2}
      `);

      valores.push(ano, mesNum);
    } else {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = CURRENT_DATE`);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await pool.query(`
      SELECT colaborador_nome, COUNT(*)::int AS total
      FROM bipagens
      ${whereSQL}
      GROUP BY colaborador_nome
      ORDER BY total DESC
    `, valores);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar produtividade' });
  }
});
// ── Produtividade ────────────────────────────────────────────
app.get('/api/produtividade', autenticar, async (req, res) => {
  try {
    const { dia, mes } = req.query;

    let where = [];
    let valores = [];

    if (dia) {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}`);
      valores.push(dia);
    } else if (mes) {
      const [ano, mesNum] = mes.split('-');

      where.push(`
        EXTRACT(YEAR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}
        AND EXTRACT(MONTH FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 2}
      `);

      valores.push(ano, mesNum);
    } else {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = CURRENT_DATE`);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await pool.query(`
      SELECT colaborador_nome, COUNT(*)::int AS total
      FROM bipagens
      ${whereSQL}
      GROUP BY colaborador_nome
      ORDER BY total DESC
    `, valores);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar produtividade' });
  }
});
// ── Bipagens ─────────────────────────────────────────────────
app.get('/api/produtividade', autenticar, async (req, res) => {
  try {
    const { dia, mes } = req.query;

    let where = [];
    let valores = [];

    if (dia) {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}`);
      valores.push(dia);
    } else if (mes) {
      const [ano, mesNum] = mes.split('-');

      where.push(`
        EXTRACT(YEAR FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 1}
        AND EXTRACT(MONTH FROM criado_em AT TIME ZONE 'America/Sao_Paulo') = $${valores.length + 2}
      `);

      valores.push(ano, mesNum);
    } else {
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = CURRENT_DATE`);
    }

    const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await pool.query(`
      SELECT colaborador_nome, COUNT(*)::int AS total
      FROM bipagens
      ${whereSQL}
      GROUP BY colaborador_nome
      ORDER BY total DESC
    `, valores);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar produtividade' });
  }
});
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
    if (de && !ate) {
  // filtro por DIA
  vals.push(de);
  where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${vals.length}`);
}

if (de && ate) {
  // filtro por PERÍODO (ex: mês)
  vals.push(de);
  where.push(`criado_em >= $${vals.length}::date`);

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

// ── Produção ────────────────────────────────────────────────
app.get('/api/producao', autenticar, async (req, res) => {
  try {
    const pedidos = await pool.query(`
      SELECT * FROM producao_pedidos
      ORDER BY criado_em DESC
    `);

    const entradas = await pool.query(`
      SELECT * FROM producao_entradas
      ORDER BY criado_em DESC
    `);

    res.json({
      pedidos: pedidos.rows.map(toISO),
      entradas: entradas.rows.map(toISO)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar produção.' });
  }
});

app.post('/api/producao/pedidos', autenticar, async (req, res) => {
  try {
    const { produto, quantidade, fabricante = '', obs = '' } = req.body;

    if (!produto || !quantidade) {
      return res.status(400).json({ erro: 'Produto e quantidade são obrigatórios.' });
    }

    const { data, hora } = nowBR();

    const result = await pool.query(`
      INSERT INTO producao_pedidos
      (id, produto, quantidade, fabricante, produzido, status, obs, data, hora)
      VALUES ($1,$2,$3,$4,0,'PENDENTE',$5,$6,$7)
      RETURNING *
    `, [
      codigoEEA(),
      produto.trim().toUpperCase(),
      parseInt(quantidade),
      fabricante.trim().toUpperCase(),
      obs,
      data,
      hora
    ]);

    const pedido = toISO(result.rows[0]);
    broadcast('producao:pedido:add', pedido);
    res.json(pedido);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar pedido de produção.' });
  }
});

app.post('/api/producao/entradas', autenticar, async (req, res) => {
  try {
    const { pedido_id, quantidade, obs = '' } = req.body;

    if (!pedido_id || !quantidade) {
      return res.status(400).json({ erro: 'Pedido e quantidade são obrigatórios.' });
    }

    const pedidoResult = await pool.query(
      `SELECT * FROM producao_pedidos WHERE id = $1`,
      [pedido_id]
    );

    if (pedidoResult.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    const pedido = pedidoResult.rows[0];
    const qtd = parseInt(quantidade);
    const novoProduzido = Number(pedido.produzido || 0) + qtd;

    let status = 'PARCIAL';
    if (novoProduzido >= Number(pedido.quantidade)) status = 'FINALIZADO';

    const { data, hora } = nowBR();

    const entradaResult = await pool.query(`
      INSERT INTO producao_entradas
      (id, pedido_id, produto, quantidade, obs, data, hora)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      uid(),
      pedido_id,
      pedido.produto,
      qtd,
      obs,
      data,
      hora
    ]);

    const pedidoAtualizado = await pool.query(`
      UPDATE producao_pedidos
      SET produzido = $1, status = $2
      WHERE id = $3
      RETURNING *
    `, [novoProduzido, status, pedido_id]);

    const entrada = toISO(entradaResult.rows[0]);
    const pedidoFinal = toISO(pedidoAtualizado.rows[0]);

    broadcast('producao:entrada:add', entrada);
    broadcast('producao:pedido:update', pedidoFinal);

    res.json({ entrada, pedido: pedidoFinal });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar entrada.' });
  }
});
app.delete('/api/producao/pedidos/:id', autenticar, async (req, res) => {
  try {
    const id = req.params.id;

    await pool.query(`DELETE FROM producao_entradas WHERE pedido_id = $1`, [id]);

    const result = await pool.query(
      `DELETE FROM producao_pedidos WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    broadcast('producao:pedido:del', { id });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir pedido.' });
  }
});
// ── Cadastros Produção: fornecedores e insumos ───────────────
app.get('/api/producao/cadastros', autenticar, async (req, res) => {
  try {
    const fornecedores = await pool.query(`
      SELECT * FROM producao_fornecedores ORDER BY nome ASC
    `);

    const insumos = await pool.query(`
      SELECT * FROM producao_insumos ORDER BY nome ASC, fornecedor_nome ASC
    `);

    res.json({
      fornecedores: fornecedores.rows.map(toISO),
      insumos: insumos.rows.map(toISO)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar cadastros de produção.' });
  }
});

app.post('/api/producao/fornecedores', autenticar, async (req, res) => {
  try {
    const { nome, contato = '', obs = '' } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome do fornecedor é obrigatório.' });

    const { data, hora } = nowBR();

    const result = await pool.query(`
      INSERT INTO producao_fornecedores (id, nome, contato, obs, data, hora)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      uid(),
      nome.trim().toUpperCase(),
      contato.trim(),
      obs.trim(),
      data,
      hora
    ]);

    res.json(toISO(result.rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Fornecedor já cadastrado.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cadastrar fornecedor.' });
  }
});

app.delete('/api/producao/fornecedores/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM producao_fornecedores WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir fornecedor.' });
  }
});

app.post('/api/producao/insumos', autenticar, async (req, res) => {
  try {
    const { nome, fornecedor_id, unidade = 'UN', valor_unitario = 0 } = req.body;

    if (!nome) return res.status(400).json({ erro: 'Nome do insumo é obrigatório.' });
    if (!fornecedor_id) return res.status(400).json({ erro: 'Fornecedor é obrigatório.' });

    const forn = await pool.query(
      `SELECT id, nome FROM producao_fornecedores WHERE id = $1`,
      [fornecedor_id]
    );

    if (forn.rowCount === 0) {
      return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
    }

    const result = await pool.query(`
      INSERT INTO producao_insumos
      (id, nome, fornecedor_id, fornecedor_nome, unidade, valor_unitario)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      uid(),
      nome.trim().toUpperCase(),
      fornecedor_id,
      forn.rows[0].nome,
      unidade.trim().toUpperCase(),
      Number(valor_unitario || 0)
    ]);

    res.json(toISO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao cadastrar insumo.' });
  }
});

app.delete('/api/producao/insumos/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`DELETE FROM producao_insumos WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir insumo.' });
  }
});

// ── Insumos dentro do pedido ─────────────────────────────────
app.get('/api/producao/pedidos/:id/insumos', autenticar, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM producao_pedido_insumos
      WHERE pedido_id = $1
      ORDER BY criado_em DESC
    `, [req.params.id]);

    res.json(result.rows.map(toISO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar insumos do pedido.' });
  }
});

app.post('/api/producao/pedidos/:id/insumos', autenticar, async (req, res) => {
  try {
    const { insumo_id, quantidade } = req.body;

    if (!insumo_id || !quantidade) {
      return res.status(400).json({ erro: 'Insumo e quantidade são obrigatórios.' });
    }

    const pedido = await pool.query(
      `SELECT id FROM producao_pedidos WHERE id = $1`,
      [req.params.id]
    );

    if (pedido.rowCount === 0) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    const insumo = await pool.query(
      `SELECT * FROM producao_insumos WHERE id = $1`,
      [insumo_id]
    );

    if (insumo.rowCount === 0) {
      return res.status(404).json({ erro: 'Insumo não encontrado.' });
    }

    const i = insumo.rows[0];
    const qtd = Number(quantidade);
    const valorUnit = Number(i.valor_unitario || 0);
    const total = qtd * valorUnit;

    const result = await pool.query(`
      INSERT INTO producao_pedido_insumos
      (id, pedido_id, insumo_id, insumo_nome, fornecedor_nome, unidade, quantidade, valor_unitario, valor_total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      uid(),
      req.params.id,
      i.id,
      i.nome,
      i.fornecedor_nome,
      i.unidade,
      qtd,
      valorUnit,
      total
    ]);

    res.json(toISO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao vincular insumo ao pedido.' });
  }
});

app.delete('/api/producao/pedidos/:id/insumos/:itemId', autenticar, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM producao_pedido_insumos WHERE id = $1 AND pedido_id = $2`,
      [req.params.itemId, req.params.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao remover insumo do pedido.' });
  }
});

// ── LOTES v2 (multi-produto) ──────────────────────────────────
async function initLotes() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_lote (
      id TEXT PRIMARY KEY,
      numero INTEGER NOT NULL UNIQUE,
      obs TEXT DEFAULT '',
      status TEXT DEFAULT 'aberto',
      usuario_nome TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lote_itens (
      id TEXT PRIMARY KEY,
      pedido_id TEXT REFERENCES pedidos_lote(id) ON DELETE CASCADE,
      produto_id TEXT REFERENCES estoque_produtos(id) ON DELETE SET NULL,
      produto_nome TEXT NOT NULL,
      variante TEXT NOT NULL,
      qtd_pedida INTEGER NOT NULL DEFAULT 0,
      qtd_recebida INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'aberto',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lote_insumos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT REFERENCES pedidos_lote(id) ON DELETE CASCADE,
      insumo_id TEXT REFERENCES insumos(id) ON DELETE SET NULL,
      insumo_nome TEXT NOT NULL,
      fornecedor TEXT DEFAULT '',
      valor_unitario NUMERIC(10,2) DEFAULT 0,
      quantidade NUMERIC(10,2) DEFAULT 1,
      valor_total NUMERIC(10,2) DEFAULT 0,
      data_entrega_fab DATE,
      obs TEXT DEFAULT '',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function calcStatusPedido(itens) {
  if (!itens.length) return 'aberto';
  const todos = itens.every(i => parseInt(i.qtd_recebida) >= parseInt(i.qtd_pedida));
  if (todos) return 'completo';
  const algum = itens.some(i => parseInt(i.qtd_recebida) > 0);
  const algumExc = itens.some(i => parseInt(i.qtd_recebida) > parseInt(i.qtd_pedida));
  if (algumExc && todos) return 'excedente';
  if (algumExc) return 'parcial';
  if (algum) return 'parcial';
  return 'aberto';
}

function calcStatusItem(item) {
  const rec = parseInt(item.qtd_recebida);
  const ped = parseInt(item.qtd_pedida);
  if (rec === 0) return 'aberto';
  if (rec > ped) return 'excedente';
  if (rec === ped) return 'completo';
  return 'parcial';
}

// Listar pedidos/lotes com itens
app.get('/api/estoque/lotes', autenticar, async (req, res) => {
  try {
    const pedidos = await pool.query('SELECT * FROM pedidos_lote ORDER BY numero DESC');
    const itens   = await pool.query('SELECT * FROM lote_itens ORDER BY produto_nome, variante');
    const result  = pedidos.rows.map(p => ({
      ...p,
      itens: itens.rows.filter(i => i.pedido_id === p.id)
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar pedido/lote com múltiplos itens
app.post('/api/estoque/lotes', autenticar, async (req, res) => {
  try {
    const { numero, obs = '', itens = [] } = req.body;
    if (!numero) return res.status(400).json({ erro: 'Número do lote obrigatório.' });
    if (!itens.length) return res.status(400).json({ erro: 'Adicione ao menos um produto.' });

    // Verificar duplicata de número
    const dup = await pool.query('SELECT id FROM pedidos_lote WHERE numero=$1', [parseInt(numero)]);
    if (dup.rows.length) return res.status(409).json({ erro: `Lote #${numero} já existe.` });

    const pedidoId = uid();
    await pool.query(
      'INSERT INTO pedidos_lote (id,numero,obs,status,usuario_nome) VALUES ($1,$2,$3,$4,$5)',
      [pedidoId, parseInt(numero), obs, 'aberto', req.usuario.nome]
    );

    const itemsCreated = [];
    for (const item of itens) {
      const prod = await pool.query('SELECT * FROM estoque_produtos WHERE id=$1', [item.produto_id]);
      if (!prod.rows.length) continue;
      const p = prod.rows[0];
      const itemId = uid();
      const row = await pool.query(
        'INSERT INTO lote_itens (id,pedido_id,produto_id,produto_nome,variante,qtd_pedida,qtd_recebida,status) VALUES ($1,$2,$3,$4,$5,$6,0,$7) RETURNING *',
        [itemId, pedidoId, item.produto_id, p.nome, p.variante, parseInt(item.qtd_pedida), 'aberto']
      );
      itemsCreated.push(row.rows[0]);
    }

    const pedido = await pool.query('SELECT * FROM pedidos_lote WHERE id=$1', [pedidoId]);
    const full = { ...pedido.rows[0], itens: itemsCreated };
    broadcast('estoque:lote_add', full);
    res.json(full);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Deletar lote
app.delete('/api/estoque/lotes/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM pedidos_lote WHERE id=$1', [req.params.id]);
    broadcast('estoque:lote_del', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Recalcular lote ao registrar movimento
async function recalcularLotes(produto_id, lote_numero) {
  if (!lote_numero) return;
  try {
    const pedido = await pool.query('SELECT * FROM pedidos_lote WHERE numero=$1', [parseInt(lote_numero)]);
    if (!pedido.rows.length) return;
    const p = pedido.rows[0];

    const item = await pool.query(
      'SELECT * FROM lote_itens WHERE pedido_id=$1 AND produto_id=$2',
      [p.id, produto_id]
    );
    if (!item.rows.length) return;
    const it = item.rows[0];

    // Somar entradas deste produto neste lote
    const recRes = await pool.query(`
      SELECT COALESCE(SUM(quantidade),0)::int as total
      FROM estoque_movimentos WHERE lote=$1 AND produto_id=$2 AND tipo='entrada'
    `, [parseInt(lote_numero), produto_id]);
    const qtd_recebida = recRes.rows[0].total;
    const statusItem = calcStatusItem({ qtd_pedida: it.qtd_pedida, qtd_recebida });

    await pool.query(
      'UPDATE lote_itens SET qtd_recebida=$1, status=$2 WHERE id=$3',
      [qtd_recebida, statusItem, it.id]
    );

    // Recalcular status geral do pedido
    const allItens = await pool.query('SELECT * FROM lote_itens WHERE pedido_id=$1', [p.id]);
    const statusPedido = calcStatusPedido(allItens.rows);
    await pool.query('UPDATE pedidos_lote SET status=$1 WHERE id=$2', [statusPedido, p.id]);

    const updated = await pool.query('SELECT * FROM pedidos_lote WHERE id=$1', [p.id]);
    broadcast('estoque:lote_update', { ...updated.rows[0], itens: allItens.rows });
  } catch(e) { console.error('recalcularLotes:', e.message); }
}

// Resumo geral
app.get('/api/estoque/resumo', autenticar, async (req, res) => {
  try {
    const produtos = await pool.query('SELECT * FROM estoque_produtos ORDER BY nome, variante');
    const hoje = new Date().toISOString().slice(0,10);
    const movHoje = await pool.query(`
      SELECT tipo, SUM(quantidade)::int as total
      FROM estoque_movimentos WHERE data_iso=$1 GROUP BY tipo
    `, [hoje]);
    res.json({ produtos: produtos.rows, movimentos_hoje: movHoje.rows });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Insumos do lote (pedido)
app.get('/api/lotes/:loteId/insumos', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM lote_insumos WHERE pedido_id=$1 ORDER BY criado_em ASC',
      [req.params.loteId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/lotes/:loteId/insumos', autenticar, async (req, res) => {
  try {
    const { insumo_id, insumo_nome, fornecedor, valor_unitario, quantidade, data_entrega_fab, obs } = req.body;
    if (!insumo_nome) return res.status(400).json({ erro: 'Nome do insumo obrigatório.' });
    const qtd  = parseFloat(quantidade) || 1;
    const vUnit= parseFloat(valor_unitario) || 0;
    const vTot = qtd * vUnit;
    const result = await pool.query(`
      INSERT INTO lote_insumos (id,pedido_id,insumo_id,insumo_nome,fornecedor,valor_unitario,quantidade,valor_total,data_entrega_fab,obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [uid(), req.params.loteId, insumo_id||null, insumo_nome.trim(), fornecedor||'', vUnit, qtd, vTot,
        data_entrega_fab||null, obs||'']);
    const ins = result.rows[0];
    broadcast('lote_insumo:add', ins);
    res.json(ins);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/api/lotes/:loteId/insumos/:id', autenticar, async (req, res) => {
  try {
    await pool.query('DELETE FROM lote_insumos WHERE id=$1 AND pedido_id=$2', [req.params.id, req.params.loteId]);
    broadcast('lote_insumo:del', { id: req.params.id, lote_id: req.params.loteId });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});



// ── INSUMOS (cadastro base) ───────────────────────────────────
async function initInsumos() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS insumos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      valor_unitario NUMERIC(10,2) DEFAULT 0,
      fornecedor TEXT DEFAULT '',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(nome)
    );

    CREATE TABLE IF NOT EXISTS lote_insumos (
      id TEXT PRIMARY KEY,
      lote_id TEXT REFERENCES estoque_lotes(id) ON DELETE CASCADE,
      insumo_id TEXT REFERENCES insumos(id) ON DELETE SET NULL,
      insumo_nome TEXT NOT NULL,
      fornecedor TEXT DEFAULT '',
      valor_unitario NUMERIC(10,2) DEFAULT 0,
      quantidade NUMERIC(10,2) DEFAULT 1,
      valor_total NUMERIC(10,2) DEFAULT 0,
      data_entrega_fab DATE,
      obs TEXT DEFAULT '',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// Listar insumos
app.get('/api/insumos', autenticar, async (req, res) => {
  try {
    const { q } = req.query;
    let sql = 'SELECT * FROM insumos';
    const params = [];
    if (q) { sql += ' WHERE LOWER(nome) LIKE $1'; params.push(`%${q.toLowerCase()}%`); }
    sql += ' ORDER BY nome';
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar insumo
app.post('/api/insumos', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome, valor_unitario = 0, fornecedor = '' } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
    const result = await pool.query(
      'INSERT INTO insumos (id,nome,valor_unitario,fornecedor) VALUES ($1,$2,$3,$4) RETURNING *',
      [uid(), nome.trim(), parseFloat(valor_unitario)||0, fornecedor.trim()]
    );
    const ins = result.rows[0];
    broadcast('insumo:add', ins);
    res.json(ins);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Insumo já cadastrado.' });
    res.status(500).json({ erro: e.message });
  }
});

// Atualizar insumo
app.put('/api/insumos/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome, valor_unitario, fornecedor } = req.body;
    const result = await pool.query(
      'UPDATE insumos SET nome=$1, valor_unitario=$2, fornecedor=$3 WHERE id=$4 RETURNING *',
      [nome, parseFloat(valor_unitario)||0, fornecedor||'', req.params.id]
    );
    broadcast('insumo:update', result.rows[0]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Remover insumo
app.delete('/api/insumos/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM insumos WHERE id=$1', [req.params.id]);
    broadcast('insumo:del', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar insumos de um lote
app.get('/api/lotes/:loteId/insumos', autenticar, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM lote_insumos WHERE lote_id=$1 ORDER BY criado_em ASC',
      [req.params.loteId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar insumo ao lote
app.post('/api/lotes/:loteId/insumos', autenticar, async (req, res) => {
  try {
    const { insumo_id, insumo_nome, fornecedor, valor_unitario, quantidade, data_entrega_fab, obs } = req.body;
    if (!insumo_nome) return res.status(400).json({ erro: 'Nome do insumo obrigatório.' });
    const qtd  = parseFloat(quantidade) || 1;
    const vUnit= parseFloat(valor_unitario) || 0;
    const vTot = qtd * vUnit;
    const result = await pool.query(`
      INSERT INTO lote_insumos (id,lote_id,insumo_id,insumo_nome,fornecedor,valor_unitario,quantidade,valor_total,data_entrega_fab,obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [uid(), req.params.loteId, insumo_id||null, insumo_nome.trim(), fornecedor||'', vUnit, qtd, vTot,
        data_entrega_fab||null, obs||'']);
    const ins = result.rows[0];
    broadcast('lote_insumo:add', ins);
    res.json(ins);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Remover insumo do lote
app.delete('/api/lotes/:loteId/insumos/:id', autenticar, async (req, res) => {
  try {
    await pool.query('DELETE FROM lote_insumos WHERE id=$1 AND lote_id=$2', [req.params.id, req.params.loteId]);
    broadcast('lote_insumo:del', { id: req.params.id, lote_id: req.params.loteId });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Health check / Railway ────────────────────────────────────
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.json({ status: 'online', mensagem: 'API Bipagem', data: new Date() }));

initDB()
  .then(() => initEstoque())
  .then(() => initLotes())
  .then(() => initInsumos())
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`✓ Servidor na porta ${PORT}`));
  })
  .catch(err => { console.error('❌ Erro:', err); process.exit(1); });
