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
      tema TEXT DEFAULT 'dark',
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

    -- Produtividade: tipos de atividade com peso
    CREATE TABLE IF NOT EXISTS atividades (
      id SERIAL PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      peso NUMERIC(5,2) NOT NULL DEFAULT 1,
      ativa BOOLEAN DEFAULT TRUE,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    -- Atribuição mensal de atividade por colaborador
    CREATE TABLE IF NOT EXISTS colaborador_atividade (
      id SERIAL PRIMARY KEY,
      colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
      atividade_id INTEGER NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
      mes TEXT NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(colaborador_id, mes)
    );

    -- Meta global mensal
    CREATE TABLE IF NOT EXISTS metas_mensais (
      id SERIAL PRIMARY KEY,
      mes TEXT UNIQUE NOT NULL,
      meta_global INTEGER NOT NULL,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
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
      coletada_em TIMESTAMPTZ,
      transportadora TEXT,
      coletada_por TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bipagens_etiqueta ON bipagens(etiqueta);
    CREATE INDEX IF NOT EXISTS idx_bipagens_criado_em ON bipagens(criado_em);

    CREATE TABLE IF NOT EXISTS transportadoras (
      id SERIAL PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      ativa BOOLEAN DEFAULT TRUE,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cargas (
      id SERIAL PRIMARY KEY,
      numero INTEGER UNIQUE NOT NULL,
      transportadora TEXT NOT NULL,
      observacao TEXT DEFAULT '',
      status TEXT DEFAULT 'aberta',
      aberta_em TIMESTAMPTZ DEFAULT NOW(),
      aberta_por TEXT NOT NULL,
      fechada_em TIMESTAMPTZ,
      fechada_por TEXT,
      total_bipagens INTEGER DEFAULT 0,
      total_duplicadas INTEGER DEFAULT 0,
      total_nao_encontradas INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cargas_status ON cargas(status);
    CREATE INDEX IF NOT EXISTS idx_cargas_aberta_em ON cargas(aberta_em);

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

    -- A tabela de retornos era usada pelo sistema mas nunca era criada aqui:
    -- só existia porque alguém a criou na mão no banco. Num banco novo, a aba
    -- Retorno quebraria. Com IF NOT EXISTS, o banco atual não é tocado.
    CREATE TABLE IF NOT EXISTS retornos (
      id TEXT PRIMARY KEY,
      etiqueta TEXT NOT NULL,
      motivo TEXT DEFAULT '',
      data TEXT,
      hora TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_retornos_etiqueta ON retornos(etiqueta);
  `);

  // Migração: adicionar coluna tema se ainda não existe (bancos pré-existentes)
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tema TEXT DEFAULT 'dark'`);

  // Migração: colunas de coleta na tabela bipagens (bancos pré-existentes)
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS coletada_em TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS transportadora TEXT`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS coletada_por TEXT`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS carga_id INTEGER`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS cancelada BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS cancelada_em TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS cancelada_por TEXT`);
  await pool.query(`ALTER TABLE bipagens ADD COLUMN IF NOT EXISTS cancelamento_motivo TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bipagens_coletada_em ON bipagens(coletada_em)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bipagens_carga_id ON bipagens(carga_id)`);

  // Cleanup: remover módulo de Produção (descontinuado)
  // Ordem importante: filhos primeiro (FK), depois pais
  await pool.query(`DROP TABLE IF EXISTS producao_pedido_insumos CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS producao_entradas CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS producao_insumos CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS producao_fornecedores CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS producao_pedidos CASCADE`);

  // Seed de transportadoras padrão
  const transps = await pool.query('SELECT id FROM transportadoras LIMIT 1');
  if (transps.rowCount === 0) {
    const lista = ['Amazon Logistics','Mercado Envios','Jadlog','Loggi','Total Express','Correios','Shopee Xpress','Shein Logistics'];
    for (const nome of lista) {
      await pool.query('INSERT INTO transportadoras (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING', [nome]);
    }
    console.log('[seed] transportadoras criadas:', lista.length);
  }

  // Seed de atividades padrão
  const ativs = await pool.query('SELECT id FROM atividades LIMIT 1');
  if (ativs.rowCount === 0) {
    const lista = [
      { nome: 'Separação Normal', peso: 1.00 },
      { nome: 'KIT',              peso: 2.00 },
      { nome: 'Arrumar Galpão',   peso: 2.00 },
      { nome: 'Ajudante',         peso: 0.75 },
    ];
    for (const a of lista) {
      await pool.query('INSERT INTO atividades (nome, peso) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING', [a.nome, a.peso]);
    }
    console.log('[seed] atividades criadas:', lista.length);
  }

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

// Estoque: depois de qualquer bipagem, coleta, carga ou cancelamento, confere se a
// situação das etiquetas mudou e lança reserva ou saída. Roda depois da resposta,
// então não atrasa a bipagem. Detalhes no bloco do Gerador de Etiqueta, no fim do arquivo.
app.use((req, res, next) => {
  if (req.method !== 'GET' && /^\/api\/(bipagens|coletas|cargas|conferencia|retornos|estq\/itens)/.test(req.path)) {
    res.on('finish', () => {
      try {
        if (res.statusCode >= 400) return;
        const b = req.body || {};
        const lista = [].concat(b.etiqueta || [], Array.isArray(b.etiquetas) ? b.etiquetas : [])
          .map(x => String((x && x.etiqueta) || x || '').trim().toUpperCase()).filter(x => x.length >= 5 && x.length <= 40);
        etqAgendar(lista.length && !/estq\/itens/.test(req.path) ? lista : null);
      } catch (e) {}
    });
  }
  next();
});

// ── Auth middleware ──────────────────────────────────────────
async function autenticar(req, res, next) {
  try {
    const token = req.headers['authorization'] || req.query.token;
    if (!token) return res.status(401).json({ erro: 'Não autenticado.' });

    const result = await pool.query(`
      SELECT u.id, u.username, u.nome, u.role, u.tema
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
      usuario: { id: usuario.id, username: usuario.username, nome: usuario.nome, role: usuario.role, tema: usuario.tema || 'dark' }
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
    role: req.usuario.role,
    tema: req.usuario.tema || 'dark'
  });
});

// Atualizar tema do usuário logado
app.put('/api/me/tema', autenticar, async (req, res) => {
  try {
    const { tema } = req.body;
    const temasValidos = ['dark','grafite','midnight','claro','industria'];
    if (!tema || !temasValidos.includes(tema)) {
      return res.status(400).json({ erro: 'Tema inválido.' });
    }
    await pool.query('UPDATE usuarios SET tema=$1 WHERE id=$2', [tema, req.usuario.id]);
    res.json({ ok: true, tema });
  } catch (e) {
    console.error('PUT /api/me/tema:', e.message);
    res.status(500).json({ erro: 'Erro ao salvar tema.' });
  }
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
    // PERFORMANCE: estado inicial agora carrega só bipagens de hoje (TZ Brasil).
    // Histórico, Produtividade com filtros e Coleta carregam sob demanda via endpoints próprios.
    // Pendências/retornos continuam com janela de 30 dias (volume baixo, não trava).
    const DIAS_PEND_RET = 30;
    const [colaboradores, marketplaces, bipagens, pendencias, retornos] = await Promise.all([
      pool.query(`SELECT id, nome, criado_em FROM colaboradores ORDER BY nome ASC`),
      pool.query(`SELECT id, nome, cor, criado_em FROM marketplaces ORDER BY nome ASC`),
      pool.query(`
        SELECT * FROM bipagens
        WHERE (criado_em AT TIME ZONE 'America/Sao_Paulo')::date
            = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
        ORDER BY criado_em DESC
      `),
      pool.query(`SELECT * FROM pendencias WHERE criado_em >= NOW() - INTERVAL '${DIAS_PEND_RET} days' ORDER BY criado_em DESC`),
      pool.query(`SELECT * FROM retornos WHERE criado_em >= NOW() - INTERVAL '${DIAS_PEND_RET} days' ORDER BY criado_em DESC`)
    ]);

    res.json({
      colaboradores: colaboradores.rows.map(toISO),
      marketplaces: marketplaces.rows.map(toISO),
      bipagens: bipagens.rows.map(toISO),
      pendencias: pendencias.rows.map(toISO),
      retornos: retornos.rows.map(toISO),
      _meta: { bipagens_escopo: 'hoje', dias_pend_ret: DIAS_PEND_RET }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar estado inicial.' });
  }
});

// ── BIPAGENS (paginado, com filtros server-side) ─────────────
// Query params:
//   page (default 1), limit (default 30, max 200)
//   colab (nome), mkt (nome), de (YYYY-MM-DD), ate (YYYY-MM-DD)
//   all=1 → ignora paginação (uso interno do export CSV; cap em 100k)
app.get('/api/bipagens', autenticar, async (req, res) => {
  try {
    const page  = Math.max(1, toInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, toInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;
    const all = req.query.all === '1';

    const where = [];
    const params = [];
    let i = 1;

    if (req.query.colab) { where.push(`colaborador_nome = $${i++}`); params.push(String(req.query.colab)); }
    if (req.query.mkt)   { where.push(`marketplace_nome = $${i++}`); params.push(String(req.query.mkt));   }
    if (req.query.de)    { where.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${i++}::date`); params.push(String(req.query.de)); }
    if (req.query.ate)   { where.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${i++}::date`); params.push(String(req.query.ate)); }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalQ = await pool.query(`SELECT COUNT(*)::int AS total FROM bipagens ${whereSQL}`, params);
    const total = totalQ.rows[0].total;

    let rowsQ;
    if (all) {
      // export — cap em 100k pra não detonar a memória
      rowsQ = await pool.query(
        `SELECT * FROM bipagens ${whereSQL} ORDER BY criado_em DESC LIMIT 100000`,
        params
      );
    } else {
      rowsQ = await pool.query(
        `SELECT * FROM bipagens ${whereSQL} ORDER BY criado_em DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset]
      );
    }

    res.json({
      rows: rowsQ.rows.map(toISO),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar bipagens.' });
  }
});

// ── PRODUTIVIDADE agregada (server-side) ─────────────────────
// Retorna contagem por colaborador num período.
// Params: dia=YYYY-MM-DD (prioridade) OU mes=YYYY-MM. Sem nada = hoje.
app.get('/api/bipagens/produtividade', autenticar, async (req, res) => {
  try {
    const where = [];
    const params = [];
    let i = 1;

    if (req.query.dia) {
      where.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $${i++}::date`);
      params.push(String(req.query.dia));
    } else if (req.query.mes) {
      where.push(`to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = $${i++}`);
      params.push(String(req.query.mes));
    } else {
      where.push(`(criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`);
    }

    const whereSQL = `WHERE ${where.join(' AND ')}`;

    const totalQ = await pool.query(`SELECT COUNT(*)::int AS total FROM bipagens ${whereSQL}`, params);
    const porColabQ = await pool.query(
      `SELECT colaborador_id AS id, COALESCE(colaborador_nome, 'SEM NOME') AS nome, COUNT(*)::int AS qtd
       FROM bipagens ${whereSQL}
       GROUP BY colaborador_id, colaborador_nome
       ORDER BY qtd DESC, nome ASC`,
      params
    );

    res.json({
      total: totalQ.rows[0].total,
      por_colaborador: porColabQ.rows
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular produtividade.' });
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

// ═══════════════ LOTE POR PDF DE ETIQUETAS ═══════════════
// O PDF é lido no navegador (igual ao Importar Romaneio). Aqui chega só a lista
// de rastreios. Duas chamadas: sem 'confirmar' devolve o diagnóstico pra tela
// mostrar, com 'confirmar' grava. Nada é gravado sem o usuário ver antes.

function limparEtiquetas(lista) {
  if (!Array.isArray(lista)) return [];
  const vistas = new Set();
  const saida = [];
  for (const e of lista) {
    const s = String(e || '').trim().toUpperCase();
    if (s.length < 5) continue;
    if (vistas.has(s)) continue;   // o mesmo PDF pode repetir a etiqueta
    vistas.add(s);
    saida.push(s);
  }
  return saida;
}

// POST /api/conferencia — diz em que situação está cada etiqueta do arquivo.
// É SÓ LEITURA: nada é bipado, coletado ou cancelado por causa disso, então
// dá pra subir o mesmo PDF quantas vezes quiser.
app.post('/api/conferencia', autenticar, async (req, res) => {
  try {
    const etiquetas = limparEtiquetas(req.body && req.body.etiquetas);
    if (!etiquetas.length) return res.status(400).json({ erro: 'Nenhuma etiqueta válida no arquivo.' });

    const bipR = await pool.query(`
      SELECT etiqueta, marketplace_nome, colaborador_nome, criado_em,
             coletada_em, transportadora, coletada_por,
             COALESCE(cancelada, FALSE) AS cancelada, cancelamento_motivo
      FROM bipagens WHERE etiqueta = ANY($1::text[])
    `, [etiquetas]);
    // Da mesma etiqueta pode haver mais de um retorno ao longo do tempo;
    // o que interessa é o último.
    const retR = await pool.query(`
      SELECT DISTINCT ON (etiqueta) etiqueta, motivo, criado_em
      FROM retornos WHERE etiqueta = ANY($1::text[])
      ORDER BY etiqueta, criado_em DESC
    `, [etiquetas]);

    const bip = new Map(bipR.rows.map(r => [r.etiqueta, r]));
    const ret = new Map(retR.rows.map(r => [r.etiqueta, r]));

    const itens = etiquetas.map(et => {
      const b = bip.get(et);
      const r = ret.get(et);
      if (b && b.coletada_em) {
        return {
          etiqueta: et, situacao: 'despachada',
          // Esta data vem do arquivo da Shopee (Pickup Time / Hora da Entrega),
          // não da hora em que a planilha foi importada.
          coletada_em: b.coletada_em.toISOString(),
          transportadora: b.transportadora || '',
          marketplace: b.marketplace_nome || '', separador: b.colaborador_nome || ''
        };
      }
      // Sem bipagem e com retorno: saiu da bipagem por devolução.
      if (!b && r) {
        return {
          etiqueta: et, situacao: 'retorno',
          retorno_em: r.criado_em ? r.criado_em.toISOString() : null,
          motivo: r.motivo || ''
        };
      }
      if (b) {
        return {
          etiqueta: et,
          situacao: b.cancelada ? 'cancelada' : 'aguardando',
          bipada_em: b.criado_em ? b.criado_em.toISOString() : null,
          marketplace: b.marketplace_nome || '', separador: b.colaborador_nome || '',
          motivo: b.cancelamento_motivo || ''
        };
      }
      return { etiqueta: et, situacao: 'fora' };
    });

    const conta = s => itens.filter(i => i.situacao === s).length;
    res.json({
      total: itens.length,
      resumo: {
        despachada: conta('despachada'),
        aguardando: conta('aguardando'),
        retorno: conta('retorno'),
        cancelada: conta('cancelada'),
        fora: conta('fora')
      },
      itens
    });
  } catch (e) {
    console.error('POST /api/conferencia:', e.message);
    res.status(500).json({ erro: 'Erro ao conferir: ' + e.message });
  }
});

// POST /api/bipagens/lote — entrada em massa
app.post('/api/bipagens/lote', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const { marketplace_id, colaborador_id, confirmar } = req.body || {};
    const etiquetas = limparEtiquetas(req.body && req.body.etiquetas);
    if (!etiquetas.length) { client.release(); return res.status(400).json({ erro: 'Nenhuma etiqueta válida no arquivo.' }); }
    if (!marketplace_id || !colaborador_id) { client.release(); return res.status(400).json({ erro: 'Escolha o marketplace e o colaborador.' }); }

    const [mktR, colabR] = await Promise.all([
      client.query(`SELECT id, nome FROM marketplaces WHERE id = $1`, [toInt(marketplace_id)]),
      client.query(`SELECT id, nome FROM colaboradores WHERE id = $1`, [toInt(colaborador_id)])
    ]);
    const mkt = mktR.rows[0], colab = colabR.rows[0];
    if (!mkt || !colab) { client.release(); return res.status(400).json({ erro: 'Marketplace ou colaborador inválido.' }); }

    const jaR = await client.query(
      `SELECT etiqueta, colaborador_nome, data, hora FROM bipagens WHERE etiqueta = ANY($1::text[])`,
      [etiquetas]
    );
    const jaMap = new Map(jaR.rows.map(r => [r.etiqueta, r]));
    const novas = etiquetas.filter(e => !jaMap.has(e));
    const duplicadas = jaR.rows.map(r => ({
      etiqueta: r.etiqueta, colaborador_nome: r.colaborador_nome, data: r.data, hora: r.hora
    }));

    if (!confirmar) {
      client.release();
      return res.json({ total_lidas: etiquetas.length, novas, duplicadas, marketplace: mkt.nome, colaborador: colab.nome });
    }

    if (!novas.length) { client.release(); return res.json({ gravadas: 0, duplicadas }); }

    const { data, hora } = nowBR();
    await client.query('BEGIN');
    const salvas = [];
    for (const etiq of novas) {
      const r = await client.query(`
        INSERT INTO bipagens (id, etiqueta, marketplace_id, marketplace_nome,
          colaborador_id, colaborador_nome, usuario_id, usuario_nome, data, hora)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (etiqueta) DO NOTHING
        RETURNING *
      `, [uid(), etiq, mkt.id, mkt.nome, colab.id, colab.nome, req.usuario.id, req.usuario.nome, data, hora]);
      if (r.rows[0]) salvas.push(toISO(r.rows[0]));
    }
    await client.query('COMMIT');
    client.release();

    // Um aviso por etiqueta deixaria as outras telas travadas com 150 mensagens.
    salvas.forEach(s => broadcast('bipagem:add', s));
    res.json({ gravadas: salvas.length, duplicadas });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { client.release(); } catch {}
    console.error('bipagens/lote:', e);
    res.status(500).json({ erro: 'Erro ao gravar o lote.' });
  }
});

// POST /api/retornos/lote — saída em massa
app.post('/api/retornos/lote', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const { motivo = '', confirmar } = req.body || {};
    const etiquetas = limparEtiquetas(req.body && req.body.etiquetas);
    if (!etiquetas.length) { client.release(); return res.status(400).json({ erro: 'Nenhuma etiqueta válida no arquivo.' }); }

    const bipR = await client.query(
      `SELECT etiqueta, colaborador_nome, marketplace_nome FROM bipagens WHERE etiqueta = ANY($1::text[])`,
      [etiquetas]
    );
    const bipSet = new Set(bipR.rows.map(r => r.etiqueta));

    const retR = await client.query(
      `SELECT DISTINCT ON (etiqueta) etiqueta, data, hora FROM retornos
       WHERE etiqueta = ANY($1::text[]) ORDER BY etiqueta, criado_em DESC`,
      [etiquetas]
    );
    const retMap = new Map(retR.rows.map(r => [r.etiqueta, r]));

    const vaoVoltar = etiquetas.filter(e => bipSet.has(e));
    const naoBipadas = etiquetas.filter(e => !bipSet.has(e) && !retMap.has(e));
    const jaRetornadas = etiquetas
      .filter(e => !bipSet.has(e) && retMap.has(e))
      .map(e => ({ etiqueta: e, data: retMap.get(e).data, hora: retMap.get(e).hora }));

    if (!confirmar) {
      client.release();
      return res.json({ total_lidas: etiquetas.length, vao_voltar: vaoVoltar, nao_bipadas: naoBipadas, ja_retornadas: jaRetornadas });
    }

    if (!vaoVoltar.length) { client.release(); return res.json({ devolvidas: 0, nao_bipadas: naoBipadas, ja_retornadas: jaRetornadas }); }

    const { data, hora } = nowBR();
    await client.query('BEGIN');
    const removidas = [];
    const criados = [];
    for (const etiq of vaoVoltar) {
      const r = await client.query(
        `INSERT INTO retornos (id, etiqueta, motivo, data, hora) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [uid(), etiq, motivo, data, hora]
      );
      criados.push(toISO(r.rows[0]));
      const d = await client.query(`DELETE FROM bipagens WHERE etiqueta = $1 RETURNING id`, [etiq]);
      if (d.rows[0]) removidas.push(d.rows[0].id);
    }
    await client.query('COMMIT');
    client.release();

    criados.forEach(c => broadcast('retorno:add', c));
    removidas.forEach(id => broadcast('bipagem:del', { id }));
    res.json({ devolvidas: criados.length, nao_bipadas: naoBipadas, ja_retornadas: jaRetornadas });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    try { client.release(); } catch {}
    console.error('retornos/lote:', e);
    res.status(500).json({ erro: 'Erro ao gravar o lote de retorno.' });
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

// ── COLETA (transportadora) ───────────────────────────────────
// Lista de transportadoras
app.get('/api/transportadoras', autenticar, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM transportadoras WHERE ativa = TRUE ORDER BY nome`);
    res.json(r.rows);
  } catch (e) {
    console.error('GET /api/transportadoras:', e.message);
    res.status(500).json({ erro: 'Erro ao listar transportadoras.' });
  }
});

// Cadastrar transportadora
app.post('/api/transportadoras', autenticar, async (req, res) => {
  try {
    const nome = (req.body.nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
    const r = await pool.query(
      `INSERT INTO transportadoras (nome) VALUES ($1) ON CONFLICT (nome) DO UPDATE SET ativa=TRUE RETURNING *`,
      [nome]
    );
    broadcast('transportadora:add', r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error('POST /api/transportadoras:', e.message);
    res.status(500).json({ erro: 'Erro ao cadastrar.' });
  }
});

// Desativar transportadora
app.delete('/api/transportadoras/:id', autenticar, async (req, res) => {
  try {
    await pool.query(`UPDATE transportadoras SET ativa=FALSE WHERE id=$1`, [req.params.id]);
    broadcast('transportadora:del', { id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao remover.' });
  }
});

// Listar pedidos aguardando coleta + filtros
// query params: status=aguardando|coletado|todos · de · ate · transportadora · mkt
app.get('/api/coletas', autenticar, async (req, res) => {
  try {
    const { status = 'aguardando', de, ate, transportadora, mkt } = req.query;
    const where = [];
    const vals = [];

    if (status === 'aguardando') where.push('coletada_em IS NULL');
    else if (status === 'coletado') where.push('coletada_em IS NOT NULL');

    if (transportadora) {
      vals.push(transportadora);
      where.push(`transportadora = $${vals.length}`);
    }
    if (mkt) {
      vals.push(mkt);
      where.push(`marketplace_nome = $${vals.length}`);
    }
    if (de && !ate) {
      vals.push(de);
      where.push(`DATE(criado_em AT TIME ZONE 'America/Sao_Paulo') = $${vals.length}`);
    }
    if (de && ate) {
      vals.push(de);
      where.push(`criado_em >= $${vals.length}::date`);
      vals.push(ate);
      where.push(`criado_em < ($${vals.length}::date + interval '1 day')`);
    }

    const sql = `
      SELECT *, EXTRACT(EPOCH FROM (COALESCE(coletada_em, NOW()) - criado_em)) AS segundos_parado
      FROM bipagens
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY criado_em ASC
    `;
    const r = await pool.query(sql, vals);
    res.json(r.rows.map(row => ({
      ...toISO(row),
      coletada_em: row.coletada_em ? row.coletada_em.toISOString() : null,
      segundos_parado: parseInt(row.segundos_parado || 0)
    })));
  } catch (e) {
    console.error('GET /api/coletas:', e.message);
    res.status(500).json({ erro: 'Erro ao listar coletas.' });
  }
});

// Registrar coleta (transportadora bipou)
// PATCH /api/bipagens/:id/cancelar — marca a etiqueta como cancelada (qualquer usuário logado).
// A etiqueta CONTINUA na lista de aguardando, só deixa de contar como atrasada.
app.patch('/api/bipagens/:id/cancelar', autenticar, async (req, res) => {
  try {
    const motivo = (req.body.motivo || '').toString().trim() || null;
    const r = await pool.query(`
      UPDATE bipagens
      SET cancelada = TRUE, cancelada_em = NOW(), cancelada_por = $1, cancelamento_motivo = $2
      WHERE id = $3 AND coletada_em IS NULL
      RETURNING *, EXTRACT(EPOCH FROM (NOW() - criado_em)) AS segundos_parado
    `, [req.usuario.nome, motivo, req.params.id]);
    if (r.rowCount === 0) {
      return res.status(400).json({ erro: 'Etiqueta não encontrada ou já coletada.' });
    }
    const atualizado = { ...toISO(r.rows[0]), segundos_parado: parseInt(r.rows[0].segundos_parado || 0) };
    broadcast('bipagem:cancelada', atualizado);
    console.log(`CANCELADA: ${r.rows[0].etiqueta} por ${req.usuario.nome}${motivo ? ' — ' + motivo : ''}`);
    res.json(atualizado);
  } catch (e) {
    console.error('PATCH cancelar:', e.message);
    res.status(500).json({ erro: 'Erro ao cancelar etiqueta.' });
  }
});

// PATCH /api/bipagens/:id/reabrir — desfaz o cancelamento (volta ao fluxo normal).
app.patch('/api/bipagens/:id/reabrir', autenticar, async (req, res) => {
  try {
    const r = await pool.query(`
      UPDATE bipagens
      SET cancelada = FALSE, cancelada_em = NULL, cancelada_por = NULL, cancelamento_motivo = NULL
      WHERE id = $1
      RETURNING *, EXTRACT(EPOCH FROM (NOW() - criado_em)) AS segundos_parado
    `, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Etiqueta não encontrada.' });
    const atualizado = { ...toISO(r.rows[0]), segundos_parado: parseInt(r.rows[0].segundos_parado || 0) };
    broadcast('bipagem:reaberta', atualizado);
    console.log(`REABERTA: ${r.rows[0].etiqueta} por ${req.usuario.nome}`);
    res.json(atualizado);
  } catch (e) {
    console.error('PATCH reabrir:', e.message);
    res.status(500).json({ erro: 'Erro ao reabrir etiqueta.' });
  }
});

app.post('/api/coletas', autenticar, async (req, res) => {
  try {
    const etiqueta = (req.body.etiqueta || '').trim().toUpperCase();
    const transportadora = (req.body.transportadora || '').trim();
    if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
    if (!transportadora) return res.status(400).json({ erro: 'Selecione a transportadora.' });

    // 1) Verifica se a etiqueta foi bipada na separação
    const bipagem = await pool.query(`SELECT * FROM bipagens WHERE etiqueta = $1 LIMIT 1`, [etiqueta]);
    if (bipagem.rowCount === 0) {
      return res.status(404).json({ erro: 'NÃO_SEPARADA', mensagem: 'Esta etiqueta ainda não foi bipada na separação.' });
    }

    const b = bipagem.rows[0];

    // 2) Verifica se já foi coletada
    if (b.coletada_em) {
      return res.status(409).json({
        erro: 'JÁ_COLETADA',
        mensagem: `Esta etiqueta já foi coletada em ${new Date(b.coletada_em).toLocaleString('pt-BR')} por ${b.transportadora || '?'}.`,
        bipagem: { ...toISO(b), coletada_em: b.coletada_em.toISOString() }
      });
    }

    // 3) Marca como coletada (se estava marcada como cancelada, reabre e segue o fluxo normal)
    const estavaCancelada = !!b.cancelada;
    const r = await pool.query(`
      UPDATE bipagens
      SET coletada_em = NOW(), transportadora = $1, coletada_por = $2,
          cancelada = FALSE, cancelada_em = NULL, cancelada_por = NULL, cancelamento_motivo = NULL
      WHERE id = $3
      RETURNING *,
        EXTRACT(EPOCH FROM (coletada_em - criado_em)) AS segundos_parado
    `, [transportadora, req.usuario.nome, b.id]);

    const atualizado = {
      ...toISO(r.rows[0]),
      coletada_em: r.rows[0].coletada_em.toISOString(),
      segundos_parado: parseInt(r.rows[0].segundos_parado || 0),
      estava_cancelada: estavaCancelada
    };
    broadcast('coleta:add', atualizado);
    console.log(`POST coleta: ${etiqueta} → ${transportadora} (parado ${atualizado.segundos_parado}s)`);
    res.json(atualizado);
  } catch (e) {
    console.error('POST /api/coletas:', e.message);
    res.status(500).json({ erro: 'Erro ao registrar coleta.' });
  }
});

// Modo Carregamento — retorna sempre 200 com 'resultado' estruturado
// resultado: NAO_ENCONTRADA | DUPLICADA | OK | TROCOU_TRANSPORTADORA
app.post('/api/coletas/carregamento', autenticar, async (req, res) => {
  try {
    const etiqueta = (req.body.etiqueta || '').trim().toUpperCase();
    const transportadora = (req.body.transportadora || '').trim();
    const cargaId = req.body.carga_id ? parseInt(req.body.carga_id) : null;
    if (!etiqueta) return res.status(400).json({ erro: 'Etiqueta obrigatória.' });
    if (!transportadora) return res.status(400).json({ erro: 'Selecione a transportadora.' });

    // 1) Existe no sistema?
    const bip = await pool.query('SELECT * FROM bipagens WHERE etiqueta = $1 LIMIT 1', [etiqueta]);
    if (bip.rowCount === 0) {
      // Não grava nada, mas conta no contador da carga (não encontrada)
      if (cargaId) {
        await pool.query(`UPDATE cargas SET total_nao_encontradas = total_nao_encontradas + 1 WHERE id = $1`, [cargaId]);
      }
      return res.json({
        resultado: 'NAO_ENCONTRADA',
        etiqueta,
        mensagem: 'Etiqueta não foi bipada na separação.'
      });
    }
    const b = bip.rows[0];

    // 2) Já foi coletada? (DUPLICADA — não grava nada, só contador)
    if (b.coletada_em) {
      if (cargaId) {
        await pool.query(`UPDATE cargas SET total_duplicadas = total_duplicadas + 1 WHERE id = $1`, [cargaId]);
      }
      return res.json({
        resultado: 'DUPLICADA',
        etiqueta,
        mensagem: 'Etiqueta já foi carregada anteriormente.',
        coletada_em: b.coletada_em.toISOString(),
        coletada_por: b.coletada_por || '',
        transportadora_anterior: b.transportadora || '',
        bipagem: toISO(b)
      });
    }

    // 3) Vai marcar como coletada — verifica se a transportadora bate com a marca da etiqueta
    let transpUsada = transportadora;
    let trocou = false;

    if (b.marketplace_nome) {
      const mkt = b.marketplace_nome.toLowerCase();
      const transps = await pool.query('SELECT nome FROM transportadoras');
      const candidata = transps.rows.find(t => {
        const tn = t.nome.toLowerCase();
        return (mkt.includes('shopee') && tn.includes('shopee')) ||
               (mkt.includes('mercado') && tn.includes('mercado')) ||
               (mkt.includes('amazon') && tn.includes('amazon')) ||
               (mkt.includes('shein') && tn.includes('shein'));
      });
      if (candidata && candidata.nome !== transportadora) {
        transpUsada = candidata.nome;
        trocou = true;
      }
    }

    // 4) Grava a coleta (com carga_id se houver)
    const r = await pool.query(`
      UPDATE bipagens
      SET coletada_em = NOW(), transportadora = $1, coletada_por = $2, carga_id = $3,
          cancelada = FALSE, cancelada_em = NULL, cancelada_por = NULL, cancelamento_motivo = NULL
      WHERE id = $4
      RETURNING *,
        EXTRACT(EPOCH FROM (coletada_em - criado_em)) AS segundos_parado
    `, [transpUsada, req.usuario.nome + ' (carregamento)', cargaId, b.id]);

    // Atualiza contador da carga
    if (cargaId) {
      await pool.query(`UPDATE cargas SET total_bipagens = total_bipagens + 1 WHERE id = $1`, [cargaId]);
    }

    const atualizado = {
      ...toISO(r.rows[0]),
      coletada_em: r.rows[0].coletada_em.toISOString(),
      segundos_parado: parseInt(r.rows[0].segundos_parado || 0)
    };
    broadcast('coleta:add', atualizado);

    res.json({
      resultado: trocou ? 'TROCOU_TRANSPORTADORA' : 'OK',
      etiqueta,
      mensagem: trocou ? `Trocou para ${transpUsada}` : 'Carregada com sucesso.',
      transportadora_usada: transpUsada,
      transportadora_anterior: trocou ? transportadora : null,
      bipagem: atualizado
    });
  } catch (e) {
    console.error('POST /api/coletas/carregamento:', e.message);
    res.status(500).json({ erro: 'Erro ao processar carregamento.' });
  }
});

// ── CARGAS ───────────────────────────────────────────────────
// Lista cargas (com filtros opcionais)
// Params: ?data=YYYY-MM-DD&transportadora=...&status=aberta|finalizada
app.get('/api/cargas', autenticar, async (req, res) => {
  try {
    const { data, transportadora, status } = req.query;
    const where = [];
    const params = [];
    if (data) {
      params.push(data);
      where.push(`TO_CHAR(aberta_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') = $${params.length}`);
    }
    if (transportadora) {
      params.push(transportadora);
      where.push(`transportadora = $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const sql = `
      SELECT * FROM cargas
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY aberta_em DESC
      LIMIT 200
    `;
    const r = await pool.query(sql, params);
    res.json(r.rows.map(c => ({
      ...c,
      aberta_em: c.aberta_em.toISOString(),
      fechada_em: c.fechada_em ? c.fechada_em.toISOString() : null
    })));
  } catch (e) {
    console.error('GET /api/cargas:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Busca carga aberta atual (se houver) — UMA POR VEZ
app.get('/api/cargas/aberta', autenticar, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM cargas WHERE status = 'aberta' ORDER BY aberta_em DESC LIMIT 1`);
    if (r.rowCount === 0) return res.json(null);
    const c = r.rows[0];
    res.json({
      ...c,
      aberta_em: c.aberta_em.toISOString(),
      fechada_em: c.fechada_em ? c.fechada_em.toISOString() : null
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Detalhes de UMA carga (com lista de bipagens)
app.get('/api/cargas/:id', autenticar, async (req, res) => {
  try {
    const cargaId = parseInt(req.params.id);
    const r = await pool.query('SELECT * FROM cargas WHERE id = $1', [cargaId]);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Carga não encontrada.' });
    const c = r.rows[0];
    // Busca bipagens da carga
    const bps = await pool.query(`
      SELECT id, etiqueta, colaborador_nome, marketplace_nome, coletada_em, criado_em
      FROM bipagens
      WHERE carga_id = $1
      ORDER BY coletada_em ASC NULLS LAST
    `, [cargaId]);
    res.json({
      ...c,
      aberta_em: c.aberta_em.toISOString(),
      fechada_em: c.fechada_em ? c.fechada_em.toISOString() : null,
      bipagens: bps.rows.map(b => ({
        ...b,
        coletada_em: b.coletada_em ? b.coletada_em.toISOString() : null,
        criado_em: b.criado_em ? b.criado_em.toISOString() : null
      }))
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Abre uma nova carga
app.post('/api/cargas', autenticar, async (req, res) => {
  try {
    const transportadora = (req.body.transportadora || '').trim();
    const observacao = (req.body.observacao || '').trim();
    if (!transportadora) return res.status(400).json({ erro: 'Transportadora obrigatória.' });

    // Verifica se já existe carga aberta
    const aberta = await pool.query(`SELECT id, numero FROM cargas WHERE status = 'aberta' LIMIT 1`);
    if (aberta.rowCount > 0) {
      return res.status(400).json({
        erro: `Já existe uma carga aberta (#${aberta.rows[0].numero}). Finalize-a antes de abrir uma nova.`,
        carga_aberta_id: aberta.rows[0].id
      });
    }

    // Próximo número sequencial
    const max = await pool.query(`SELECT COALESCE(MAX(numero),0) AS m FROM cargas`);
    const numero = max.rows[0].m + 1;

    const r = await pool.query(`
      INSERT INTO cargas (numero, transportadora, observacao, status, aberta_por)
      VALUES ($1, $2, $3, 'aberta', $4)
      RETURNING *
    `, [numero, transportadora, observacao, req.usuario.nome]);

    const c = r.rows[0];
    const result = { ...c, aberta_em: c.aberta_em.toISOString(), fechada_em: null };
    broadcast('carga:abriu', result);
    res.json(result);
  } catch (e) {
    console.error('POST /api/cargas:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Finaliza uma carga
app.post('/api/cargas/:id/finalizar', autenticar, async (req, res) => {
  try {
    const cargaId = parseInt(req.params.id);
    const r = await pool.query(`
      UPDATE cargas
      SET status = 'finalizada', fechada_em = NOW(), fechada_por = $1
      WHERE id = $2 AND status = 'aberta'
      RETURNING *
    `, [req.usuario.nome, cargaId]);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Carga não encontrada ou já finalizada.' });

    const c = r.rows[0];
    const result = {
      ...c,
      aberta_em: c.aberta_em.toISOString(),
      fechada_em: c.fechada_em.toISOString()
    };
    broadcast('carga:finalizou', result);
    res.json(result);
  } catch (e) {
    console.error('POST /api/cargas/:id/finalizar:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Cancela uma carga (admin only)
app.delete('/api/cargas/:id', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Apenas admin.' });
    const cargaId = parseInt(req.params.id);
    // Desvincula bipagens
    await pool.query(`UPDATE bipagens SET carga_id = NULL WHERE carga_id = $1`, [cargaId]);
    const r = await pool.query(`UPDATE cargas SET status='cancelada' WHERE id = $1 RETURNING numero`, [cargaId]);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Carga não encontrada.' });
    broadcast('carga:cancelada', { id: cargaId, numero: r.rows[0].numero });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Importação em lote (romaneio da transportadora)
app.post('/api/coletas/lote', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const transportadora = (req.body.transportadora || '').trim();
    const etiquetas = Array.isArray(req.body.etiquetas) ? req.body.etiquetas : [];
    if (!transportadora) return res.status(400).json({ erro: 'Selecione a transportadora.' });
    if (etiquetas.length === 0) return res.status(400).json({ erro: 'Nenhuma etiqueta enviada.' });

    let coletadas = 0, jaColetadas = 0;
    const naoEncontradas = [];
    const novasColetas = [];

    await client.query('BEGIN');

    for (const item of etiquetas) {
      const et = String(item.etiqueta || '').trim().toUpperCase();
      if (!et) continue;

      // Busca a bipagem
      const r = await client.query('SELECT * FROM bipagens WHERE etiqueta = $1 LIMIT 1', [et]);
      if (r.rowCount === 0) {
        naoEncontradas.push(et);
        continue;
      }
      const b = r.rows[0];
      if (b.coletada_em) {
        jaColetadas++;
        continue;
      }
      // Atualiza com pickup_time se fornecido, senão NOW()
      const upd = await client.query(`
        UPDATE bipagens
        SET coletada_em = COALESCE($1::timestamptz, NOW()),
            transportadora = $2,
            coletada_por = $3,
            cancelada = FALSE, cancelada_em = NULL, cancelada_por = NULL, cancelamento_motivo = NULL
        WHERE id = $4
        RETURNING *,
          EXTRACT(EPOCH FROM (coletada_em - criado_em)) AS segundos_parado
      `, [item.pickup_time || null, transportadora, req.usuario.nome + ' (romaneio)', b.id]);

      coletadas++;
      novasColetas.push({
        ...toISO(upd.rows[0]),
        coletada_em: upd.rows[0].coletada_em.toISOString(),
        segundos_parado: parseInt(upd.rows[0].segundos_parado || 0)
      });
    }

    await client.query('COMMIT');

    // Broadcast em batch (1 por etiqueta processada com sucesso)
    novasColetas.forEach(nc => broadcast('coleta:add', nc));

    console.log(`POST /api/coletas/lote: ${coletadas} ok · ${jaColetadas} já coletadas · ${naoEncontradas.length} não encontradas (transp: ${transportadora})`);

    res.json({
      total: etiquetas.length,
      coletadas,
      ja_coletadas: jaColetadas,
      nao_encontradas: naoEncontradas
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /api/coletas/lote:', e.message);
    res.status(500).json({ erro: 'Erro ao importar lote: ' + e.message });
  } finally {
    client.release();
  }
});

// Desfazer coleta (caso bipou errado)
app.delete('/api/coletas/:id', autenticar, async (req, res) => {
  try {
    const r = await pool.query(`
      UPDATE bipagens
      SET coletada_em = NULL, transportadora = NULL, coletada_por = NULL
      WHERE id = $1 RETURNING *
    `, [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Não encontrada.' });
    broadcast('coleta:del', { id: req.params.id });
    res.json({ ok: true, bipagem: toISO(r.rows[0]) });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao desfazer coleta.' });
  }
});

// ── PRODUTIVIDADE: Atividades, Atribuições, Metas ─────────────

// Listar atividades
app.get('/api/atividades', autenticar, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM atividades WHERE ativa = TRUE ORDER BY peso DESC, nome');
    res.json(r.rows.map(a => ({ ...a, peso: parseFloat(a.peso) })));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar atividade
app.post('/api/atividades', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const nome = (req.body.nome || '').trim();
    const peso = parseFloat(req.body.peso);
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
    if (isNaN(peso) || peso <= 0) return res.status(400).json({ erro: 'Peso deve ser > 0.' });
    const r = await pool.query(
      `INSERT INTO atividades (nome, peso) VALUES ($1, $2)
       ON CONFLICT (nome) DO UPDATE SET peso = EXCLUDED.peso, ativa = TRUE RETURNING *`,
      [nome, peso]
    );
    const ativ = { ...r.rows[0], peso: parseFloat(r.rows[0].peso) };
    broadcast('atividade:upsert', ativ);
    res.json(ativ);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar peso da atividade
app.put('/api/atividades/:id', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const peso = parseFloat(req.body.peso);
    const nome = (req.body.nome || '').trim();
    if (isNaN(peso) || peso <= 0) return res.status(400).json({ erro: 'Peso inválido.' });
    const r = await pool.query(
      `UPDATE atividades SET peso = $1, nome = COALESCE(NULLIF($2,''), nome) WHERE id = $3 RETURNING *`,
      [peso, nome, req.params.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ erro: 'Atividade não encontrada.' });
    const ativ = { ...r.rows[0], peso: parseFloat(r.rows[0].peso) };
    broadcast('atividade:upsert', ativ);
    res.json(ativ);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Desativar atividade
app.delete('/api/atividades/:id', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    await pool.query('UPDATE atividades SET ativa = FALSE WHERE id = $1', [req.params.id]);
    broadcast('atividade:del', { id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Listar atribuições de um mês (col_atividade) — retorna lista de colaboradores com sua atividade do mês
// Param: ?mes=YYYY-MM (default: mês atual)
app.get('/api/atribuicoes', autenticar, async (req, res) => {
  try {
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const r = await pool.query(`
      SELECT c.id AS colaborador_id, c.nome AS colaborador_nome,
             ca.atividade_id, a.nome AS atividade_nome, a.peso AS atividade_peso
      FROM colaboradores c
      LEFT JOIN colaborador_atividade ca ON ca.colaborador_id = c.id AND ca.mes = $1
      LEFT JOIN atividades a ON a.id = ca.atividade_id
      ORDER BY c.nome
    `, [mes]);
    res.json({
      mes,
      atribuicoes: r.rows.map(a => ({
        colaborador_id: a.colaborador_id,
        colaborador_nome: a.colaborador_nome,
        atividade_id: a.atividade_id,
        atividade_nome: a.atividade_nome,
        atividade_peso: a.atividade_peso !== null ? parseFloat(a.atividade_peso) : null,
      }))
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atribuir atividade a um colaborador num mês (upsert)
app.post('/api/atribuicoes', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const colaborador_id = parseInt(req.body.colaborador_id);
    const atividade_id = req.body.atividade_id ? parseInt(req.body.atividade_id) : null;
    const mes = (req.body.mes || new Date().toISOString().slice(0,7)).trim();
    if (!colaborador_id) return res.status(400).json({ erro: 'colaborador_id obrigatório.' });
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido (use YYYY-MM).' });

    if (atividade_id === null) {
      // Remover atribuição
      await pool.query('DELETE FROM colaborador_atividade WHERE colaborador_id = $1 AND mes = $2', [colaborador_id, mes]);
      broadcast('atribuicao:del', { colaborador_id, mes });
      return res.json({ ok: true });
    }
    const r = await pool.query(`
      INSERT INTO colaborador_atividade (colaborador_id, atividade_id, mes)
      VALUES ($1, $2, $3)
      ON CONFLICT (colaborador_id, mes) DO UPDATE SET atividade_id = EXCLUDED.atividade_id
      RETURNING *
    `, [colaborador_id, atividade_id, mes]);
    broadcast('atribuicao:upsert', r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Listar metas mensais (todas)
app.get('/api/metas', autenticar, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM metas_mensais ORDER BY mes DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Pegar/criar meta de um mês específico
app.get('/api/metas/:mes', autenticar, async (req, res) => {
  try {
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });
    const r = await pool.query('SELECT * FROM metas_mensais WHERE mes = $1', [mes]);
    res.json(r.rows[0] || { mes, meta_global: null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Definir meta de um mês (upsert)
app.put('/api/metas/:mes', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const mes = req.params.mes;
    const meta = parseInt(req.body.meta_global);
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });
    if (!meta || meta <= 0) return res.status(400).json({ erro: 'Meta inválida.' });
    const r = await pool.query(`
      INSERT INTO metas_mensais (mes, meta_global) VALUES ($1, $2)
      ON CONFLICT (mes) DO UPDATE SET meta_global = EXCLUDED.meta_global, atualizado_em = NOW()
      RETURNING *
    `, [mes, meta]);
    broadcast('meta:upsert', r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── FECHAMENTO MENSAL ─────────────────────────────────────────

// Status do fechamento de um mês: count pendentes, count coletadas, etc.
app.get('/api/fechamento/:mes/status', autenticar, async (req, res) => {
  try {
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });

    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE coletada_em IS NOT NULL) AS coletadas,
        COUNT(*) FILTER (WHERE coletada_em IS NULL) AS pendentes,
        COUNT(*) AS total
      FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
    `, [mes]);

    const stats = r.rows[0];
    res.json({
      mes,
      total: parseInt(stats.total),
      coletadas: parseInt(stats.coletadas),
      pendentes: parseInt(stats.pendentes),
      pode_fechar: parseInt(stats.pendentes) === 0 && parseInt(stats.total) > 0
    });
  } catch (e) {
    console.error('GET /api/fechamento/:mes/status:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Lista das pendências (etiquetas bipadas no mês mas ainda não coletadas)
app.get('/api/fechamento/:mes/pendentes', autenticar, async (req, res) => {
  try {
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });

    const r = await pool.query(`
      SELECT *,
        EXTRACT(EPOCH FROM (NOW() - criado_em)) AS segundos_parado
      FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
        AND coletada_em IS NULL
      ORDER BY criado_em
    `, [mes]);

    res.json(r.rows.map(b => ({
      ...toISO(b),
      segundos_parado: parseInt(b.segundos_parado || 0)
    })));
  } catch (e) {
    console.error('GET /api/fechamento/:mes/pendentes:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Dump completo do mês (pra gerar Excel no front)
app.get('/api/fechamento/:mes/dados', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });

    // Bipagens do mês com flag de "tardia"
    const bip = await pool.query(`
      SELECT *,
        (coletada_em IS NOT NULL AND TO_CHAR(coletada_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') > $1) AS coletada_tardia
      FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
      ORDER BY criado_em
    `, [mes]);

    // Pendências/retornos do mês
    const pend = await pool.query(`
      SELECT * FROM pendencias
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
      ORDER BY criado_em
    `, [mes]);

    const ret = await pool.query(`
      SELECT * FROM retornos
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
      ORDER BY criado_em
    `, [mes]);

    // Atribuições do mês (pra ranking ponderado)
    const atrib = await pool.query(`
      SELECT c.id AS colaborador_id, c.nome AS colaborador_nome,
             a.nome AS atividade_nome, a.peso AS atividade_peso
      FROM colaboradores c
      LEFT JOIN colaborador_atividade ca ON ca.colaborador_id = c.id AND ca.mes = $1
      LEFT JOIN atividades a ON a.id = ca.atividade_id
      ORDER BY c.nome
    `, [mes]);

    const meta = await pool.query('SELECT * FROM metas_mensais WHERE mes = $1', [mes]);

    res.json({
      mes,
      bipagens: bip.rows.map(b => ({
        ...toISO(b),
        coletada_em: b.coletada_em ? b.coletada_em.toISOString() : null,
        coletada_tardia: !!b.coletada_tardia
      })),
      pendencias: pend.rows.map(toISO),
      retornos: ret.rows.map(toISO),
      atribuicoes: atrib.rows.map(a => ({
        ...a,
        atividade_peso: a.atividade_peso != null ? parseFloat(a.atividade_peso) : null
      })),
      meta: meta.rows[0] ? { ...meta.rows[0], meta_global: parseInt(meta.rows[0].meta_global) } : null
    });
  } catch (e) {
    console.error('GET /api/fechamento/:mes/dados:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Confirma o fechamento e DELETA os dados do mês (só após confirmação do front)
app.post('/api/fechamento/:mes/confirmar', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const mes = req.params.mes;
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Mês inválido.' });

    // Não deixa fechar mês corrente nem futuro
    const mesAtual = new Date().toISOString().slice(0,7);
    if (mes >= mesAtual) return res.status(400).json({ erro: 'Não é permitido fechar o mês corrente ou futuro.' });

    // Verificar se há pendências (segurança extra mesmo já checado no front)
    const chk = await client.query(`
      SELECT COUNT(*) AS pend FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
        AND coletada_em IS NULL
    `, [mes]);
    if (parseInt(chk.rows[0].pend) > 0) {
      return res.status(409).json({ erro: 'Existem etiquetas pendentes. Resolva antes de fechar.' });
    }

    await client.query('BEGIN');

    const delBip = await client.query(`
      DELETE FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
    `, [mes]);
    const delPend = await client.query(`
      DELETE FROM pendencias
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
    `, [mes]);
    const delRet = await client.query(`
      DELETE FROM retornos
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = $1
    `, [mes]);

    await client.query('COMMIT');

    console.log(`[fechamento] mês ${mes} fechado por ${req.usuario.nome}: ${delBip.rowCount} bipagens, ${delPend.rowCount} pendências, ${delRet.rowCount} retornos removidos.`);

    broadcast('fechamento:done', { mes, removidos: { bipagens: delBip.rowCount, pendencias: delPend.rowCount, retornos: delRet.rowCount } });

    res.json({
      ok: true,
      mes,
      removidos: {
        bipagens: delBip.rowCount,
        pendencias: delPend.rowCount,
        retornos: delRet.rowCount
      }
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /api/fechamento/:mes/confirmar:', e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    client.release();
  }
});

// ── OCIOSIDADE ────────────────────────────────────────────────
// Calcula gaps de ociosidade entre bipes consecutivos do mesmo colaborador
// Ignora: almoço 11h-12h30, fora do expediente 8h-17h00, fim de semana
// Param: ?data=YYYY-MM-DD (default: hoje)
app.get('/api/ociosidade/:data?', autenticar, async (req, res) => {
  try {
    if (req.usuario.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado.' });
    const dataParam = req.params.data || new Date().toISOString().slice(0,10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataParam)) {
      return res.status(400).json({ erro: 'Data inválida (use YYYY-MM-DD).' });
    }

    // Constantes do expediente (em minutos a partir de 00:00)
    const HORA_INICIO = 8 * 60;          // 480 = 08h00
    const HORA_FIM = 17 * 60;            // 1020 = 17h00
    const ALMOCO_INICIO = 11 * 60;       // 660 = 11h00
    const ALMOCO_FIM = 12 * 60 + 30;     // 750 = 12h30
    const GAP_MINIMO = 30;                // gap >= 30min entre bipes consecutivos = ociosidade
    const RITMO_IDEAL_SEG = 70;           // 70s/pedido = referência informativa

    // Tempo médio por bipe segundo o peso da atividade do colaborador no mês
    // peso 1 → 30s · peso 2 → 35s
    const SEG_POR_BIPE_PESO1 = 30;
    const SEG_POR_BIPE_PESO2 = 35;
    const BONUS_PESO2_MIN = 0;
    const EXPEDIENTE_LIQUIDO_MIN = (HORA_FIM - HORA_INICIO) - (ALMOCO_FIM - ALMOCO_INICIO); // 540 - 90 = 450min (7h30)

    // Busca todas bipagens do dia, agrupadas por colaborador
    const r = await pool.query(`
      SELECT id, etiqueta, colaborador_id, colaborador_nome, criado_em,
        (criado_em AT TIME ZONE 'America/Sao_Paulo') AS criado_em_br
      FROM bipagens
      WHERE TO_CHAR(criado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') = $1
      ORDER BY colaborador_id, criado_em
    `, [dataParam]);

    // Busca pesos do mês (atividade de cada colaborador)
    const mesAtual = dataParam.slice(0,7); // YYYY-MM
    const pesosR = await pool.query(`
      SELECT ca.colaborador_id, a.peso, a.nome AS atividade_nome
      FROM colaborador_atividade ca
      JOIN atividades a ON a.id = ca.atividade_id
      WHERE ca.mes = $1
    `, [mesAtual]);
    const pesoColabs = {};
    const atividadeColabs = {};
    pesosR.rows.forEach(row => {
      pesoColabs[row.colaborador_id] = parseFloat(row.peso);
      atividadeColabs[row.colaborador_id] = row.atividade_nome;
    });

    // Agrupa por colaborador
    const porColab = {};
    r.rows.forEach(b => {
      if (!b.colaborador_id) return;
      if (!porColab[b.colaborador_id]) {
        porColab[b.colaborador_id] = {
          colaborador_id: b.colaborador_id,
          colaborador_nome: b.colaborador_nome,
          bipagens: []
        };
      }
      // criado_em_br vem como Date com fuso ajustado
      porColab[b.colaborador_id].bipagens.push({
        id: b.id,
        criado_em: b.criado_em.toISOString(),
        minutos_dia: b.criado_em_br.getUTCHours()*60 + b.criado_em_br.getUTCMinutes() + b.criado_em_br.getUTCSeconds()/60
      });
    });

    // Calcula eventos de ociosidade pra cada colaborador
    const resultado = [];
    Object.values(porColab).forEach(colab => {
      const eventos = [];
      let totalOcioso = 0;
      const bps = colab.bipagens;

      // ── NOVA REGRA: SEM GAPS ──
      // O tempo trabalhado é calculado por bipes × peso (não depende de gaps)
      // Só mantemos o destaque informativo de "trabalho antes do expediente"

      // Identifica bipes antes do expediente (informativo)
      const bipesAntesExp = bps.filter(b => b.minutos_dia < HORA_INICIO);
      const trabalhoExtraMin = bipesAntesExp.length > 0
        ? Math.round(HORA_INICIO - bipesAntesExp[0].minutos_dia)
        : 0;

      // Registra "trabalho extra" como evento informativo (não conta como ocioso)
      if (bipesAntesExp.length > 0) {
        eventos.push({
          tipo: 'trabalho_extra',
          inicio_min: bipesAntesExp[0].minutos_dia,
          fim_min: HORA_INICIO,
          duracao_min: trabalhoExtraMin,
          inicio_str: minToHHMM(bipesAntesExp[0].minutos_dia),
          fim_str: minToHHMM(HORA_INICIO),
          extra_qtd_bipes: bipesAntesExp.length
        });
      }

      // ── FÓRMULA DOS LOTES (regra final) ──────────────────
      // Cada lote = rajada de bipes (gap > 10min separa lotes).
      // Tempo trabalhado por lote = MIN(tempo_até_próxima_rajada, cap)
      // Ociosidade = tempo_até_próxima_rajada - cap, se positivo
      // Último lote do dia: conta apenas até o último bipe (sem ociosidade após)
      const peso = pesoColabs[colab.colaborador_id] || 1;
      const ehPeso2 = peso > 1.5;
      const segPorBipe = ehPeso2 ? SEG_POR_BIPE_PESO2 : SEG_POR_BIPE_PESO1;
      const GAP_NOVO_LOTE_MIN = 10;

      let tempoTrabalhadoMin = 0;
      let qtdLotes = 0;
      const lotesDetalhe = [];
      const pausasDetalhe = [];
      if (bps.length > 0) {
        // Agrupa bipes em lotes (gap > 10min entre bipes = novo lote)
        const lotes = [[bps[0]]];
        for (let i = 1; i < bps.length; i++) {
          const gap = calcularGapEfetivo(bps[i-1].minutos_dia, bps[i].minutos_dia, ALMOCO_INICIO, ALMOCO_FIM);
          if (gap > GAP_NOVO_LOTE_MIN) {
            lotes.push([bps[i]]);
          } else {
            lotes[lotes.length-1].push(bps[i]);
          }
        }
        qtdLotes = lotes.length;

        lotes.forEach((lote, idx) => {
          const inicio = lote[0].minutos_dia;
          const fim = lote[lote.length-1].minutos_dia;
          const cap = (lote.length * segPorBipe) / 60; // cap em minutos
          const ehUltimo = idx === lotes.length - 1;

          let tempoAteProx;
          let trabalhado;
          let ociosoDoLote = 0;
          let tipoUsado;

          if (ehUltimo) {
            // Último lote do dia: conta o tempo de execução real (do 1º ao último bipe)
            // OU o cap (o que for MAIOR), porque pode ter bipado rajada
            const tempoExecucao = lote.length === 1
              ? cap
              : calcularGapEfetivo(inicio, fim, ALMOCO_INICIO, ALMOCO_FIM);
            trabalhado = Math.max(tempoExecucao, cap);
            tempoAteProx = trabalhado; // pro display
            tipoUsado = trabalhado === cap ? 'cap' : 'real';
          } else {
            // Tem próxima rajada: usa o tempo até ela
            const proxInicio = lotes[idx+1][0].minutos_dia;
            tempoAteProx = calcularGapEfetivo(inicio, proxInicio, ALMOCO_INICIO, ALMOCO_FIM);

            if (tempoAteProx <= cap) {
              // Voltou rápido: conta o tempo real (foi produtivo)
              trabalhado = tempoAteProx;
              tipoUsado = 'real';
            } else {
              // Demorou mais que o esperado: cap como trabalho, resto vira ocioso
              trabalhado = cap;
              ociosoDoLote = tempoAteProx - cap;
              tipoUsado = 'cap+ocio';
              totalOcioso += ociosoDoLote;
              // Adiciona evento de ociosidade
              const ociosoInicio = Math.round(inicio + cap);
              const ociosoFim = Math.round(inicio + tempoAteProx);
              eventos.push({
                tipo: 'gap',
                inicio_min: ociosoInicio,
                fim_min: ociosoFim,
                duracao_min: Math.round(ociosoDoLote),
                inicio_str: minToHHMM(ociosoInicio),
                fim_str: minToHHMM(ociosoFim)
              });
            }
          }

          tempoTrabalhadoMin += trabalhado;

          const cruzouAlmoco = (fim > ALMOCO_INICIO && inicio < ALMOCO_FIM);

          lotesDetalhe.push({
            n: idx + 1,
            inicio_str: minToHHMM(inicio),
            fim_str: minToHHMM(fim),
            bipes: lote.length,
            tempo_real_min: Math.round(tempoAteProx),
            cap_min: Math.round(cap),
            usado_min: Math.round(trabalhado),
            ocioso_min: Math.round(ociosoDoLote),
            tipo_usado: tipoUsado,
            cruzou_almoco: cruzouAlmoco,
            eh_ultimo: ehUltimo
          });

          // Pausa pro próximo lote (intervalo do FIM do lote até INÍCIO da rajada seguinte)
          if (idx < lotes.length - 1) {
            const proxInicio = lotes[idx+1][0].minutos_dia;
            const duracaoPausa = calcularGapEfetivo(fim, proxInicio, ALMOCO_INICIO, ALMOCO_FIM);
            pausasDetalhe.push({
              apos_lote: idx + 1,
              inicio_str: minToHHMM(fim),
              fim_str: minToHHMM(proxInicio),
              duracao_min: Math.round(duracaoPausa)
            });
          }
        });
      }
      // Limita ao expediente líquido (7h30)
      tempoTrabalhadoMin = Math.min(tempoTrabalhadoMin, EXPEDIENTE_LIQUIDO_MIN);

      // Ritmo médio (informativo)
      const ritmoSeg = (bps.length > 0 && tempoTrabalhadoMin > 0)
        ? Math.round((tempoTrabalhadoMin*60)/bps.length)
        : null;

      resultado.push({
        colaborador_id: colab.colaborador_id,
        colaborador_nome: colab.colaborador_nome,
        total_bipagens: bps.length,
        bipes_antes_expediente: bipesAntesExp.length,
        trabalho_extra_min: trabalhoExtraMin,
        eventos,
        total_ocioso_min: Math.round(totalOcioso),
        tempo_trabalhado_min: Math.round(tempoTrabalhadoMin),
        peso: peso,
        peso_categoria: ehPeso2 ? 2 : 1,
        atividade_nome: atividadeColabs[colab.colaborador_id] || (ehPeso2 ? 'KIT' : 'Separação Normal'),
        seg_por_bipe: segPorBipe,
        qtd_lotes: qtdLotes,
        lotes_detalhe: lotesDetalhe,
        pausas_detalhe: pausasDetalhe,
        ritmo_seg_por_pedido: ritmoSeg,
        ritmo_ideal_seg: RITMO_IDEAL_SEG,
        primeiro_bipe: bps.length > 0 ? minToHHMM(bps[0].minutos_dia) : null,
        ultimo_bipe: bps.length > 0 ? minToHHMM(bps[bps.length-1].minutos_dia) : null
      });
    });

    resultado.sort((a,b)=>b.tempo_trabalhado_min - a.tempo_trabalhado_min);

    res.json({
      data: dataParam,
      colaboradores: resultado,
      config: {
        hora_inicio: '08:00',
        hora_fim: '17:00',
        almoco_inicio: '11:00',
        almoco_fim: '12:30',
        gap_minimo_min: GAP_MINIMO,
        ritmo_ideal_seg: RITMO_IDEAL_SEG
      }
    });
  } catch (e) {
    console.error('GET /api/ociosidade:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Helper: calcula gap efetivo entre dois pontos do dia (em minutos),
// descontando interseção com a janela de almoço.
function calcularGapEfetivo(inicio, fim, almocoInicio, almocoFim) {
  if (fim <= inicio) return 0;
  // Interseção com almoço
  const overlapStart = Math.max(inicio, almocoInicio);
  const overlapEnd = Math.min(fim, almocoFim);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  return Math.max(0, fim - inicio - overlap);
}

// Helper: converte minutos do dia em "HH:MM"
function minToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

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

async function initEstoque() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estoque_produtos (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      variante TEXT NOT NULL,
      saldo_atual INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(nome, variante)
    );

    CREATE TABLE IF NOT EXISTS estoque_movimentos (
      id TEXT PRIMARY KEY,
      produto_id TEXT REFERENCES estoque_produtos(id) ON DELETE CASCADE,
      produto_nome TEXT NOT NULL,
      variante TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('entrada','saida')),
      quantidade INTEGER NOT NULL,
      saldo_apos INTEGER NOT NULL,
      lote INTEGER,
      obs TEXT DEFAULT '',
      data TEXT NOT NULL,
      data_iso DATE NOT NULL,
      usuario_nome TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed produtos
  const produtosBase = [
    { nome: "COMBO E&A (DULCE)",          variante: "BRANCO" },
    { nome: "COMBO E&A (DULCE)",          variante: "OFF WHITE" },
    { nome: "COMBO E&A (DULCE)",          variante: "NATURE PRETO" },
    { nome: "BALCÃO COOKTOP FLÓRIDA",     variante: "BRANCO" },
    { nome: "BALCÃO COOKTOP FLÓRIDA",     variante: "PRETO" },
    { nome: "BALCÃO COOKTOP NEW (MONACO)",variante: "BRANCO" },
    { nome: "BALCÃO COOKTOP NEW (MONACO)",variante: "PRETO" },
    { nome: "COMBO 2 MÓDULOS",            variante: "BRANCO" },
    { nome: "COMBO 2 MÓDULOS",            variante: "PRETO / NATURE" },
    { nome: "COMBO 2 MÓDULOS",            variante: "NATURE / OFF" },
    { nome: "PENTEADEIRA NEW",            variante: "BRANCA" },
    { nome: "PENTEADEIRA NEW",            variante: "OFF / NATURE" },
    { nome: "PENTEADEIRA NEW",            variante: "PRETA / NATURE" },
  ];

  for (const p of produtosBase) {
    await pool.query(`
      INSERT INTO estoque_produtos (id, nome, variante, saldo_atual)
      VALUES ($1, $2, $3, 0)
      ON CONFLICT (nome, variante) DO NOTHING
    `, [uid(), p.nome, p.variante]);
  }

  // Seed movimentos da planilha
  const movSeed = [{"data": "20/10/2025", "data_iso": "2025-10-20", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 300, "saida": 0, "saldo": 300, "lote": 1896, "obs": ""}, {"data": "20/10/2025", "data_iso": "2025-10-20", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 700, "saida": 0, "saldo": 700, "lote": 1896, "obs": ""}, {"data": "30/10/2025", "data_iso": "2025-10-30", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 350, "saida": 0, "saldo": 350, "lote": 1914, "obs": ""}, {"data": "30/10/2025", "data_iso": "2025-10-30", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 350, "saida": 0, "saldo": 350, "lote": 1914, "obs": ""}, {"data": "30/10/2025", "data_iso": "2025-10-30", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 350, "saida": 0, "saldo": 350, "lote": 1914, "obs": ""}, {"data": "10/11/2025", "data_iso": "2025-11-10", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 66, "saldo": 284, "lote": 1914, "obs": ""}, {"data": "10/11/2025", "data_iso": "2025-11-10", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 74, "saldo": 276, "lote": 1914, "obs": ""}, {"data": "10/11/2025", "data_iso": "2025-11-10", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 69, "saldo": 281, "lote": 1914, "obs": ""}, {"data": "13/11/2025", "data_iso": "2025-11-13", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 66, "saldo": 218, "lote": 1914, "obs": ""}, {"data": "13/11/2025", "data_iso": "2025-11-13", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 66, "saldo": 210, "lote": 1914, "obs": ""}, {"data": "13/11/2025", "data_iso": "2025-11-13", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 66, "saldo": 215, "lote": 1914, "obs": ""}, {"data": "18/11/2025", "data_iso": "2025-11-18", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 99, "saldo": 119, "lote": 1914, "obs": ""}, {"data": "24/11/2025", "data_iso": "2025-11-24", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 119, "saldo": 0, "lote": 1914, "obs": ""}, {"data": "24/11/2025", "data_iso": "2025-11-24", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 132, "saldo": 78, "lote": 1914, "obs": ""}, {"data": "25/11/2025", "data_iso": "2025-11-25", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 700, "saida": 0, "saldo": 700, "lote": 1971, "obs": ""}, {"data": "25/11/2025", "data_iso": "2025-11-25", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 378, "lote": 1971, "obs": ""}, {"data": "26/11/2025", "data_iso": "2025-11-26", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 66, "saldo": 312, "lote": 1914, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 150, "saldo": 550, "lote": 1971, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 60, "saldo": 252, "lote": 1971, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 132, "saldo": 83, "lote": 1914, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 100, "saida": 0, "saldo": 100, "lote": 1982, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 100, "saida": 0, "saldo": 100, "lote": 1982, "obs": ""}, {"data": "28/11/2025", "data_iso": "2025-11-28", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 100, "saida": 0, "saldo": 100, "lote": 1982, "obs": ""}, {"data": "01/12/2025", "data_iso": "2025-12-01", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 264, "saldo": 286, "lote": 1971, "obs": ""}, {"data": "02/12/2025", "data_iso": "2025-12-02", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 66, "saldo": 220, "lote": 1971, "obs": ""}, {"data": "04/12/2025", "data_iso": "2025-12-04", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 159, "saldo": 61, "lote": 1971, "obs": ""}, {"data": "04/12/2025", "data_iso": "2025-12-04", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 159, "saldo": 93, "lote": 1971, "obs": ""}, {"data": "08/12/2025", "data_iso": "2025-12-08", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 150, "saida": 0, "saldo": 150, "lote": 1992, "obs": ""}, {"data": "08/12/2025", "data_iso": "2025-12-08", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 150, "saida": 0, "saldo": 150, "lote": 1992, "obs": ""}, {"data": "09/12/2025", "data_iso": "2025-12-09", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 1000, "saida": 0, "saldo": 1061, "lote": 1996, "obs": ""}, {"data": "09/12/2025", "data_iso": "2025-12-09", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 393, "lote": 1996, "obs": ""}, {"data": "09/12/2025", "data_iso": "2025-12-09", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 300, "saida": 0, "saldo": 383, "lote": 1996, "obs": ""}, {"data": "10/12/2025", "data_iso": "2025-12-10", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 800, "saida": 0, "saldo": 1861, "lote": 1997, "obs": ""}, {"data": "10/12/2025", "data_iso": "2025-12-10", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 550, "saida": 0, "saldo": 943, "lote": 1997, "obs": ""}, {"data": "10/12/2025", "data_iso": "2025-12-10", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 250, "saida": 0, "saldo": 633, "lote": 1997, "obs": ""}, {"data": "12/12/2025", "data_iso": "2025-12-12", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 30, "saldo": 913, "lote": 1996, "obs": ""}, {"data": "12/12/2025", "data_iso": "2025-12-12", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 66, "saldo": 567, "lote": 1996, "obs": ""}, {"data": "12/12/2025", "data_iso": "2025-12-12", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 71, "saldo": 29, "lote": null, "obs": ""}, {"data": "12/12/2025", "data_iso": "2025-12-12", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 74, "saldo": 26, "lote": null, "obs": ""}, {"data": "12/12/2025", "data_iso": "2025-12-12", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 48, "saldo": 52, "lote": null, "obs": ""}, {"data": "15/12/2025", "data_iso": "2025-12-15", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 597, "saldo": 1264, "lote": 1996, "obs": ""}, {"data": "15/12/2025", "data_iso": "2025-12-15", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 90, "saldo": 823, "lote": 1996, "obs": ""}, {"data": "16/12/2025", "data_iso": "2025-12-16", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 90, "saldo": 1174, "lote": 1996, "obs": ""}, {"data": "16/12/2025", "data_iso": "2025-12-16", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 150, "saldo": 673, "lote": 1996, "obs": ""}, {"data": "16/12/2025", "data_iso": "2025-12-16", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 45, "saldo": 655, "lote": 1896, "obs": ""}, {"data": "16/12/2025", "data_iso": "2025-12-16", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 66, "saldo": 84, "lote": 1992, "obs": ""}, {"data": "16/12/2025", "data_iso": "2025-12-16", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 110, "saldo": 40, "lote": 1992, "obs": ""}, {"data": "17/12/2025", "data_iso": "2025-12-17", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 240, "saldo": 934, "lote": 1996, "obs": ""}, {"data": "17/12/2025", "data_iso": "2025-12-17", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 29, "saldo": 644, "lote": 1996, "obs": ""}, {"data": "18/12/2025", "data_iso": "2025-12-18", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 44, "saldo": 890, "lote": 1996, "obs": ""}, {"data": "18/12/2025", "data_iso": "2025-12-18", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 60, "saldo": 507, "lote": 1996, "obs": ""}, {"data": "18/12/2025", "data_iso": "2025-12-18", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 135, "saldo": 165, "lote": 1896, "obs": ""}, {"data": "18/12/2025", "data_iso": "2025-12-18", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 270, "saldo": 385, "lote": 1896, "obs": ""}, {"data": "18/12/2025", "data_iso": "2025-12-18", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 44, "saldo": 40, "lote": 1992, "obs": ""}, {"data": "19/12/2025", "data_iso": "2025-12-19", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 800, "saida": 0, "saldo": 1690, "lote": 2031, "obs": ""}, {"data": "20/12/2025", "data_iso": "2025-12-20", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 180, "saldo": 1510, "lote": 1997, "obs": ""}, {"data": "21/12/2025", "data_iso": "2025-12-21", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 32, "saldo": 8, "lote": 1992, "obs": ""}, {"data": "21/12/2025", "data_iso": "2025-12-21", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 212, "saldo": -172, "lote": 1992, "obs": ""}, {"data": "22/12/2025", "data_iso": "2025-12-22", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 182, "saldo": 203, "lote": 1896, "obs": ""}, {"data": "22/12/2025", "data_iso": "2025-12-22", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 400, "saida": 0, "saldo": 408, "lote": 1998, "obs": ""}, {"data": "22/12/2025", "data_iso": "2025-12-22", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 600, "saida": 0, "saldo": 428, "lote": 1998, "obs": ""}, {"data": "23/12/2025", "data_iso": "2025-12-23", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 60, "saldo": 1450, "lote": 1997, "obs": ""}, {"data": "23/12/2025", "data_iso": "2025-12-23", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 240, "saldo": 404, "lote": 1997, "obs": ""}, {"data": "23/12/2025", "data_iso": "2025-12-23", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 174, "saldo": 333, "lote": 1996, "obs": ""}, {"data": "23/12/2025", "data_iso": "2025-12-23", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 107, "saldo": 301, "lote": 1998, "obs": ""}, {"data": "23/12/2025", "data_iso": "2025-12-23", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 320, "saldo": 108, "lote": 1998, "obs": ""}, {"data": "24/12/2025", "data_iso": "2025-12-24", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 40, "saldo": 293, "lote": 1997, "obs": ""}, {"data": "26/12/2025", "data_iso": "2025-12-26", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 550, "saida": 0, "saldo": 954, "lote": 2037, "obs": ""}, {"data": "26/12/2025", "data_iso": "2025-12-26", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 250, "saida": 0, "saldo": 543, "lote": 2037, "obs": ""}, {"data": "28/12/2025", "data_iso": "2025-12-28", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 540, "saldo": 910, "lote": 1997, "obs": ""}, {"data": "29/12/2025", "data_iso": "2025-12-29", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 30, "saldo": 880, "lote": 1971, "obs": ""}, {"data": "29/12/2025", "data_iso": "2025-12-29", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 306, "saldo": 648, "lote": 1997, "obs": ""}, {"data": "29/12/2025", "data_iso": "2025-12-29", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 60, "saldo": 483, "lote": 1997, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 22, "saldo": 858, "lote": 1996, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 69, "saldo": 414, "lote": 1914, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 155, "saldo": 10, "lote": 1896, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 194, "saldo": 9, "lote": 1896, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 5, "lote": 1982, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 24, "saldo": 2, "lote": 1982, "obs": ""}, {"data": "30/12/2025", "data_iso": "2025-12-30", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 43, "saldo": 9, "lote": 1982, "obs": ""}, {"data": "08/01/2026", "data_iso": "2026-01-08", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 381, "saldo": 477, "lote": 2023, "obs": ""}, {"data": "08/01/2026", "data_iso": "2026-01-08", "produto": "PENTEADEIRA NEW", "variante": "BRANCA", "entrada": 400, "saida": 0, "saldo": 400, "lote": 2026, "obs": ""}, {"data": "08/01/2026", "data_iso": "2026-01-08", "produto": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "entrada": 1000, "saida": 0, "saldo": 1000, "lote": 2026, "obs": ""}, {"data": "08/01/2026", "data_iso": "2026-01-08", "produto": "PENTEADEIRA NEW", "variante": "PRETA / NATURE", "entrada": 400, "saida": 0, "saldo": 400, "lote": 2026, "obs": ""}, {"data": "09/01/2026", "data_iso": "2026-01-09", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 600, "saida": 215, "saldo": 862, "lote": 2023, "obs": ""}, {"data": "09/01/2026", "data_iso": "2026-01-09", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 200, "saida": 198, "saldo": 650, "lote": 2023, "obs": ""}, {"data": "09/01/2026", "data_iso": "2026-01-09", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 198, "saldo": 416, "lote": 2023, "obs": ""}, {"data": "09/01/2026", "data_iso": "2026-01-09", "produto": "PENTEADEIRA NEW", "variante": "BRANCA", "entrada": 0, "saida": 240, "saldo": 160, "lote": 2026, "obs": ""}, {"data": "12/01/2026", "data_iso": "2026-01-12", "produto": "PENTEADEIRA NEW", "variante": "BRANCA", "entrada": 0, "saida": 120, "saldo": 40, "lote": 2026, "obs": ""}, {"data": "12/01/2026", "data_iso": "2026-01-12", "produto": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "entrada": 0, "saida": 880, "saldo": 120, "lote": 2026, "obs": ""}, {"data": "12/01/2026", "data_iso": "2026-01-12", "produto": "PENTEADEIRA NEW", "variante": "PRETA / NATURE", "entrada": 0, "saida": 240, "saldo": 160, "lote": 2026, "obs": ""}, {"data": "14/01/2026", "data_iso": "2026-01-14", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 144, "saldo": -139, "lote": 2022, "obs": ""}, {"data": "14/01/2026", "data_iso": "2026-01-14", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 96, "saldo": -87, "lote": 2022, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 600, "saida": 0, "saldo": 1462, "lote": 2024, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 26, "saida": 0, "saldo": 676, "lote": 2082, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 0, "saldo": 616, "lote": 2024, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 400, "saida": 144, "saldo": 117, "lote": 2022, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 300, "saida": 0, "saldo": 302, "lote": null, "obs": ""}, {"data": "15/01/2026", "data_iso": "2026-01-15", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 300, "saida": 192, "saldo": 21, "lote": 2022, "obs": ""}, {"data": "16/01/2026", "data_iso": "2026-01-16", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 200, "saida": 0, "saldo": 876, "lote": 2024, "obs": ""}, {"data": "16/01/2026", "data_iso": "2026-01-16", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 264, "saldo": 38, "lote": 2022, "obs": ""}, {"data": "16/01/2026", "data_iso": "2026-01-16", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 72, "saldo": -51, "lote": 2022, "obs": ""}, {"data": "19/01/2026", "data_iso": "2026-01-19", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 168, "saldo": 1294, "lote": 2024, "obs": ""}, {"data": "19/01/2026", "data_iso": "2026-01-19", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 120, "saldo": 756, "lote": 2024, "obs": ""}, {"data": "20/01/2026", "data_iso": "2026-01-20", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 600, "saida": 192, "saldo": 1702, "lote": 2025, "obs": ""}, {"data": "20/01/2026", "data_iso": "2026-01-20", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 200, "saida": 0, "saldo": 956, "lote": 2025, "obs": ""}, {"data": "20/01/2026", "data_iso": "2026-01-20", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 0, "saldo": 816, "lote": 2025, "obs": ""}, {"data": "20/01/2026", "data_iso": "2026-01-20", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 1, "saldo": 107, "lote": 1992, "obs": ""}, {"data": "21/01/2026", "data_iso": "2026-01-21", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 26, "saldo": 930, "lote": 2085, "obs": ""}, {"data": "21/01/2026", "data_iso": "2026-01-21", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 24, "saldo": 792, "lote": 1997, "obs": ""}, {"data": "22/01/2026", "data_iso": "2026-01-22", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 74, "saldo": 856, "lote": 2024, "obs": ""}, {"data": "23/01/2026", "data_iso": "2026-01-23", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 96, "saldo": 1606, "lote": 2025, "obs": ""}, {"data": "23/01/2026", "data_iso": "2026-01-23", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 72, "saldo": 784, "lote": 2025, "obs": ""}, {"data": "27/01/2026", "data_iso": "2026-01-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 400, "saida": 0, "saldo": 701, "lote": 2021, "obs": ""}, {"data": "27/01/2026", "data_iso": "2026-01-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 600, "saida": 0, "saldo": 707, "lote": 2021, "obs": ""}, {"data": "27/01/2026", "data_iso": "2026-01-27", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 400, "saida": 0, "saldo": 517, "lote": 2049, "obs": ""}, {"data": "29/01/2026", "data_iso": "2026-01-29", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 48, "saldo": 1558, "lote": 2025, "obs": ""}, {"data": "29/01/2026", "data_iso": "2026-01-29", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 48, "saldo": 736, "lote": 2025, "obs": ""}, {"data": "29/01/2026", "data_iso": "2026-01-29", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 397, "lote": 2049, "obs": ""}, {"data": "29/01/2026", "data_iso": "2026-01-29", "produto": "PENTEADEIRA NEW", "variante": "BRANCA", "entrada": 0, "saida": 37, "saldo": 3, "lote": 2026, "obs": ""}, {"data": "29/01/2026", "data_iso": "2026-01-29", "produto": "PENTEADEIRA NEW", "variante": "PRETA / NATURE", "entrada": 0, "saida": 34, "saldo": 126, "lote": 2026, "obs": ""}, {"data": "02/02/2026", "data_iso": "2026-02-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 72, "saldo": 629, "lote": 2021, "obs": ""}, {"data": "02/02/2026", "data_iso": "2026-02-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 144, "saldo": 563, "lote": 2021, "obs": ""}, {"data": "04/02/2026", "data_iso": "2026-02-04", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 132, "saldo": 1926, "lote": 2086, "obs": ""}, {"data": "04/02/2026", "data_iso": "2026-02-04", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 200, "saida": 198, "saldo": 738, "lote": 2086, "obs": ""}, {"data": "04/02/2026", "data_iso": "2026-02-04", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 66, "saldo": 926, "lote": 2086, "obs": ""}, {"data": "04/02/2026", "data_iso": "2026-02-04", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 200, "saida": 0, "saldo": 829, "lote": 2096, "obs": ""}, {"data": "04/02/2026", "data_iso": "2026-02-04", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 300, "saida": 0, "saldo": 863, "lote": 2096, "obs": ""}, {"data": "05/02/2026", "data_iso": "2026-02-05", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 132, "saldo": 1794, "lote": 2086, "obs": ""}, {"data": "05/02/2026", "data_iso": "2026-02-05", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 66, "saldo": 672, "lote": 2086, "obs": ""}, {"data": "06/02/2026", "data_iso": "2026-02-06", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 165, "saldo": 1629, "lote": 2086, "obs": ""}, {"data": "06/02/2026", "data_iso": "2026-02-06", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 144, "saldo": 685, "lote": 2096, "obs": ""}, {"data": "07/02/2026", "data_iso": "2026-02-07", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 1605, "lote": 2025, "obs": ""}, {"data": "07/02/2026", "data_iso": "2026-02-07", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 661, "lote": 2021, "obs": ""}, {"data": "09/02/2026", "data_iso": "2026-02-09", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 96, "saldo": 1509, "lote": 2025, "obs": ""}, {"data": "09/02/2026", "data_iso": "2026-02-09", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 972, "lote": 2097, "obs": ""}, {"data": "09/02/2026", "data_iso": "2026-02-09", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 2, "saldo": 36, "lote": 2022, "obs": ""}, {"data": "09/02/2026", "data_iso": "2026-02-09", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 22, "saldo": -73, "lote": 2022, "obs": ""}, {"data": "10/02/2026", "data_iso": "2026-02-10", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 10, "saldo": 1999, "lote": 2097, "obs": ""}, {"data": "10/02/2026", "data_iso": "2026-02-10", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 69, "saldo": 903, "lote": 2025, "obs": ""}, {"data": "10/02/2026", "data_iso": "2026-02-10", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 0, "saldo": 1126, "lote": 2097, "obs": ""}, {"data": "10/02/2026", "data_iso": "2026-02-10", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 263, "saldo": 134, "lote": 2049, "obs": ""}, {"data": "11/02/2026", "data_iso": "2026-02-11", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 1975, "lote": 2024, "obs": ""}, {"data": "11/02/2026", "data_iso": "2026-02-11", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 3, "saldo": 900, "lote": 2024, "obs": ""}, {"data": "12/02/2026", "data_iso": "2026-02-12", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 1855, "lote": 2025, "obs": ""}, {"data": "12/02/2026", "data_iso": "2026-02-12", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 33, "saldo": 867, "lote": 2086, "obs": ""}, {"data": "12/02/2026", "data_iso": "2026-02-12", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 600, "saida": 0, "saldo": 734, "lote": 2078, "obs": ""}, {"data": "13/02/2026", "data_iso": "2026-02-13", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 47, "saldo": 1808, "lote": 2086, "obs": ""}, {"data": "13/02/2026", "data_iso": "2026-02-13", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 510, "lote": 2090, "obs": ""}, {"data": "13/02/2026", "data_iso": "2026-02-13", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 500, "saida": 0, "saldo": 509, "lote": 2090, "obs": ""}, {"data": "13/02/2026", "data_iso": "2026-02-13", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 336, "saldo": 398, "lote": 2078, "obs": ""}, {"data": "14/02/2026", "data_iso": "2026-02-14", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 270, "saldo": 1538, "lote": 2097, "obs": ""}, {"data": "15/02/2026", "data_iso": "2026-02-15", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 192, "saldo": 1346, "lote": 2024, "obs": ""}, {"data": "17/02/2026", "data_iso": "2026-02-17", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 136, "saldo": 374, "lote": 2090, "obs": ""}, {"data": "17/02/2026", "data_iso": "2026-02-17", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 150, "saldo": 511, "lote": 2021, "obs": ""}, {"data": "17/02/2026", "data_iso": "2026-02-17", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 144, "saldo": 254, "lote": 2078, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 1226, "lote": 2097, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 150, "saldo": 717, "lote": 2097, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 49, "saldo": 462, "lote": 2021, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 600, "saida": 0, "saldo": 854, "lote": 2100, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 200, "saida": 0, "saldo": 236, "lote": 2100, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 200, "saida": 0, "saldo": 127, "lote": 2100, "obs": ""}, {"data": "18/02/2026", "data_iso": "2026-02-18", "produto": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "entrada": 0, "saida": 60, "saldo": 60, "lote": 2026, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 1726, "lote": 2099, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 120, "saldo": 897, "lote": 2099, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 0, "saldo": 1326, "lote": 2099, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 48, "saldo": 806, "lote": 2078, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 72, "saldo": 164, "lote": 2100, "obs": ""}, {"data": "19/02/2026", "data_iso": "2026-02-19", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 192, "saldo": -65, "lote": 2100, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 270, "saldo": 1456, "lote": 2099, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 150, "saldo": 747, "lote": 2097, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 68, "saldo": 441, "lote": 2090, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 49, "saldo": 413, "lote": 2021, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 24, "saldo": 839, "lote": 2021, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 782, "lote": 2100, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 21, "saldo": -86, "lote": 2022, "obs": ""}, {"data": "20/02/2026", "data_iso": "2026-02-20", "produto": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "entrada": 0, "saida": 49, "saldo": 11, "lote": 2026, "obs": ""}, {"data": "21/02/2026", "data_iso": "2026-02-21", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 60, "saldo": 1396, "lote": 2097, "obs": ""}, {"data": "21/02/2026", "data_iso": "2026-02-21", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 136, "saldo": 747, "lote": 2099, "obs": ""}, {"data": "21/02/2026", "data_iso": "2026-02-21", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 96, "saldo": 686, "lote": 2100, "obs": ""}, {"data": "21/02/2026", "data_iso": "2026-02-21", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 48, "saldo": 116, "lote": 2100, "obs": ""}, {"data": "21/02/2026", "data_iso": "2026-02-21", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 7, "saldo": -93, "lote": 2100, "obs": ""}, {"data": "22/02/2026", "data_iso": "2026-02-22", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 72, "saldo": 1324, "lote": 2024, "obs": ""}, {"data": "22/02/2026", "data_iso": "2026-02-22", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 216, "saldo": 470, "lote": 2100, "obs": ""}, {"data": "23/02/2026", "data_iso": "2026-02-23", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 68, "saldo": 306, "lote": 2090, "obs": ""}, {"data": "23/02/2026", "data_iso": "2026-02-23", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 68, "saldo": 373, "lote": 2090, "obs": ""}, {"data": "25/02/2026", "data_iso": "2026-02-25", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 102, "saldo": 271, "lote": 2090, "obs": ""}, {"data": "25/02/2026", "data_iso": "2026-02-25", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 389, "lote": 2096, "obs": ""}, {"data": "25/02/2026", "data_iso": "2026-02-25", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 24, "saldo": 815, "lote": 2096, "obs": ""}, {"data": "25/02/2026", "data_iso": "2026-02-25", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 24, "saldo": 92, "lote": 2100, "obs": ""}, {"data": "26/02/2026", "data_iso": "2026-02-26", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 48, "saldo": 341, "lote": 2021, "obs": ""}, {"data": "26/02/2026", "data_iso": "2026-02-26", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 72, "saldo": 743, "lote": 2021, "obs": ""}, {"data": "26/02/2026", "data_iso": "2026-02-26", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 446, "lote": 2100, "obs": ""}, {"data": "26/02/2026", "data_iso": "2026-02-26", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 22, "saldo": 70, "lote": 2022, "obs": ""}, {"data": "27/02/2026", "data_iso": "2026-02-27", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 194, "saldo": 1130, "lote": 2099, "obs": ""}, {"data": "27/02/2026", "data_iso": "2026-02-27", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 60, "saldo": 551, "lote": 2099, "obs": ""}, {"data": "27/02/2026", "data_iso": "2026-02-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 13, "saldo": 328, "lote": 1998, "obs": ""}, {"data": "27/02/2026", "data_iso": "2026-02-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 77, "saldo": 666, "lote": 2096, "obs": ""}, {"data": "27/02/2026", "data_iso": "2026-02-27", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 24, "saldo": 46, "lote": 2100, "obs": ""}, {"data": "28/02/2026", "data_iso": "2026-02-28", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 90, "saldo": 1040, "lote": 2024, "obs": ""}, {"data": "28/02/2026", "data_iso": "2026-02-28", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 304, "lote": 2096, "obs": ""}, {"data": "28/02/2026", "data_iso": "2026-02-28", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 139, "saldo": 527, "lote": 2021, "obs": ""}, {"data": "01/03/2026", "data_iso": "2026-03-01", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 46, "saldo": 994, "lote": 2097, "obs": ""}, {"data": "01/03/2026", "data_iso": "2026-03-01", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 9, "saldo": 295, "lote": 2021, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 1494, "lote": 2102, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 851, "lote": 2102, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 200, "saida": 0, "saldo": 1526, "lote": 2102, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 238, "saldo": 33, "lote": 2090, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 250, "saida": 0, "saldo": 545, "lote": 2101, "obs": ""}, {"data": "02/03/2026", "data_iso": "2026-03-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 250, "saida": 0, "saldo": 777, "lote": 2101, "obs": ""}, {"data": "03/03/2026", "data_iso": "2026-03-03", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 210, "saldo": 1284, "lote": 2102, "obs": ""}, {"data": "03/03/2026", "data_iso": "2026-03-03", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 270, "saldo": 581, "lote": 2102, "obs": ""}, {"data": "03/03/2026", "data_iso": "2026-03-03", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 242, "saldo": 303, "lote": 2101, "obs": ""}, {"data": "03/03/2026", "data_iso": "2026-03-03", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 216, "saldo": 230, "lote": 2100, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 240, "saldo": 1044, "lote": 2102, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 180, "saldo": 1346, "lote": 2102, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 806, "lote": 2085, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 500, "saida": 0, "saldo": 533, "lote": 2085, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 38, "saldo": 739, "lote": 2096, "obs": ""}, {"data": "04/03/2026", "data_iso": "2026-03-04", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 72, "saldo": 158, "lote": 2078, "obs": ""}, {"data": "05/03/2026", "data_iso": "2026-03-05", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 54, "saldo": 990, "lote": 2024, "obs": ""}, {"data": "05/03/2026", "data_iso": "2026-03-05", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 30, "saldo": 551, "lote": 2102, "obs": ""}, {"data": "05/03/2026", "data_iso": "2026-03-05", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 24, "saldo": 1322, "lote": 2024, "obs": ""}, {"data": "05/03/2026", "data_iso": "2026-03-05", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 250, "saldo": 489, "lote": 2101, "obs": ""}, {"data": "06/03/2026", "data_iso": "2026-03-06", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 18, "saldo": 972, "lote": 2099, "obs": ""}, {"data": "06/03/2026", "data_iso": "2026-03-06", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 200, "saldo": 1122, "lote": 2099, "obs": ""}, {"data": "07/03/2026", "data_iso": "2026-03-07", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 30, "saldo": 942, "lote": 2102, "obs": ""}, {"data": "07/03/2026", "data_iso": "2026-03-07", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 106, "saldo": 1016, "lote": 2025, "obs": ""}, {"data": "08/03/2026", "data_iso": "2026-03-08", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 120, "saldo": 896, "lote": 2097, "obs": ""}, {"data": "09/03/2026", "data_iso": "2026-03-09", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 145, "saldo": 751, "lote": 2024, "obs": ""}, {"data": "09/03/2026", "data_iso": "2026-03-09", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 134, "lote": 2100, "obs": ""}, {"data": "09/03/2026", "data_iso": "2026-03-09", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 31, "saldo": 15, "lote": 2100, "obs": ""}, {"data": "09/03/2026", "data_iso": "2026-03-09", "produto": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "entrada": 0, "saida": 12, "saldo": -1, "lote": 2026, "obs": ""}, {"data": "10/03/2026", "data_iso": "2026-03-10", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 72, "saldo": 679, "lote": 2025, "obs": ""}, {"data": "10/03/2026", "data_iso": "2026-03-10", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 6, "saldo": 128, "lote": 2049, "obs": ""}, {"data": "10/03/2026", "data_iso": "2026-03-10", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 12, "saldo": 3, "lote": 2022, "obs": ""}, {"data": "11/03/2026", "data_iso": "2026-03-11", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 66, "saldo": 613, "lote": 2086, "obs": ""}, {"data": "11/03/2026", "data_iso": "2026-03-11", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 400, "saida": 0, "saldo": 528, "lote": 2172, "obs": ""}, {"data": "11/03/2026", "data_iso": "2026-03-11", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 1, "saldo": 2, "lote": 1982, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 22, "saldo": 920, "lote": 2097, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 8, "saldo": 543, "lote": 1971, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 64, "saldo": 549, "lote": 2086, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 170, "saldo": 636, "lote": 2090, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 408, "lote": 2172, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 48, "saldo": -46, "lote": 2172, "obs": ""}, {"data": "12/03/2026", "data_iso": "2026-03-12", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 120, "saldo": -213, "lote": 2172, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 30, "saldo": 890, "lote": 2102, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 9, "saldo": 534, "lote": 2025, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 24, "saldo": 525, "lote": 2025, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 144, "saldo": 264, "lote": 2172, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 200, "saida": 72, "saldo": 82, "lote": 2172, "obs": ""}, {"data": "13/03/2026", "data_iso": "2026-03-13", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 200, "saida": 70, "saldo": -83, "lote": 2172, "obs": ""}, {"data": "14/03/2026", "data_iso": "2026-03-14", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 10, "saldo": 880, "lote": 1996, "obs": ""}, {"data": "14/03/2026", "data_iso": "2026-03-14", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 24, "saldo": 501, "lote": 2024, "obs": ""}, {"data": "15/03/2026", "data_iso": "2026-03-15", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 10, "saldo": 870, "lote": 1997, "obs": ""}, {"data": "15/03/2026", "data_iso": "2026-03-15", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 90, "saldo": 411, "lote": 2097, "obs": ""}, {"data": "16/03/2026", "data_iso": "2026-03-16", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 7, "saldo": 404, "lote": 2024, "obs": ""}, {"data": "16/03/2026", "data_iso": "2026-03-16", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 72, "saldo": 417, "lote": 2096, "obs": ""}, {"data": "16/03/2026", "data_iso": "2026-03-16", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 109, "saldo": 155, "lote": 2172, "obs": ""}, {"data": "16/03/2026", "data_iso": "2026-03-16", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 79, "saldo": 3, "lote": 2172, "obs": ""}, {"data": "17/03/2026", "data_iso": "2026-03-17", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 48, "saldo": 369, "lote": 2021, "obs": ""}, {"data": "18/03/2026", "data_iso": "2026-03-18", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 20, "saldo": 135, "lote": 2172, "obs": ""}, {"data": "18/03/2026", "data_iso": "2026-03-18", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 10, "saldo": -93, "lote": 2172, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 4, "saldo": 866, "lote": 2023, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 2, "saldo": 402, "lote": 2023, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 1, "saldo": 635, "lote": 1896, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 66, "saldo": 467, "lote": 1717, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 72, "saldo": 297, "lote": 2021, "obs": ""}, {"data": "19/03/2026", "data_iso": "2026-03-19", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 3, "saldo": -96, "lote": 1982, "obs": ""}, {"data": "20/03/2026", "data_iso": "2026-03-20", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 300, "saldo": 566, "lote": 2176, "obs": ""}, {"data": "20/03/2026", "data_iso": "2026-03-20", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 4, "saldo": 631, "lote": 1715, "obs": ""}, {"data": "20/03/2026", "data_iso": "2026-03-20", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 24, "saldo": 273, "lote": 2096, "obs": ""}, {"data": "21/03/2026", "data_iso": "2026-03-21", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 24, "saldo": 249, "lote": 2101, "obs": ""}, {"data": "22/03/2026", "data_iso": "2026-03-22", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 1066, "lote": 2178, "obs": ""}, {"data": "22/03/2026", "data_iso": "2026-03-22", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 834, "lote": 2178, "obs": ""}, {"data": "22/03/2026", "data_iso": "2026-03-22", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 300, "saida": 0, "saldo": 435, "lote": 2179, "obs": ""}, {"data": "22/03/2026", "data_iso": "2026-03-22", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 100, "saida": 0, "saldo": 103, "lote": 2179, "obs": ""}, {"data": "22/03/2026", "data_iso": "2026-03-22", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 400, "saida": 0, "saldo": 304, "lote": 2179, "obs": ""}, {"data": "23/03/2026", "data_iso": "2026-03-23", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 600, "saida": 0, "saldo": 1666, "lote": 2176, "obs": ""}, {"data": "23/03/2026", "data_iso": "2026-03-23", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 200, "saida": 0, "saldo": 1034, "lote": 2176, "obs": ""}, {"data": "23/03/2026", "data_iso": "2026-03-23", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 49, "saldo": 54, "lote": 2179, "obs": ""}, {"data": "23/03/2026", "data_iso": "2026-03-23", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 288, "saldo": 16, "lote": 2179, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 180, "saldo": 1486, "lote": 2176, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 180, "saldo": 854, "lote": 2176, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 136, "saldo": 495, "lote": 2090, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 136, "saldo": 331, "lote": 2085, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 72, "saldo": 177, "lote": 2096, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 192, "saldo": 243, "lote": 2179, "obs": ""}, {"data": "24/03/2026", "data_iso": "2026-03-24", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 51, "saldo": 3, "lote": 2179, "obs": ""}, {"data": "25/03/2026", "data_iso": "2026-03-25", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 420, "saldo": 1066, "lote": 2178, "obs": ""}, {"data": "25/03/2026", "data_iso": "2026-03-25", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 24, "saldo": 219, "lote": 2179, "obs": ""}, {"data": "25/03/2026", "data_iso": "2026-03-25", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 24, "saldo": -8, "lote": 2179, "obs": ""}, {"data": "26/03/2026", "data_iso": "2026-03-26", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 20, "saldo": 1046, "lote": 2176, "obs": ""}, {"data": "26/03/2026", "data_iso": "2026-03-26", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 169, "saldo": 685, "lote": 2178, "obs": ""}, {"data": "26/03/2026", "data_iso": "2026-03-26", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 58, "saldo": 119, "lote": 2021, "obs": ""}, {"data": "26/03/2026", "data_iso": "2026-03-26", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 48, "saldo": 171, "lote": 2179, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 64, "saldo": 982, "lote": 2178, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 120, "saldo": 565, "lote": 2176, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 68, "saldo": 427, "lote": 2085, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 70, "saldo": 261, "lote": 2085, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 30, "saldo": 141, "lote": 2179, "obs": ""}, {"data": "27/03/2026", "data_iso": "2026-03-27", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 88, "saldo": -96, "lote": 2179, "obs": ""}, {"data": "28/03/2026", "data_iso": "2026-03-28", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 5, "saldo": 977, "lote": 2178, "obs": ""}, {"data": "28/03/2026", "data_iso": "2026-03-28", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 121, "saldo": 444, "lote": 2178, "obs": ""}, {"data": "30/03/2026", "data_iso": "2026-03-30", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 1000, "saida": 0, "saldo": 1977, "lote": 2187, "obs": ""}, {"data": "30/03/2026", "data_iso": "2026-03-30", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 600, "saida": 0, "saldo": 1044, "lote": 2187, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 420, "saldo": 1557, "lote": 2187, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 68, "saldo": 359, "lote": 2085, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 68, "saldo": 193, "lote": 2085, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 300, "saida": 0, "saldo": 441, "lote": 2177, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 200, "saida": 0, "saldo": 203, "lote": 2177, "obs": ""}, {"data": "31/03/2026", "data_iso": "2026-03-31", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 300, "saida": 0, "saldo": 204, "lote": null, "obs": ""}, {"data": "01/04/2026", "data_iso": "2026-04-01", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 30, "saldo": 1527, "lote": 2187, "obs": ""}, {"data": "01/04/2026", "data_iso": "2026-04-01", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 275, "saldo": 166, "lote": 2177, "obs": ""}, {"data": "01/04/2026", "data_iso": "2026-04-01", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 48, "saldo": 156, "lote": 2177, "obs": ""}, {"data": "02/04/2026", "data_iso": "2026-04-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 803, "lote": 2183, "obs": ""}, {"data": "02/04/2026", "data_iso": "2026-04-02", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 250, "saida": 0, "saldo": 369, "lote": null, "obs": ""}, {"data": "02/04/2026", "data_iso": "2026-04-02", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 96, "saldo": 60, "lote": 2177, "obs": ""}, {"data": "03/04/2026", "data_iso": "2026-04-03", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 7, "saldo": 796, "lote": 2101, "obs": ""}, {"data": "04/04/2026", "data_iso": "2026-04-04", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 4, "saldo": 792, "lote": 1992, "obs": ""}, {"data": "05/04/2026", "data_iso": "2026-04-05", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 192, "saldo": 600, "lote": 2220, "obs": ""}, {"data": "06/04/2026", "data_iso": "2026-04-06", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 211, "saldo": 1316, "lote": 2187, "obs": ""}, {"data": "06/04/2026", "data_iso": "2026-04-06", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 185, "saldo": 415, "lote": 2220, "obs": ""}, {"data": "06/04/2026", "data_iso": "2026-04-06", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 21, "saldo": 145, "lote": 2177, "obs": ""}, {"data": "06/04/2026", "data_iso": "2026-04-06", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 168, "saldo": 35, "lote": 2177, "obs": ""}, {"data": "06/04/2026", "data_iso": "2026-04-06", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 146, "saldo": -86, "lote": 2177, "obs": ""}, {"data": "07/04/2026", "data_iso": "2026-04-07", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 270, "saldo": 774, "lote": 2187, "obs": ""}, {"data": "08/04/2026", "data_iso": "2026-04-08", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 213, "saldo": 1103, "lote": 2187, "obs": ""}, {"data": "08/04/2026", "data_iso": "2026-04-08", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 210, "saldo": 564, "lote": 2187, "obs": ""}, {"data": "08/04/2026", "data_iso": "2026-04-08", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 250, "saida": 0, "saldo": 665, "lote": 2184, "obs": ""}, {"data": "09/04/2026", "data_iso": "2026-04-09", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 122, "saldo": 981, "lote": 2187, "obs": ""}, {"data": "09/04/2026", "data_iso": "2026-04-09", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 120, "saldo": 444, "lote": 2187, "obs": ""}, {"data": "09/04/2026", "data_iso": "2026-04-09", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 110, "saldo": 555, "lote": 2220, "obs": ""}, {"data": "09/04/2026", "data_iso": "2026-04-09", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 250, "saida": 0, "saldo": 619, "lote": 2184, "obs": ""}, {"data": "09/04/2026", "data_iso": "2026-04-09", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 5, "saldo": 140, "lote": 1982, "obs": ""}, {"data": "10/04/2026", "data_iso": "2026-04-10", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 9, "saldo": 972, "lote": 2178, "obs": ""}, {"data": "10/04/2026", "data_iso": "2026-04-10", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 144, "saldo": 475, "lote": 2184, "obs": ""}, {"data": "10/04/2026", "data_iso": "2026-04-10", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 4, "saldo": 136, "lote": 2177, "obs": ""}, {"data": "10/04/2026", "data_iso": "2026-04-10", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 29, "saldo": 6, "lote": 2177, "obs": ""}, {"data": "11/04/2026", "data_iso": "2026-04-11", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 240, "saldo": -104, "lote": 2188, "obs": ""}, {"data": "11/04/2026", "data_iso": "2026-04-11", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 96, "saldo": -182, "lote": 2188, "obs": ""}, {"data": "12/04/2026", "data_iso": "2026-04-12", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 159, "saldo": -263, "lote": 2188, "obs": ""}, {"data": "12/04/2026", "data_iso": "2026-04-12", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 72, "saldo": -66, "lote": 2188, "obs": ""}, {"data": "12/04/2026", "data_iso": "2026-04-12", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 96, "saldo": -278, "lote": 2188, "obs": ""}, {"data": "13/04/2026", "data_iso": "2026-04-13", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 240, "saldo": 315, "lote": 2184, "obs": ""}, {"data": "13/04/2026", "data_iso": "2026-04-13", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 54, "saldo": 421, "lote": 2184, "obs": ""}, {"data": "13/04/2026", "data_iso": "2026-04-13", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 5, "saldo": -268, "lote": 2179, "obs": ""}, {"data": "13/04/2026", "data_iso": "2026-04-13", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 128, "saldo": -194, "lote": 2188, "obs": ""}, {"data": "13/04/2026", "data_iso": "2026-04-13", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 8, "saldo": -286, "lote": 2188, "obs": ""}, {"data": "14/04/2026", "data_iso": "2026-04-14", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 600, "saida": 0, "saldo": 332, "lote": 2188, "obs": ""}, {"data": "14/04/2026", "data_iso": "2026-04-14", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 400, "saida": 0, "saldo": 206, "lote": 2188, "obs": ""}, {"data": "14/04/2026", "data_iso": "2026-04-14", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 600, "saida": 0, "saldo": 314, "lote": 2188, "obs": ""}, {"data": "15/04/2026", "data_iso": "2026-04-15", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 2, "saldo": 970, "lote": 2099, "obs": ""}, {"data": "15/04/2026", "data_iso": "2026-04-15", "produto": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "entrada": 0, "saida": 3, "saldo": 399, "lote": 2102, "obs": ""}, {"data": "15/04/2026", "data_iso": "2026-04-15", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 2, "saldo": 191, "lote": 1896, "obs": ""}, {"data": "15/04/2026", "data_iso": "2026-04-15", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 288, "saldo": 44, "lote": 2188, "obs": ""}, {"data": "15/04/2026", "data_iso": "2026-04-15", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 4, "saldo": 202, "lote": 2177, "obs": ""}, {"data": "16/04/2026", "data_iso": "2026-04-16", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 500, "saida": 0, "saldo": 1470, "lote": 2182, "obs": ""}, {"data": "16/04/2026", "data_iso": "2026-04-16", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 203, "saldo": -159, "lote": 2188, "obs": ""}, {"data": "16/04/2026", "data_iso": "2026-04-16", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 2, "saldo": 200, "lote": 1982, "obs": ""}, {"data": "17/04/2026", "data_iso": "2026-04-17", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 420, "saldo": 1050, "lote": 2182, "obs": ""}, {"data": "17/04/2026", "data_iso": "2026-04-17", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 300, "saida": 0, "saldo": 744, "lote": 2182, "obs": ""}, {"data": "17/04/2026", "data_iso": "2026-04-17", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 3, "saldo": 197, "lote": 2100, "obs": ""}, {"data": "18/04/2026", "data_iso": "2026-04-18", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 1, "saldo": 1049, "lote": 1996, "obs": ""}, {"data": "18/04/2026", "data_iso": "2026-04-18", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 1, "saldo": 196, "lote": 2172, "obs": ""}, {"data": "19/04/2026", "data_iso": "2026-04-19", "produto": "COMBO E&A (DULCE)", "variante": "BRANCO", "entrada": 0, "saida": 80, "saldo": 969, "lote": 2182, "obs": ""}, {"data": "19/04/2026", "data_iso": "2026-04-19", "produto": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "entrada": 0, "saida": 300, "saldo": 444, "lote": 2182, "obs": ""}, {"data": "19/04/2026", "data_iso": "2026-04-19", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 100, "saldo": 96, "lote": 2188, "obs": ""}, {"data": "19/04/2026", "data_iso": "2026-04-19", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 200, "saldo": 114, "lote": 2188, "obs": ""}, {"data": "24/04/2026", "data_iso": "2026-04-24", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 72, "saldo": -231, "lote": 2264, "obs": ""}, {"data": "24/04/2026", "data_iso": "2026-04-24", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 264, "saldo": -150, "lote": 2264, "obs": ""}, {"data": "25/04/2026", "data_iso": "2026-04-25", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 48, "saldo": -279, "lote": 2264, "obs": ""}, {"data": "26/04/2026", "data_iso": "2026-04-26", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 174, "saldo": -453, "lote": 2264, "obs": ""}, {"data": "26/04/2026", "data_iso": "2026-04-26", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 120, "saldo": -24, "lote": 2264, "obs": ""}, {"data": "26/04/2026", "data_iso": "2026-04-26", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 33, "saldo": -183, "lote": 2264, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 102, "saldo": 257, "lote": 2085, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 170, "saldo": 21, "lote": 2085, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 195, "lote": 2269, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 120, "saldo": 301, "lote": 2269, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 6, "saldo": -459, "lote": 2264, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "entrada": 0, "saida": 80, "saldo": -104, "lote": 2264, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 3, "saldo": -186, "lote": 2264, "obs": ""}, {"data": "27/04/2026", "data_iso": "2026-04-27", "produto": "PENTEADEIRA NEW", "variante": "PRETA / NATURE", "entrada": 0, "saida": 120, "saldo": 6, "lote": 2026, "obs": ""}, {"data": "28/04/2026", "data_iso": "2026-04-28", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 120, "saldo": 75, "lote": 2269, "obs": ""}, {"data": "28/04/2026", "data_iso": "2026-04-28", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 120, "saldo": 181, "lote": 2269, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 138, "saldo": 119, "lote": 2085, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "entrada": 0, "saida": 9, "saldo": 12, "lote": 2085, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 10, "saldo": 65, "lote": 2184, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 51, "saldo": 130, "lote": 2184, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "COMBO 2 MÓDULOS", "variante": "BRANCO", "entrada": 0, "saida": 1, "saldo": -460, "lote": 2179, "obs": ""}, {"data": "29/04/2026", "data_iso": "2026-04-29", "produto": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "entrada": 0, "saida": 1, "saldo": -187, "lote": 2087, "obs": ""}, {"data": "30/04/2026", "data_iso": "2026-04-30", "produto": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "entrada": 0, "saida": 117, "saldo": 2, "lote": 2085, "obs": ""}, {"data": "30/04/2026", "data_iso": "2026-04-30", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 6, "saldo": 59, "lote": 2220, "obs": ""}, {"data": "01/05/2026", "data_iso": "2026-05-01", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "entrada": 0, "saida": 10, "saldo": 49, "lote": 2269, "obs": ""}, {"data": "01/05/2026", "data_iso": "2026-05-01", "produto": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "entrada": 0, "saida": 10, "saldo": 120, "lote": 2269, "obs": ""}];
  const countRes = await pool.query('SELECT COUNT(*) FROM estoque_movimentos');
  if (parseInt(countRes.rows[0].count) === 0 && movSeed.length > 0) {
    console.log(`Importando ${movSeed.length} movimentos da planilha...`);
    for (const m of movSeed) {
      const prod = await pool.query(
        'SELECT id FROM estoque_produtos WHERE nome=$1 AND variante=$2',
        [m.produto, m.variante]
      );
      if (!prod.rows.length) continue;
      const pid = prod.rows[0].id;
      if (m.entrada > 0) {
        await pool.query(`
          INSERT INTO estoque_movimentos (id,produto_id,produto_nome,variante,tipo,quantidade,saldo_apos,lote,obs,data,data_iso,usuario_nome)
          VALUES ($1,$2,$3,$4,'entrada',$5,$6,$7,$8,$9,$10,'Importado da planilha')
          ON CONFLICT DO NOTHING
        `, [uid(),pid,m.produto,m.variante,m.entrada,m.saldo,m.lote||null,m.obs||'',m.data,m.data_iso]);
      }
      if (m.saida > 0) {
        await pool.query(`
          INSERT INTO estoque_movimentos (id,produto_id,produto_nome,variante,tipo,quantidade,saldo_apos,lote,obs,data,data_iso,usuario_nome)
          VALUES ($1,$2,$3,$4,'saida',$5,$6,$7,$8,$9,$10,'Importado da planilha')
          ON CONFLICT DO NOTHING
        `, [uid(),pid,m.produto,m.variante,m.saida,m.saldo,m.lote||null,m.obs||'',m.data,m.data_iso]);
      }
    }
    // Atualizar saldos atuais
    const movs = await pool.query(`
      SELECT DISTINCT ON (produto_id) produto_id, saldo_apos
      FROM estoque_movimentos
      ORDER BY produto_id, criado_em DESC
    `);
    for (const row of movs.rows) {
      await pool.query('UPDATE estoque_produtos SET saldo_atual=$1 WHERE id=$2', [row.saldo_apos, row.produto_id]);
    }
    console.log('Importação concluída.');
  }
}

// ── ROTAS ESTOQUE ─────────────────────────────────────────────

// Listar produtos com saldo
app.get('/api/estoque/produtos', autenticar, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM estoque_produtos ORDER BY nome, variante
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar produto
app.post('/api/estoque/produtos', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome, variante } = req.body;
    if (!nome || !variante) return res.status(400).json({ erro: 'Nome e variante obrigatórios.' });
    const result = await pool.query(`
      INSERT INTO estoque_produtos (id, nome, variante, saldo_atual)
      VALUES ($1,$2,$3,0) RETURNING *
    `, [uid(), nome.trim().toUpperCase(), variante.trim().toUpperCase()]);
    const prod = result.rows[0];
    broadcast('estoque:produto_add', prod);
    res.json(prod);
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Produto/variante já existe.' });
    res.status(500).json({ erro: e.message });
  }
});

// Remover produto
app.delete('/api/estoque/produtos/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM estoque_produtos WHERE id=$1', [req.params.id]);
    broadcast('estoque:produto_del', { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Registrar movimento (entrada ou saída)
app.post('/api/estoque/movimentos', autenticar, async (req, res) => {
  try {
    const { produto_id, tipo, quantidade, lote, obs } = req.body;
    if (!produto_id || !tipo || !quantidade) return res.status(400).json({ erro: 'Produto, tipo e quantidade obrigatórios.' });
    if (!['entrada','saida'].includes(tipo)) return res.status(400).json({ erro: 'Tipo deve ser entrada ou saida.' });
    const qtd = parseInt(quantidade);
    if (qtd <= 0) return res.status(400).json({ erro: 'Quantidade deve ser maior que zero.' });

    const prod = await pool.query('SELECT * FROM estoque_produtos WHERE id=$1', [produto_id]);
    if (!prod.rows.length) return res.status(404).json({ erro: 'Produto não encontrado.' });
    const p = prod.rows[0];

    const novoSaldo = tipo === 'entrada' ? p.saldo_atual + qtd : p.saldo_atual - qtd;
    const { data, hora } = nowBR();
    const data_iso = new Date().toISOString().slice(0,10);

    await pool.query('UPDATE estoque_produtos SET saldo_atual=$1 WHERE id=$2', [novoSaldo, produto_id]);

    const result = await pool.query(`
      INSERT INTO estoque_movimentos
      (id, produto_id, produto_nome, variante, tipo, quantidade, saldo_apos, lote, obs, data, data_iso, usuario_nome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [uid(), produto_id, p.nome, p.variante, tipo, qtd, novoSaldo, lote||null, obs||'', data, data_iso, req.usuario.nome]);

    const mov = result.rows[0];
    broadcast('estoque:movimento', { ...mov, saldo_atual: novoSaldo });
    // Recalcular status do lote se informado
    if (lote) await recalcularLotes(produto_id, parseInt(lote));
    res.json({ movimento: mov, saldo_atual: novoSaldo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar movimentos com filtros
app.get('/api/estoque/movimentos', autenticar, async (req, res) => {
  try {
    const { produto_id, tipo, de, ate } = req.query;
    let q = 'SELECT * FROM estoque_movimentos WHERE 1=1';
    const params = [];
    if (produto_id) { q += ` AND produto_id=${params.length+1}`; params.push(produto_id); }
    if (tipo)       { q += ` AND tipo=${params.length+1}`; params.push(tipo); }
    if (de)         { q += ` AND data_iso >= ${params.length+1}`; params.push(de); }
    if (ate)        { q += ` AND data_iso <= ${params.length+1}`; params.push(ate); }
    q += ' ORDER BY criado_em DESC LIMIT 1000';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir movimento (e recalcular saldo)
app.delete('/api/estoque/movimentos/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const mov = await pool.query('SELECT * FROM estoque_movimentos WHERE id=$1', [req.params.id]);
    if (!mov.rows.length) return res.status(404).json({ erro: 'Movimento não encontrado.' });
    const m = mov.rows[0];
    await pool.query('DELETE FROM estoque_movimentos WHERE id=$1', [req.params.id]);
    // Recalcular saldo
    const ajuste = m.tipo === 'entrada' ? -m.quantidade : m.quantidade;
    await pool.query('UPDATE estoque_produtos SET saldo_atual = saldo_atual + $1 WHERE id=$2', [ajuste, m.produto_id]);
    broadcast('estoque:movimento_del', { id: req.params.id, produto_id: m.produto_id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Resumo geral
app.get('/api/estoque/resumo', autenticar, async (req, res) => {
  try {
    const produtos = await pool.query('SELECT * FROM estoque_produtos ORDER BY nome, variante');
    const hoje = new Date().toISOString().slice(0,10);
    const movHoje = await pool.query(`
      SELECT tipo, SUM(quantidade)::int as total
      FROM estoque_movimentos WHERE data_iso=$1 GROUP BY tipo
    `, [hoje]);
    res.json({
      produtos: produtos.rows,
      movimentos_hoje: movHoje.rows
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});


// ── LOTES v2 (multi-produto) ──────────────────────────────────
async function initLotes() {
  // Drop old table structure if exists (migration)
  try {
    // Check if old estoque_lotes exists and pedidos_lote doesn't
    const check = await pool.query(`SELECT to_regclass('public.pedidos_lote') as exists`);
    if (!check.rows[0].exists) {
      console.log('Criando tabelas de lotes v2...');
    }
  } catch(e) {}

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
    console.log(`GET lotes: ${pedidos.rows.length} pedidos, ${itens.rows.length} itens`);
    const result  = pedidos.rows.map(p => ({
      ...p,
      itens: itens.rows.filter(i => i.pedido_id === p.id)
    }));
    res.json(result);
  } catch(e) { 
    console.error('GET lotes error:', e.message);
    res.status(500).json({ erro: e.message }); 
  }
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
    console.log(`POST lote: criado lote #${numero} com ${itemsCreated.length} itens`);
    broadcast('estoque:lote_add', full);
    res.json(full);
  } catch(e) { 
    console.error('POST lotes error:', e.message);
    res.status(500).json({ erro: e.message }); 
  }
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
    -- lote_insumos gerenciada por initLotes
  `);
  // Migrate lote_insumos: add pedido_id if missing
  try {
    await pool.query('ALTER TABLE lote_insumos ADD COLUMN IF NOT EXISTS pedido_id TEXT');
    await pool.query('UPDATE lote_insumos SET pedido_id = lote_id WHERE pedido_id IS NULL AND lote_id IS NOT NULL');
  } catch(e) {}
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
    broadcast('insumo:add', result.rows[0]);
    res.json(result.rows[0]);
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
      'SELECT * FROM lote_insumos WHERE pedido_id=$1 ORDER BY criado_em ASC',
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
      INSERT INTO lote_insumos (id,pedido_id,insumo_id,insumo_nome,fornecedor,valor_unitario,quantidade,valor_total,data_entrega_fab,obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [uid(), req.params.loteId, insumo_id||null, insumo_nome.trim(), fornecedor||'', vUnit, qtd, vTot,
        data_entrega_fab||null, obs||'']);
    broadcast('lote_insumo:add', result.rows[0]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Remover insumo do lote
app.delete('/api/lotes/:loteId/insumos/:id', autenticar, async (req, res) => {
  try {
    await pool.query('DELETE FROM lote_insumos WHERE id=$1 AND pedido_id=$2', [req.params.id, req.params.loteId]);
    broadcast('lote_insumo:del', { id: req.params.id, lote_id: req.params.loteId });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});



// ── IMPORTAÇÃO EM MASSA DE LOTES DA PLANILHA v2 ──────────────
// ENTRADA planilha = pedido ao fabricante (qtd_pedida)
// SAÍDA planilha   = recebido do fabricante (qtd_recebida)
app.post('/api/estoque/lotes/importar', autenticar, apenasAdmin, async (req, res) => {
  const lotesData = [{"numero": 1896, "itens": [{"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "qtd_pedida": 300, "qtd_recebida": 291, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "qtd_pedida": 700, "qtd_recebida": 693, "status": "parcial"}]}, {"numero": 1914, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 350, "qtd_recebida": 350, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 350, "qtd_recebida": 338, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 350, "qtd_recebida": 336, "status": "parcial"}]}, {"numero": 1971, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 700, "qtd_recebida": 669, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 227, "status": "parcial"}]}, {"numero": 1982, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 100, "qtd_recebida": 29, "status": "parcial"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 100, "qtd_recebida": 27, "status": "parcial"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 100, "qtd_recebida": 46, "status": "parcial"}]}, {"numero": 1992, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 150, "qtd_recebida": 146, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 150, "qtd_recebida": 323, "status": "excedente"}]}, {"numero": 1996, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 1000, "qtd_recebida": 1004, "status": "excedente"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 299, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}]}, {"numero": 1997, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 800, "qtd_recebida": 790, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 550, "qtd_recebida": 546, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 250, "qtd_recebida": 124, "status": "parcial"}]}, {"numero": 1998, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 400, "qtd_recebida": 120, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 600, "qtd_recebida": 320, "status": "parcial"}]}, {"numero": 2021, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 400, "qtd_recebida": 401, "status": "excedente"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 600, "qtd_recebida": 557, "status": "parcial"}]}, {"numero": 2022, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 400, "qtd_recebida": 288, "status": "parcial"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 300, "qtd_recebida": 403, "status": "excedente"}]}, {"numero": 2023, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 600, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 200, "qtd_recebida": 198, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 200, "status": "completo"}]}, {"numero": 2024, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 600, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 200, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 200, "qtd_recebida": 197, "status": "parcial"}]}, {"numero": 2025, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 576, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 200, "qtd_recebida": 198, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 202, "status": "excedente"}]}, {"numero": 2026, "itens": [{"produto_nome": "PENTEADEIRA NEW", "variante": "BRANCA", "qtd_pedida": 400, "qtd_recebida": 397, "status": "parcial"}, {"produto_nome": "PENTEADEIRA NEW", "variante": "OFF / NATURE", "qtd_pedida": 1000, "qtd_recebida": 1001, "status": "excedente"}, {"produto_nome": "PENTEADEIRA NEW", "variante": "PRETA / NATURE", "qtd_pedida": 400, "qtd_recebida": 394, "status": "parcial"}]}, {"numero": 2031, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 800, "qtd_recebida": 0, "status": "aberto"}]}, {"numero": 2037, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 550, "qtd_recebida": 0, "status": "aberto"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 250, "qtd_recebida": 0, "status": "aberto"}]}, {"numero": 2049, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 400, "qtd_recebida": 389, "status": "parcial"}]}, {"numero": 2078, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 600, "status": "completo"}]}, {"numero": 2082, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 26, "qtd_recebida": 0, "status": "aberto"}]}, {"numero": 2085, "itens": [{"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 493, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "qtd_pedida": 500, "qtd_recebida": 453, "status": "parcial"}]}, {"numero": 2086, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 476, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 200, "qtd_recebida": 297, "status": "excedente"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 196, "status": "parcial"}]}, {"numero": 2090, "itens": [{"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 510, "status": "excedente"}, {"produto_nome": "BALCÃO COOKTOP FLÓRIDA", "variante": "PRETO", "qtd_pedida": 500, "qtd_recebida": 476, "status": "parcial"}]}, {"numero": 2096, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 200, "qtd_recebida": 192, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 300, "qtd_recebida": 307, "status": "excedente"}]}, {"numero": 2097, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 528, "status": "excedente"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 210, "status": "excedente"}]}, {"numero": 2099, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 484, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 316, "status": "excedente"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 200, "status": "completo"}]}, {"numero": 2100, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 600, "status": "completo"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 200, "qtd_recebida": 202, "status": "excedente"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 200, "qtd_recebida": 199, "status": "parcial"}]}, {"numero": 2101, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 250, "qtd_recebida": 249, "status": "parcial"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 250, "qtd_recebida": 274, "status": "excedente"}]}, {"numero": 2102, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 510, "status": "excedente"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "NATURE PRETO", "qtd_pedida": 200, "qtd_recebida": 183, "status": "parcial"}]}, {"numero": 2172, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 400, "qtd_recebida": 393, "status": "parcial"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 200, "qtd_recebida": 200, "status": "completo"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 200, "qtd_recebida": 200, "status": "completo"}]}, {"numero": 2176, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 500, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 200, "qtd_recebida": 300, "status": "excedente"}]}, {"numero": 2177, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 200, "qtd_recebida": 201, "status": "excedente"}]}, {"numero": 2178, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 498, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 290, "status": "parcial"}]}, {"numero": 2179, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 100, "qtd_recebida": 100, "status": "completo"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 400, "qtd_recebida": 400, "status": "completo"}]}, {"numero": 2182, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 500, "status": "completo"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 300, "qtd_recebida": 300, "status": "completo"}]}, {"numero": 2183, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 500, "qtd_recebida": 0, "status": "aberto"}]}, {"numero": 2184, "itens": [{"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "BRANCO", "qtd_pedida": 250, "qtd_recebida": 250, "status": "completo"}, {"produto_nome": "BALCÃO COOKTOP NEW (MONACO)", "variante": "PRETO", "qtd_pedida": 250, "qtd_recebida": 249, "status": "parcial"}]}, {"numero": 2187, "itens": [{"produto_nome": "COMBO E&A (DULCE)", "variante": "BRANCO", "qtd_pedida": 1000, "qtd_recebida": 996, "status": "parcial"}, {"produto_nome": "COMBO E&A (DULCE)", "variante": "OFF WHITE", "qtd_pedida": 600, "qtd_recebida": 600, "status": "completo"}]}, {"numero": 2188, "itens": [{"produto_nome": "COMBO 2 MÓDULOS", "variante": "BRANCO", "qtd_pedida": 600, "qtd_recebida": 890, "status": "excedente"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "NATURE / OFF", "qtd_pedida": 600, "qtd_recebida": 400, "status": "parcial"}, {"produto_nome": "COMBO 2 MÓDULOS", "variante": "PRETO / NATURE", "qtd_pedida": 400, "qtd_recebida": 300, "status": "parcial"}]}];
  let criados = 0, atualizados = 0, erros = [];

  for (const lote of lotesData) {
    try {
      // Remover lote existente importado da planilha para reimportar com dados corretos
      const existing = await pool.query('SELECT id FROM pedidos_lote WHERE numero=$1', [lote.numero]);
      if (existing.rows.length) {
        await pool.query('DELETE FROM pedidos_lote WHERE id=$1', [existing.rows[0].id]);
        atualizados++;
      }

      const pedidoId = uid();

      // Status geral do pedido
      const statuses = lote.itens.map(i => i.status);
      let statusGeral = 'aberto';
      if (statuses.every(s => s === 'completo')) statusGeral = 'completo';
      else if (statuses.every(s => s === 'completo' || s === 'excedente')) statusGeral = 'excedente';
      else if (statuses.some(s => ['parcial','completo','excedente'].includes(s))) statusGeral = 'parcial';

      await pool.query(
        'INSERT INTO pedidos_lote (id,numero,obs,status,usuario_nome) VALUES ($1,$2,$3,$4,$5)',
        [pedidoId, lote.numero, 'Importado da planilha', statusGeral, 'Sistema']
      );

      for (const item of lote.itens) {
        const prod = await pool.query(
          'SELECT id FROM estoque_produtos WHERE nome=$1 AND variante=$2',
          [item.produto_nome, item.variante]
        );
        const produto_id = prod.rows.length ? prod.rows[0].id : null;

        await pool.query(
          'INSERT INTO lote_itens (id,pedido_id,produto_id,produto_nome,variante,qtd_pedida,qtd_recebida,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [uid(), pedidoId, produto_id, item.produto_nome, item.variante,
           item.qtd_pedida, item.qtd_recebida, item.status]
        );
      }
      criados++;
    } catch(e) {
      erros.push(`Lote #${lote.numero}: ${e.message}`);
    }
  }

  res.json({ criados, atualizados, erros, total: lotesData.length });
});

// Registrar entrega parcial do fabricante em um item do lote
// (também cria ENTRADA no estoque do produto)
app.post('/api/lotes/:loteId/itens/:itemId/entrega', autenticar, async (req, res) => {
  try {
    const { quantidade, obs } = req.body;
    const qtd = parseInt(quantidade);
    if (!qtd || qtd <= 0)
      return res.status(400).json({ erro: 'Quantidade inválida.' });

    // 1) Buscar item do lote
    const item = await pool.query('SELECT * FROM lote_itens WHERE id=$1 AND pedido_id=$2',
      [req.params.itemId, req.params.loteId]);
    if (!item.rows.length) return res.status(404).json({ erro: 'Item não encontrado.' });
    const it = item.rows[0];

    // 2) Buscar lote (para pegar o número do lote)
    const pedidoRes = await pool.query('SELECT * FROM pedidos_lote WHERE id=$1', [req.params.loteId]);
    if (!pedidoRes.rows.length) return res.status(404).json({ erro: 'Lote não encontrado.' });
    const numeroLote = pedidoRes.rows[0].numero;

    // 3) Atualizar quantidade recebida + status do item
    const novoRecebido = parseInt(it.qtd_recebida) + qtd;
    const ped = parseInt(it.qtd_pedida);
    let statusItem = 'parcial';
    if (novoRecebido === 0)    statusItem = 'aberto';
    if (novoRecebido === ped)  statusItem = 'completo';
    if (novoRecebido > ped)    statusItem = 'excedente';

    await pool.query(
      'UPDATE lote_itens SET qtd_recebida=$1, status=$2 WHERE id=$3',
      [novoRecebido, statusItem, it.id]
    );

    // 4) Criar ENTRADA no estoque do produto (se houver produto vinculado)
    let movimento = null;
    let novoSaldo = null;
    if (it.produto_id) {
      const prod = await pool.query('SELECT * FROM estoque_produtos WHERE id=$1', [it.produto_id]);
      if (prod.rows.length) {
        const p = prod.rows[0];
        novoSaldo = p.saldo_atual + qtd;
        const { data } = nowBR();
        const data_iso = new Date().toISOString().slice(0,10);

        await pool.query('UPDATE estoque_produtos SET saldo_atual=$1 WHERE id=$2', [novoSaldo, it.produto_id]);

        const movRes = await pool.query(`
          INSERT INTO estoque_movimentos
          (id, produto_id, produto_nome, variante, tipo, quantidade, saldo_apos, lote, obs, data, data_iso, usuario_nome)
          VALUES ($1,$2,$3,$4,'entrada',$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [uid(), it.produto_id, p.nome, p.variante, qtd, novoSaldo, numeroLote, obs||'', data, data_iso, req.usuario.nome]);
        movimento = movRes.rows[0];
        broadcast('estoque:movimento', { ...movimento, saldo_atual: novoSaldo });
      }
    }

    // 5) Recalcular status geral do pedido
    const allItens = await pool.query('SELECT * FROM lote_itens WHERE pedido_id=$1', [req.params.loteId]);
    const statuses = allItens.rows.map(i => i.status);
    let statusGeral = 'aberto';
    if (statuses.every(s => s === 'completo')) statusGeral = 'completo';
    else if (statuses.every(s => s === 'completo' || s === 'excedente')) statusGeral = 'excedente';
    else if (statuses.some(s => ['parcial','completo','excedente'].includes(s))) statusGeral = 'parcial';

    const pedido = await pool.query(
      'UPDATE pedidos_lote SET status=$1 WHERE id=$2 RETURNING *',
      [statusGeral, req.params.loteId]
    );

    const full = { ...pedido.rows[0], itens: allItens.rows.map(r => r.id === it.id ? {...r, qtd_recebida: novoRecebido, status: statusItem} : r) };
    broadcast('estoque:lote_update', full);
    console.log(`POST entrega: lote #${numeroLote} ${it.produto_nome}/${it.variante} +${qtd} (saldo: ${novoSaldo}) obs="${obs||''}"`);
    res.json({ ...full, movimento, saldo_atual: novoSaldo });
  } catch(e) {
    console.error('POST entrega error:', e.message);
    res.status(500).json({ erro: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════
// ESTOQUE NOVO (ligado à Produção)
// Entrada: cada coleta lançada na OP, na Produção, chega aqui e soma no
// estoque do produto e da cor. Ajuste manual e contagem ficam com o admin.
// Reserva e saída pela bipagem entram na segunda etapa.
// Só cria tabelas novas (estq_*). As tabelas do estoque antigo
// (estoque_produtos, estoque_movimentos, lotes, insumos) não são tocadas.
// ═══════════════════════════════════════════════════════════════════════
const ESTQ_PRODUCAO_URL = (process.env.PRODUCAO_URL || 'https://producao-server-production.up.railway.app').replace(/\/+$/, '');
const ESTQ_TOKEN = process.env.INTEGRACAO_TOKEN || '';
const ESTQ_POR_PAGINA = 50;
const ESTQ_MOTIVOS_AJUSTE = ['Avaria', 'Perda', 'Troca', 'Retorno de cliente', 'Acerto de contagem', 'Outro'];
let _estqPronto = false;
let _estqSincronizando = false;
let _estqFila = { pendentes: null, ultimo_erro: '' };   // fila de avisos na Produção (última leitura)

async function initEstq() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estq_itens (
        id SERIAL PRIMARY KEY,
        produto_ref INTEGER NOT NULL,
        produto_nome TEXT NOT NULL,
        sku_interno TEXT DEFAULT '',
        cor TEXT NOT NULL DEFAULT '',
        cor_chave TEXT NOT NULL DEFAULT '',
        hex TEXT DEFAULT '',
        sku_shopee TEXT,
        fisico INTEGER NOT NULL DEFAULT 0,
        reservado INTEGER NOT NULL DEFAULT 0,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (produto_ref, cor_chave)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_estq_itens_sku ON estq_itens (LOWER(sku_shopee)) WHERE sku_shopee IS NOT NULL AND sku_shopee <> '';

      CREATE TABLE IF NOT EXISTS estq_movimentos (
        id BIGSERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES estq_itens(id),
        tipo TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        saldo_antes INTEGER NOT NULL,
        saldo_depois INTEGER NOT NULL,
        motivo TEXT DEFAULT '',
        obs TEXT DEFAULT '',
        origem TEXT DEFAULT '',
        usuario_nome TEXT DEFAULT '',
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_estq_mov_criado ON estq_movimentos (criado_em DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_estq_mov_item ON estq_movimentos (item_id, criado_em DESC);

      CREATE TABLE IF NOT EXISTS estq_coletas (
        coleta_id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES estq_itens(id),
        quantidade INTEGER NOT NULL,
        op_numero TEXT DEFAULT '',
        numero_requisicao TEXT DEFAULT '',
        recebido_em TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS estq_config (
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      );
    `);
    _estqPronto = true;
    if (!ESTQ_TOKEN) console.warn('[estoque] INTEGRACAO_TOKEN não configurado: a ligação com a Produção fica desligada até a variável ser criada.');
    console.log('[estoque] estoque novo pronto');
    setTimeout(() => { estqSincronizarProdutos(); }, 5000);
    const t = setInterval(() => { estqSincronizarProdutos(); }, 30 * 60 * 1000);
    if (t.unref) t.unref();
  } catch (e) {
    // Não derruba a Bipagem: sem as tabelas, só a tela nova de Estoque fica indisponível.
    console.error('[estoque] estoque novo indisponível, erro ao preparar:', e.message);
  }
}

function estqChave(cor) { return String(cor || '').trim().toUpperCase(); }
function estqInt(v) { const n = Number(v); return Number.isInteger(n) ? n : null; }

async function estqTx(fn) {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const out = await fn(cli);
    await cli.query('COMMIT');
    return out;
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cli.release(); }
}

async function estqConfig(chave, valor) {
  await pool.query(`INSERT INTO estq_config (chave, valor) VALUES ($1, $2)
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [chave, String(valor)]);
}

// Acha o item (produto + cor) ou cria. Não mexe em SKU nem em saldo de item existente.
async function estqItem(cli, d) {
  const r = await cli.query(`
    INSERT INTO estq_itens (produto_ref, produto_nome, sku_interno, cor, cor_chave, hex)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (produto_ref, cor_chave) DO UPDATE
      SET produto_nome = EXCLUDED.produto_nome,
          sku_interno = EXCLUDED.sku_interno,
          hex = CASE WHEN EXCLUDED.hex <> '' THEN EXCLUDED.hex ELSE estq_itens.hex END,
          ativo = TRUE, atualizado_em = NOW()
    RETURNING id
  `, [d.produto_id, String(d.produto_nome || '').trim() || 'Produto ' + d.produto_id, String(d.sku || ''),
      String(d.cor || '').trim(), estqChave(d.cor), String(d.hex || '')]);
  return r.rows[0].id;
}

// Único ponto que altera o saldo físico: trava o item, grava o movimento com saldo antes e depois.
async function estqMovimentar(cli, itemId, delta, tipo, info) {
  const r = await cli.query('SELECT fisico FROM estq_itens WHERE id = $1 FOR UPDATE', [itemId]);
  if (!r.rows.length) throw new Error('item de estoque não encontrado');
  const antes = r.rows[0].fisico, depois = antes + delta;
  await cli.query('UPDATE estq_itens SET fisico = $1, atualizado_em = NOW() WHERE id = $2', [depois, itemId]);
  await cli.query(`
    INSERT INTO estq_movimentos (item_id, tipo, quantidade, saldo_antes, saldo_depois, motivo, obs, origem, usuario_nome)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, [itemId, tipo, delta, antes, depois, info.motivo || '', info.obs || '', info.origem || '', info.usuario || '']);
  return { antes, depois };
}

function autenticarIntegracao(req, res, next) {
  const recebido = String(req.headers['x-integracao-token'] || '');
  if (!ESTQ_TOKEN || !recebido) return res.status(401).json({ erro: 'Integração não autorizada.' });
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(ESTQ_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: 'Integração não autorizada.' });
  next();
}

// ── Recebe da Produção: coleta criada, editada ou excluída ─────────────
// Pode chegar repetido (reenvio da fila): repetir o mesmo aviso não muda o saldo.
app.post('/api/integracao/coleta', autenticarIntegracao, async (req, res) => {
  try {
    if (!_estqPronto) return res.status(503).json({ erro: 'Estoque indisponível.' });
    const evento = req.body && req.body.evento;
    const c = (req.body && req.body.coleta) || {};
    const coletaId = estqInt(c.id);
    if (!['upsert', 'delete'].includes(evento) || !coletaId) return res.status(400).json({ erro: 'Aviso inválido.' });

    if (evento === 'delete') {
      const out = await estqTx(async cli => {
        const a = await cli.query('SELECT * FROM estq_coletas WHERE coleta_id = $1 FOR UPDATE', [coletaId]);
        if (!a.rows.length) return { alterou: false };
        const ant = a.rows[0];
        await estqMovimentar(cli, ant.item_id, -ant.quantidade, 'estorno_coleta', {
          motivo: 'Coleta excluída na Produção',
          origem: `Coleta ${coletaId}, OP #${ant.op_numero}`, usuario: 'Produção'
        });
        await cli.query('DELETE FROM estq_coletas WHERE coleta_id = $1', [coletaId]);
        return { alterou: true };
      });
      if (out.alterou) broadcast('estq:atualizado', {});
      return res.json({ ok: true, alterou: out.alterou });
    }

    const produtoId = estqInt(c.produto_id), qtd = estqInt(c.quantidade);
    if (!produtoId || !qtd || qtd < 1) return res.status(400).json({ erro: 'Aviso inválido.' });
    const opNumero = String(c.op_numero || ''), req_ = String(c.numero_requisicao || '');
    const origem = `Coleta ${coletaId}, OP #${opNumero}` + (req_ ? `, requisição ${req_}` : '');

    const out = await estqTx(async cli => {
      const itemId = await estqItem(cli, c);
      const a = await cli.query('SELECT * FROM estq_coletas WHERE coleta_id = $1 FOR UPDATE', [coletaId]);
      if (!a.rows.length) {
        await cli.query(`INSERT INTO estq_coletas (coleta_id, item_id, quantidade, op_numero, numero_requisicao) VALUES ($1,$2,$3,$4,$5)`,
          [coletaId, itemId, qtd, opNumero, req_]);
        await estqMovimentar(cli, itemId, qtd, 'entrada_coleta', { origem, usuario: 'Produção' });
        return { alterou: true };
      }
      const ant = a.rows[0];
      let alterou = false;
      if (ant.item_id !== itemId) {
        // A coleta mudou de cor: sai do item antigo e entra no novo.
        await estqMovimentar(cli, ant.item_id, -ant.quantidade, 'correcao_coleta', { motivo: 'Coleta editada na Produção (cor alterada)', origem, usuario: 'Produção' });
        await estqMovimentar(cli, itemId, qtd, 'correcao_coleta', { motivo: 'Coleta editada na Produção (cor alterada)', origem, usuario: 'Produção' });
        alterou = true;
      } else if (ant.quantidade !== qtd) {
        await estqMovimentar(cli, itemId, qtd - ant.quantidade, 'correcao_coleta', { motivo: `Coleta editada na Produção (de ${ant.quantidade} para ${qtd})`, origem, usuario: 'Produção' });
        alterou = true;
      }
      await cli.query(`UPDATE estq_coletas SET item_id = $2, quantidade = $3, op_numero = $4, numero_requisicao = $5, atualizado_em = NOW() WHERE coleta_id = $1`,
        [coletaId, itemId, qtd, opNumero, req_]);
      return { alterou };
    });
    if (out.alterou) broadcast('estq:atualizado', {});
    res.json({ ok: true, alterou: out.alterou });
  } catch (e) {
    console.error('[estoque] erro ao receber coleta:', e);
    res.status(500).json({ erro: 'Erro ao registrar a coleta no estoque.' });
  }
});

// ── Importa produtos e cores cadastrados na Produção ──────────────────
// Só cria e atualiza nome/cor. Nunca altera SKU da Shopee nem saldo.
async function estqSincronizarProdutos() {
  if (!_estqPronto || _estqSincronizando) return { ok: false, erro: 'Sincronização em andamento.' };
  if (!ESTQ_TOKEN) return { ok: false, erro: 'Variável INTEGRACAO_TOKEN não configurada.' };
  if (typeof fetch !== 'function') return { ok: false, erro: 'Versão do Node sem fetch.' };
  _estqSincronizando = true;
  try {
    const pedir = async caminho => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(ESTQ_PRODUCAO_URL + caminho, { headers: { 'x-integracao-token': ESTQ_TOKEN }, signal: ctrl.signal });
        if (!r.ok) throw new Error(r.status === 401 ? 'Token recusado pela Produção.' : 'Produção respondeu HTTP ' + r.status + '.');
        return await r.json();
      } finally { clearTimeout(timer); }
    };
    const dados = await pedir('/api/integracao/produtos');
    const produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
    let criados = 0;
    await estqTx(async cli => {
      const vistos = [];
      for (const p of produtos) {
        const pid = estqInt(p.produto_id);
        if (!pid) continue;
        const cores = Array.isArray(p.cores) && p.cores.length ? p.cores : [{ cor: '', hex: '' }];
        for (const c of cores) {
          const antes = await cli.query('SELECT id FROM estq_itens WHERE produto_ref = $1 AND cor_chave = $2', [pid, estqChave(c.cor)]);
          const id = await estqItem(cli, { produto_id: pid, produto_nome: p.nome, sku: p.sku, cor: c.cor, hex: c.hex });
          if (!antes.rows.length) criados++;
          if (p.ativo === false) await cli.query('UPDATE estq_itens SET ativo = FALSE WHERE id = $1', [id]);
          vistos.push(id);
        }
      }
      // O que sumiu do cadastro da Produção fica inativo (continua aparecendo enquanto tiver saldo).
      if (produtos.length) await cli.query('UPDATE estq_itens SET ativo = FALSE WHERE NOT (id = ANY($1::int[]))', [vistos]);
    });
    try { _estqFila = await pedir('/api/integracao/status'); } catch (e) { _estqFila = { pendentes: null, ultimo_erro: '' }; }
    await estqConfig('sync_em', new Date().toISOString());
    await estqConfig('sync_erro', '');
    if (criados) broadcast('estq:atualizado', {});
    return { ok: true, criados, total: produtos.length };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Produção não respondeu em 10 segundos.' : (e.message || 'Falha ao falar com a Produção.');
    console.error('[estoque] sincronização de produtos falhou:', msg);
    try { await estqConfig('sync_erro', msg); } catch (_) {}
    return { ok: false, erro: msg };
  } finally {
    _estqSincronizando = false;
  }
}

function estqDisponivel(req, res, next) {
  if (!_estqPronto) return res.status(503).json({ erro: 'Estoque indisponível. Verifique o log do servidor.' });
  next();
}

async function estqSenhaConfere(req, senha) {
  if (!senha) return false;
  const r = await pool.query('SELECT senha FROM usuarios WHERE id = $1', [req.usuario.id]);
  return r.rows.length > 0 && r.rows[0].senha === hashSenha(String(senha));
}

// ── Saldos + situação da ligação ──────────────────────────────────────
app.get('/api/estq/resumo', autenticar, estqDisponivel, async (req, res) => {
  try {
    const itens = await pool.query(`
      SELECT id, produto_ref, produto_nome, sku_interno, cor, hex, sku_shopee, fisico, reservado, ativo
      FROM estq_itens
      WHERE ativo = TRUE OR fisico <> 0 OR reservado <> 0
      ORDER BY produto_nome, cor
    `);
    const cfg = await pool.query(`SELECT chave, valor FROM estq_config WHERE chave IN ('sync_em','sync_erro')`);
    const conf = {}; cfg.rows.forEach(r => { conf[r.chave] = r.valor; });
    const ult = await pool.query('SELECT MAX(atualizado_em) AS em FROM estq_coletas');
    // Lista velha (mais de 10 min): atualiza em segundo plano, sem segurar a tela.
    if (ESTQ_TOKEN && (!conf.sync_em || Date.now() - new Date(conf.sync_em).getTime() > 10 * 60 * 1000)) estqSincronizarProdutos();
    const sh = await pool.query(`SELECT COALESCE(-SUM(quantidade), 0)::INTEGER AS n FROM estq_movimentos
      WHERE tipo IN ('saida_bipagem', 'saida_desfeita') AND criado_em >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date::timestamp AT TIME ZONE 'America/Sao_Paulo'`);
    let fisico = 0, reservado = 0, semSku = 0;
    itens.rows.forEach(i => { fisico += i.fisico; reservado += i.reservado; if (i.ativo && !i.sku_shopee) semSku++; });
    res.json({
      itens: itens.rows,
      totais: { fisico, reservado, disponivel: fisico - reservado, sem_sku: semSku, saidas_hoje: sh.rows[0].n },
      motivos_ajuste: ESTQ_MOTIVOS_AJUSTE,
      ligacao: {
        token_configurado: !!ESTQ_TOKEN,
        produtos_em: conf.sync_em || null,
        produtos_erro: conf.sync_erro || '',
        ultima_coleta_em: ult.rows[0].em ? ult.rows[0].em.toISOString() : null,
        fila_pendentes: _estqFila.pendentes,
        fila_erro: _estqFila.ultimo_erro || ''
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar o estoque.' });
  }
});

// ── Movimentações: 50 por página, paginadas no servidor ───────────────
app.get('/api/estq/movimentos', autenticar, estqDisponivel, async (req, res) => {
  try {
    const where = [], params = [];
    const itemId = estqInt(req.query.item_id);
    if (itemId) { params.push(itemId); where.push(`m.item_id = $${params.length}`); }
    if (req.query.tipo) { params.push(String(req.query.tipo)); where.push(`m.tipo = $${params.length}`); }
    const dataOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    if (dataOk(req.query.de)) { params.push(req.query.de); where.push(`m.criado_em >= ($${params.length}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`); }
    if (dataOk(req.query.ate)) { params.push(req.query.ate); where.push(`m.criado_em < ($${params.length}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const tot = await pool.query(`SELECT COUNT(*)::INTEGER AS n FROM estq_movimentos m ${w}`, params);
    const total = tot.rows[0].n;
    const paginas = Math.max(1, Math.ceil(total / ESTQ_POR_PAGINA));
    const pagina = Math.min(Math.max(1, estqInt(req.query.pagina) || 1), paginas);
    const r = await pool.query(`
      SELECT m.id, m.item_id, m.tipo, m.quantidade, to_jsonb(m)->>'reserva' AS reserva, m.saldo_antes, m.saldo_depois, m.motivo, m.obs, m.origem,
             m.usuario_nome, m.criado_em, i.produto_nome, i.cor, i.sku_shopee
      FROM estq_movimentos m JOIN estq_itens i ON i.id = m.item_id
      ${w}
      ORDER BY m.criado_em DESC, m.id DESC
      LIMIT ${ESTQ_POR_PAGINA} OFFSET ${(pagina - 1) * ESTQ_POR_PAGINA}
    `, params);
    res.json({ pagina, paginas, total, por_pagina: ESTQ_POR_PAGINA, movimentos: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar as movimentações.' });
  }
});

// ── Atualizar a lista de produtos agora (admin) ───────────────────────
app.post('/api/estq/produtos/sincronizar', autenticar, apenasAdmin, estqDisponivel, async (req, res) => {
  const r = await estqSincronizarProdutos();
  if (!r.ok) return res.status(502).json({ erro: r.erro });
  res.json(r);
});

// ── SKU da Shopee por produto e cor (admin) ───────────────────────────
app.put('/api/estq/itens/:id/sku', autenticar, apenasAdmin, estqDisponivel, async (req, res) => {
  try {
    const id = estqInt(req.params.id);
    const sku = String((req.body && req.body.sku_shopee) || '').trim();
    if (!id) return res.status(400).json({ erro: 'Item inválido.' });
    if (sku.length > 80) return res.status(400).json({ erro: 'SKU muito longo.' });
    if (sku) {
      const dup = await pool.query('SELECT produto_nome, cor FROM estq_itens WHERE LOWER(sku_shopee) = LOWER($1) AND id <> $2 LIMIT 1', [sku, id]);
      if (dup.rows.length) return res.status(409).json({ erro: `Este SKU já está em ${dup.rows[0].produto_nome}${dup.rows[0].cor ? ', cor ' + dup.rows[0].cor : ''}.` });
    }
    const r = await pool.query('UPDATE estq_itens SET sku_shopee = $1, atualizado_em = NOW() WHERE id = $2 RETURNING id, sku_shopee', [sku || null, id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Item não encontrado.' });
    broadcast('estq:atualizado', {});
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Este SKU já está em outro item.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar o SKU.' });
  }
});

// ── Ajuste manual (admin, com senha e motivo) ─────────────────────────
app.post('/api/estq/ajuste', autenticar, apenasAdmin, estqDisponivel, async (req, res) => {
  try {
    const b = req.body || {};
    const itemId = estqInt(b.item_id), qtd = estqInt(b.quantidade);
    const motivo = String(b.motivo || '').trim(), obs = String(b.obs || '').trim().slice(0, 300);
    if (!itemId) return res.status(400).json({ erro: 'Item inválido.' });
    if (!['entrada', 'saida'].includes(b.tipo)) return res.status(400).json({ erro: 'Escolha entrada ou saída.' });
    if (!qtd || qtd < 1) return res.status(400).json({ erro: 'Informe uma quantidade maior que zero.' });
    if (!ESTQ_MOTIVOS_AJUSTE.includes(motivo)) return res.status(400).json({ erro: 'Selecione o motivo.' });
    if (motivo === 'Outro' && !obs) return res.status(400).json({ erro: 'Descreva o motivo na observação.' });
    if (!(await estqSenhaConfere(req, b.senha))) return res.status(401).json({ erro: 'Senha incorreta.' });
    const out = await estqTx(async cli => {
      const it = await cli.query('SELECT fisico FROM estq_itens WHERE id = $1 FOR UPDATE', [itemId]);
      if (!it.rows.length) return { erro: 'Item não encontrado.', status: 404 };
      if (b.tipo === 'saida' && qtd > it.rows[0].fisico) return { erro: `Saída maior que o estoque físico (${it.rows[0].fisico}). Para corrigir o saldo, use a contagem.`, status: 400 };
      return await estqMovimentar(cli, itemId, b.tipo === 'entrada' ? qtd : -qtd, b.tipo === 'entrada' ? 'ajuste_entrada' : 'ajuste_saida',
        { motivo, obs, usuario: req.usuario.nome });
    });
    if (out.erro) return res.status(out.status).json({ erro: out.erro });
    broadcast('estq:atualizado', {});
    res.json({ ok: true, fisico: out.depois });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar o ajuste.' });
  }
});

// ── Contagem em lote (admin, com senha) ───────────────────────────────
// Recebe o saldo contado de cada item e o sistema calcula a diferença.
app.post('/api/estq/contagem', autenticar, apenasAdmin, estqDisponivel, async (req, res) => {
  try {
    const b = req.body || {};
    const obs = String(b.obs || '').trim().slice(0, 300);
    const lista = Array.isArray(b.itens) ? b.itens : [];
    if (!lista.length) return res.status(400).json({ erro: 'Informe a contagem de pelo menos um item.' });
    if (lista.length > 2000) return res.status(400).json({ erro: 'Itens demais em uma única contagem.' });
    const limpos = [];
    for (const x of lista) {
      const itemId = estqInt(x.item_id), contado = estqInt(x.contado);
      if (!itemId || contado === null || contado < 0) return res.status(400).json({ erro: 'Há quantidade inválida na contagem.' });
      limpos.push({ itemId, contado });
    }
    if (!(await estqSenhaConfere(req, b.senha))) return res.status(401).json({ erro: 'Senha incorreta.' });
    const out = await estqTx(async cli => {
      let alterados = 0, iguais = 0;
      for (const x of limpos) {
        const it = await cli.query('SELECT fisico FROM estq_itens WHERE id = $1 FOR UPDATE', [x.itemId]);
        if (!it.rows.length) throw Object.assign(new Error('item'), { estq: 'Item da contagem não encontrado.' });
        const delta = x.contado - it.rows[0].fisico;
        if (delta === 0) { iguais++; continue; }
        await estqMovimentar(cli, x.itemId, delta, 'contagem', { motivo: 'Contagem de estoque', obs, usuario: req.usuario.nome });
        alterados++;
      }
      return { alterados, iguais };
    });
    broadcast('estq:atualizado', {});
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.estq) return res.status(400).json({ erro: e.estq });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar a contagem.' });
  }
});


// ═══════════════════════════════════════════════════════════════════════
// GERADOR DE ETIQUETA + RESERVA E SAÍDA PELA BIPAGEM
// O arquivo da Shopee é lido no navegador de quem enviou. Aqui chega só o
// resultado: rastreio, pedido e itens (SKU, variação, quantidade). O arquivo
// em si não é guardado.
// Estoque: etiqueta bipada na separação reserva; etiqueta coletada dá saída.
// Em vez de mexer em cada rota de bipagem e coleta, um conferidor compara a
// situação de cada etiqueta na tabela bipagens com o que já foi lançado no
// estoque e aplica só a diferença. Assim cancelar, reabrir, desfazer coleta
// ou excluir bipagem também corrigem o estoque, sem risco de lançar em dobro.
// Só cria tabelas novas (etq_*) e uma coluna na estq_movimentos, que é deste módulo.
// ═══════════════════════════════════════════════════════════════════════
const ETQ_MOTIVOS_REIMPRESSAO = ['Etiqueta perdida', 'Etiqueta rasgada ou ilegível', 'Falha na impressora'];
const ETQ_MAX_POR_ARQUIVO = 2000;
let _etqPronto = false, _etqRodando = false, _etqPendente = null;   // _etqPendente: null = nada, [] = tudo, [..] = só essas

async function initEtq() {
  try {
    if (!_estqPronto) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS etq_arquivos (
        id SERIAL PRIMARY KEY,
        nome TEXT DEFAULT '',
        usuario_id INTEGER,
        usuario_nome TEXT DEFAULT '',
        enviado_em TIMESTAMPTZ DEFAULT NOW(),
        total INTEGER NOT NULL DEFAULT 0,
        novas INTEGER NOT NULL DEFAULT 0,
        repetidas INTEGER NOT NULL DEFAULT 0,
        baixado_em TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_etq_arquivos_em ON etq_arquivos (enviado_em DESC);

      CREATE TABLE IF NOT EXISTS etq_etiquetas (
        rastreio TEXT PRIMARY KEY,
        pedido TEXT DEFAULT '',
        pacote INTEGER NOT NULL DEFAULT 1,
        arquivo_id INTEGER,
        enviado_por TEXT DEFAULT '',
        enviado_por_id INTEGER,
        enviado_em TIMESTAMPTZ DEFAULT NOW(),
        impressa_em TIMESTAMPTZ,
        impressa_por TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_etq_etiquetas_em ON etq_etiquetas (enviado_em);

      CREATE TABLE IF NOT EXISTS etq_itens (
        id BIGSERIAL PRIMARY KEY,
        rastreio TEXT NOT NULL REFERENCES etq_etiquetas(rastreio) ON DELETE CASCADE,
        sku TEXT NOT NULL DEFAULT '',
        variacao TEXT DEFAULT '',
        produto TEXT DEFAULT '',
        qtd INTEGER NOT NULL DEFAULT 1,
        estado TEXT NOT NULL DEFAULT '',
        item_id INTEGER,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_etq_itens_rastreio ON etq_itens (rastreio);
      CREATE INDEX IF NOT EXISTS idx_etq_itens_sku ON etq_itens (LOWER(sku));

      CREATE TABLE IF NOT EXISTS etq_reimpressoes (
        id SERIAL PRIMARY KEY,
        rastreio TEXT NOT NULL,
        usuario_nome TEXT DEFAULT '',
        motivo TEXT DEFAULT '',
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_etq_reimp_em ON etq_reimpressoes (criado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_etq_reimp_rastreio ON etq_reimpressoes (rastreio);

      ALTER TABLE estq_movimentos ADD COLUMN IF NOT EXISTS reserva INTEGER NOT NULL DEFAULT 0;
    `);
    _etqPronto = true;
    console.log('[etiquetas] gerador de etiqueta e reserva prontos');
    const t = setInterval(() => { etqAgendar(null); }, 60 * 1000);
    if (t.unref) t.unref();
    setTimeout(() => { etqAgendar(null); }, 8000);
  } catch (e) {
    console.error('[etiquetas] gerador indisponível, erro ao preparar:', e.message);
  }
}

function etqDisponivel(req, res, next) {
  if (!_etqPronto) return res.status(503).json({ erro: 'Gerador de etiqueta indisponível. Verifique o log do servidor.' });
  next();
}
function etqRastreio(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z0-9-]{6,40}$/.test(s) ? s : null;
}
function etqTexto(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// ── Estoque: aplica reserva e saída conforme a situação da etiqueta ───
async function etqLancar(cli, itemId, dFis, dRes, tipo, info) {
  const r = await cli.query('SELECT fisico, reservado FROM estq_itens WHERE id = $1 FOR UPDATE', [itemId]);
  if (!r.rows.length) return null;
  const antes = r.rows[0].fisico, depois = antes + dFis, reservado = r.rows[0].reservado + dRes;
  await cli.query('UPDATE estq_itens SET fisico = $1, reservado = $2, atualizado_em = NOW() WHERE id = $3', [depois, reservado, itemId]);
  await cli.query(`
    INSERT INTO estq_movimentos (item_id, tipo, quantidade, saldo_antes, saldo_depois, motivo, obs, origem, usuario_nome, reserva)
    VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9)
  `, [itemId, tipo, dFis, antes, depois, info.motivo || '', info.origem || '', info.usuario || '', dRes]);
  return { fisico: depois, reservado };
}
const ETQ_TRANSICOES = {
  '>reservado':         { f: 0,  r: 1,  tipo: 'reserva' },
  '>saiu':              { f: -1, r: 0,  tipo: 'saida_bipagem' },
  'reservado>saiu':     { f: -1, r: -1, tipo: 'saida_bipagem' },
  'reservado>':         { f: 0,  r: -1, tipo: 'reserva_liberada' },
  'saiu>reservado':     { f: 1,  r: 1,  tipo: 'saida_desfeita' },
  'saiu>':              { f: 1,  r: 0,  tipo: 'saida_desfeita' }
};
const ETQ_SQL_DESEJADO = `CASE WHEN b.etiqueta IS NULL THEN ''
  WHEN b.coletada_em IS NOT NULL THEN 'saiu'
  WHEN COALESCE(b.cancelada, FALSE) THEN ''
  ELSE 'reservado' END`;

// Pede uma conferência. lista = rastreios afetados, ou null para conferir tudo que é recente.
function etqAgendar(lista) {
  if (!_etqPronto) return;
  if (!lista || !lista.length) _etqPendente = [];                            // conferir tudo
  else if (_etqPendente === null) _etqPendente = lista.slice();              // só estas
  else if (_etqPendente.length) _etqPendente = _etqPendente.concat(lista);   // junta com as que já esperavam
  // (se já estava marcado "conferir tudo", continua assim)
  setImmediate(etqConferir);
}
async function etqConferir() {
  if (_etqRodando || _etqPendente === null) return;
  _etqRodando = true;
  try {
    while (_etqPendente !== null) {
      const alvo = _etqPendente; _etqPendente = null;
      const params = [];
      let filtro = `e.enviado_em > NOW() - INTERVAL '120 days'`;
      if (alvo.length) { params.push(Array.from(new Set(alvo)).slice(0, 5000)); filtro = `i.rastreio = ANY($1::text[])`; }
      const r = await pool.query(`
        SELECT i.id, i.rastreio, i.sku, i.variacao, i.qtd, i.estado, i.item_id, ${ETQ_SQL_DESEJADO} AS desejado,
               s.id AS item_sku, b.usuario_nome AS bipado_por, b.coletada_por
        FROM etq_itens i
        JOIN etq_etiquetas e ON e.rastreio = i.rastreio
        LEFT JOIN bipagens b ON b.etiqueta = i.rastreio
        LEFT JOIN estq_itens s ON i.sku <> '' AND LOWER(s.sku_shopee) = LOWER(i.sku)
        WHERE ${filtro}
          AND i.estado <> (${ETQ_SQL_DESEJADO})
          AND (i.estado <> '' OR s.id IS NOT NULL)
        ORDER BY i.id
        LIMIT 1000
      `, params);
      let mudou = false;
      const reservas = {};
      for (const row of r.rows) {
        const t = ETQ_TRANSICOES[row.estado + '>' + row.desejado];
        if (!t) continue;
        try {
          const feito = await estqTx(async cli => {
            const atual = await cli.query('SELECT estado, item_id, qtd FROM etq_itens WHERE id = $1 FOR UPDATE', [row.id]);
            if (!atual.rows.length || atual.rows[0].estado !== row.estado) return null;   // outro processo já tratou
            const itemId = row.estado ? atual.rows[0].item_id : row.item_sku;
            if (!itemId) return null;
            const q = atual.rows[0].qtd;
            const saldo = await etqLancar(cli, itemId, t.f * q, t.r * q, t.tipo, {
              origem: 'Etiqueta ' + row.rastreio,
              usuario: (row.desejado === 'saiu' ? row.coletada_por : row.bipado_por) || '',
              motivo: t.tipo === 'reserva_liberada' ? 'Bipagem cancelada ou excluída' : (t.tipo === 'saida_desfeita' ? 'Coleta desfeita' : '')
            });
            if (!saldo) return null;
            await cli.query('UPDATE etq_itens SET estado = $1, item_id = $2, atualizado_em = NOW() WHERE id = $3',
              [row.desejado, row.desejado ? itemId : null, row.id]);
            return saldo;
          });
          if (!feito) continue;
          mudou = true;
          if (t.tipo === 'reserva') {
            (reservas[row.rastreio] = reservas[row.rastreio] || { etiqueta: row.rastreio, usuario: row.bipado_por || '', itens: [], sem_estoque: false })
              .itens.push({ sku: row.sku, variacao: row.variacao, qtd: row.qtd, disponivel: feito.fisico - feito.reservado });
            if (feito.fisico - feito.reservado < 0) reservas[row.rastreio].sem_estoque = true;
          }
        } catch (e) {
          console.error('[etiquetas] erro ao lançar estoque da etiqueta', row.rastreio, e.message);
        }
      }
      if (mudou) broadcast('estq:atualizado', {});
      Object.keys(reservas).forEach(k => broadcast('etq:reserva', reservas[k]));
      if (r.rows.length === 1000 && mudou) _etqPendente = _etqPendente || [];   // ainda há mais: roda de novo
    }
  } catch (e) {
    console.error('[etiquetas] erro na conferência de estoque:', e.message);
  } finally {
    _etqRodando = false;
  }
}

// ── Enviar o resultado da leitura de um arquivo ───────────────────────
// Registra quem enviou e devolve a situação de cada etiqueta: nova, já impressa
// (por quem e quando) ou enviada por outra pessoa e ainda não baixada.
app.post('/api/etq/arquivos', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const b = req.body || {};
    const lista = Array.isArray(b.etiquetas) ? b.etiquetas : [];
    if (!lista.length) return res.status(400).json({ erro: 'Nenhuma etiqueta no envio.' });
    if (lista.length > ETQ_MAX_POR_ARQUIVO) return res.status(400).json({ erro: 'Etiquetas demais em um único arquivo.' });
    const limpas = [], vistos = new Set();
    for (const x of lista) {
      const rastreio = etqRastreio(x && x.rastreio);
      if (!rastreio) return res.status(400).json({ erro: 'Há etiqueta com rastreio inválido.' });
      if (vistos.has(rastreio)) continue;
      vistos.add(rastreio);
      const itens = [];
      for (const it of (Array.isArray(x.itens) ? x.itens : []).slice(0, 50)) {
        const qtd = estqInt(it && it.qtd);
        if (!qtd || qtd < 1 || qtd > 9999) return res.status(400).json({ erro: 'Há item com quantidade inválida.' });
        itens.push({ sku: etqTexto(it.sku, 80), variacao: etqTexto(it.variacao, 120), produto: etqTexto(it.produto, 200), qtd });
      }
      limpas.push({ rastreio, pedido: etqTexto(x.pedido, 40).toUpperCase(), pacote: estqInt(x.pacote) || 1, itens });
    }
    const nomeArq = etqTexto(b.nome, 200), eu = req.usuario;
    const out = await estqTx(async cli => {
      const arq = await cli.query(`INSERT INTO etq_arquivos (nome, usuario_id, usuario_nome, total) VALUES ($1,$2,$3,$4) RETURNING id, enviado_em`,
        [nomeArq, eu.id, eu.nome, limpas.length]);
      const arquivoId = arq.rows[0].id;
      const situacoes = [];
      let repetidas = 0;
      for (const e of limpas) {
        const a = await cli.query('SELECT * FROM etq_etiquetas WHERE rastreio = $1 FOR UPDATE', [e.rastreio]);
        if (!a.rows.length) {
          await cli.query(`INSERT INTO etq_etiquetas (rastreio, pedido, pacote, arquivo_id, enviado_por, enviado_por_id) VALUES ($1,$2,$3,$4,$5,$6)`,
            [e.rastreio, e.pedido, e.pacote, arquivoId, eu.nome, eu.id]);
          for (const it of e.itens) await cli.query(`INSERT INTO etq_itens (rastreio, sku, variacao, produto, qtd) VALUES ($1,$2,$3,$4,$5)`,
            [e.rastreio, it.sku, it.variacao, it.produto, it.qtd]);
          situacoes.push({ rastreio: e.rastreio, situacao: 'nova' });
          continue;
        }
        const ant = a.rows[0];
        if (ant.impressa_em) {
          repetidas++;
          situacoes.push({ rastreio: e.rastreio, situacao: 'impressa', por: ant.impressa_por, em: ant.impressa_em.toISOString() });
          continue;
        }
        // Ainda não impressa: atualiza os itens com a leitura mais recente, desde que nada tenha sido lançado no estoque.
        const lanc = await cli.query(`SELECT 1 FROM etq_itens WHERE rastreio = $1 AND estado <> '' LIMIT 1`, [e.rastreio]);
        if (!lanc.rows.length) {
          await cli.query('DELETE FROM etq_itens WHERE rastreio = $1', [e.rastreio]);
          for (const it of e.itens) await cli.query(`INSERT INTO etq_itens (rastreio, sku, variacao, produto, qtd) VALUES ($1,$2,$3,$4,$5)`,
            [e.rastreio, it.sku, it.variacao, it.produto, it.qtd]);
          await cli.query('UPDATE etq_etiquetas SET pedido = $2, pacote = $3 WHERE rastreio = $1', [e.rastreio, e.pedido, e.pacote]);
        }
        if (ant.enviado_por_id !== eu.id) situacoes.push({ rastreio: e.rastreio, situacao: 'enviada', por: ant.enviado_por, em: ant.enviado_em.toISOString() });
        else situacoes.push({ rastreio: e.rastreio, situacao: 'nova' });
      }
      await cli.query('UPDATE etq_arquivos SET novas = $2, repetidas = $3 WHERE id = $1', [arquivoId, limpas.length - repetidas, repetidas]);
      return { arquivo_id: arquivoId, enviado_em: arq.rows[0].enviado_em.toISOString(), situacoes };
    });
    // Reimpressões já feitas e vínculo de cada SKU com o estoque.
    const rastreios = limpas.map(e => e.rastreio);
    const rp = await pool.query(`SELECT rastreio, COUNT(*)::INTEGER AS n FROM etq_reimpressoes WHERE rastreio = ANY($1::text[]) GROUP BY rastreio`, [rastreios]);
    const nRe = {}; rp.rows.forEach(x => { nRe[x.rastreio] = x.n; });
    out.situacoes.forEach(s => { s.reimpressoes = nRe[s.rastreio] || 0; });
    const skus = Array.from(new Set([].concat.apply([], limpas.map(e => e.itens.map(i => i.sku.toLowerCase()))).filter(Boolean)));
    const vinc = skus.length ? await pool.query(`SELECT LOWER(sku_shopee) AS sku, produto_nome, cor FROM estq_itens WHERE LOWER(sku_shopee) = ANY($1::text[])`, [skus]) : { rows: [] };
    const mapa = {}; vinc.rows.forEach(v => { mapa[v.sku] = v.produto_nome + (v.cor ? ', ' + v.cor : ''); });
    etqAgendar(rastreios);   // etiqueta que já estava bipada antes do envio passa a reservar agora
    res.json({ arquivo_id: out.arquivo_id, enviado_em: out.enviado_em, etiquetas: out.situacoes, skus_vinculados: mapa, motivos_reimpressao: ETQ_MOTIVOS_REIMPRESSAO });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar o arquivo.' });
  }
});

// ── Baixar: marca como impressas as etiquetas que entraram no arquivo final ──
app.post('/api/etq/arquivos/:id/baixar', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const arquivoId = estqInt(req.params.id);
    const rastreios = (Array.isArray(req.body && req.body.rastreios) ? req.body.rastreios : []).map(etqRastreio).filter(Boolean).slice(0, ETQ_MAX_POR_ARQUIVO);
    if (!arquivoId || !rastreios.length) return res.status(400).json({ erro: 'Nenhuma etiqueta para baixar.' });
    const arq = await pool.query('SELECT id, usuario_id FROM etq_arquivos WHERE id = $1', [arquivoId]);
    if (!arq.rows.length) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    if (arq.rows[0].usuario_id !== req.usuario.id) return res.status(403).json({ erro: 'Este arquivo foi enviado por outro usuário.' });
    const out = await estqTx(async cli => {
      // Só marca o que ainda não foi impresso. Se outra pessoa imprimiu nesse meio tempo, devolve quem foi.
      const marc = await cli.query(`
        UPDATE etq_etiquetas SET impressa_em = NOW(), impressa_por = $2
        WHERE rastreio = ANY($1::text[]) AND impressa_em IS NULL
        RETURNING rastreio, impressa_em
      `, [rastreios, req.usuario.nome]);
      await cli.query('UPDATE etq_arquivos SET baixado_em = NOW() WHERE id = $1', [arquivoId]);
      const todas = await cli.query('SELECT rastreio, impressa_em, impressa_por FROM etq_etiquetas WHERE rastreio = ANY($1::text[])', [rastreios]);
      const minhas = new Set(marc.rows.map(x => x.rastreio));
      return todas.rows.map(x => ({ rastreio: x.rastreio, marcada: minhas.has(x.rastreio), por: x.impressa_por, em: x.impressa_em ? x.impressa_em.toISOString() : null }));
    });
    res.json({ ok: true, etiquetas: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar a impressão.' });
  }
});

// ── Reimpressão: qualquer usuário, com a própria senha e o motivo ─────
app.post('/api/etq/reimprimir', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const b = req.body || {};
    const rastreio = etqRastreio(b.rastreio), motivo = String(b.motivo || '').trim();
    if (!rastreio) return res.status(400).json({ erro: 'Etiqueta inválida.' });
    if (!ETQ_MOTIVOS_REIMPRESSAO.includes(motivo)) return res.status(400).json({ erro: 'Selecione o motivo.' });
    if (!(await estqSenhaConfere(req, b.senha))) return res.status(401).json({ erro: 'Senha incorreta.' });
    const e = await pool.query('SELECT impressa_em, impressa_por FROM etq_etiquetas WHERE rastreio = $1', [rastreio]);
    if (!e.rows.length) return res.status(404).json({ erro: 'Etiqueta não encontrada.' });
    if (!e.rows[0].impressa_em) return res.status(400).json({ erro: 'Esta etiqueta ainda não foi impressa. Baixe o arquivo normalmente.' });
    const r = await pool.query(`INSERT INTO etq_reimpressoes (rastreio, usuario_nome, motivo) VALUES ($1,$2,$3) RETURNING criado_em`, [rastreio, req.usuario.nome, motivo]);
    const n = await pool.query('SELECT COUNT(*)::INTEGER AS n FROM etq_reimpressoes WHERE rastreio = $1', [rastreio]);
    console.log(`REIMPRESSAO: ${rastreio} por ${req.usuario.nome} (${motivo})`);
    res.json({ ok: true, em: r.rows[0].criado_em.toISOString(), por: req.usuario.nome, reimpressoes: n.rows[0].n });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao registrar a reimpressão.' });
  }
});

// ── Histórico de arquivos enviados e reimpressões: 50 por página ──────
app.get('/api/etq/historico', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const tot = await pool.query('SELECT (SELECT COUNT(*) FROM etq_arquivos)::INTEGER + (SELECT COUNT(*) FROM etq_reimpressoes)::INTEGER AS n');
    const total = tot.rows[0].n, paginas = Math.max(1, Math.ceil(total / ESTQ_POR_PAGINA));
    const pagina = Math.min(Math.max(1, estqInt(req.query.pagina) || 1), paginas);
    const r = await pool.query(`
      SELECT * FROM (
        SELECT 'arquivo' AS tipo, a.id, a.enviado_em AS em, a.usuario_nome AS usuario, a.nome, a.total, a.novas, a.repetidas, a.baixado_em,
               NULL::TEXT AS rastreio, NULL::TEXT AS motivo, NULL::TEXT AS primeira_por, NULL::TIMESTAMPTZ AS primeira_em
        FROM etq_arquivos a
        UNION ALL
        SELECT 'reimpressao', p.id, p.criado_em, p.usuario_nome, NULL, 1, 0, 1, p.criado_em,
               p.rastreio, p.motivo, e.impressa_por, e.impressa_em
        FROM etq_reimpressoes p LEFT JOIN etq_etiquetas e ON e.rastreio = p.rastreio
      ) h
      ORDER BY em DESC, id DESC
      LIMIT ${ESTQ_POR_PAGINA} OFFSET ${(pagina - 1) * ESTQ_POR_PAGINA}
    `);
    res.json({ pagina, paginas, total, por_pagina: ESTQ_POR_PAGINA, linhas: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar o histórico.' });
  }
});

// ── Corrigir pedido e itens de uma etiqueta (casamento manual no Gerador) ──
// Só enquanto a etiqueta não foi impressa nem teve estoque lançado.
app.put('/api/etq/etiquetas/:rastreio/itens', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const rastreio = etqRastreio(req.params.rastreio), b = req.body || {};
    if (!rastreio) return res.status(400).json({ erro: 'Etiqueta inválida.' });
    const itens = [];
    for (const it of (Array.isArray(b.itens) ? b.itens : []).slice(0, 50)) {
      const qtd = estqInt(it && it.qtd);
      if (!qtd || qtd < 1 || qtd > 9999) return res.status(400).json({ erro: 'Há item com quantidade inválida.' });
      itens.push({ sku: etqTexto(it.sku, 80), variacao: etqTexto(it.variacao, 120), produto: etqTexto(it.produto, 200), qtd });
    }
    const out = await estqTx(async cli => {
      const a = await cli.query('SELECT impressa_em FROM etq_etiquetas WHERE rastreio = $1 FOR UPDATE', [rastreio]);
      if (!a.rows.length) return { status: 404, erro: 'Etiqueta não encontrada.' };
      if (a.rows[0].impressa_em) return { status: 400, erro: 'Etiqueta já impressa: os itens não podem mais ser alterados.' };
      const lanc = await cli.query(`SELECT 1 FROM etq_itens WHERE rastreio = $1 AND estado <> '' LIMIT 1`, [rastreio]);
      if (lanc.rows.length) return { status: 400, erro: 'Esta etiqueta já foi bipada: os itens não podem mais ser alterados.' };
      await cli.query('DELETE FROM etq_itens WHERE rastreio = $1', [rastreio]);
      for (const it of itens) await cli.query(`INSERT INTO etq_itens (rastreio, sku, variacao, produto, qtd) VALUES ($1,$2,$3,$4,$5)`, [rastreio, it.sku, it.variacao, it.produto, it.qtd]);
      await cli.query('UPDATE etq_etiquetas SET pedido = $2, pacote = $3 WHERE rastreio = $1', [rastreio, etqTexto(b.pedido, 40).toUpperCase(), estqInt(b.pacote) || 1]);
      return { ok: true };
    });
    if (out.erro) return res.status(out.status).json({ erro: out.erro });
    etqAgendar([rastreio]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar os itens da etiqueta.' });
  }
});

// ── SKUs que chegaram em etiquetas e ainda não têm vínculo no estoque ─
app.get('/api/etq/skus-pendentes', autenticar, estqDisponivel, etqDisponivel, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT i.sku, MAX(i.variacao) AS variacao, MAX(i.produto) AS produto, COUNT(DISTINCT i.rastreio)::INTEGER AS etiquetas
      FROM etq_itens i JOIN etq_etiquetas e ON e.rastreio = i.rastreio
      WHERE e.enviado_em > NOW() - INTERVAL '120 days' AND i.sku <> ''
        AND NOT EXISTS (SELECT 1 FROM estq_itens s WHERE LOWER(s.sku_shopee) = LOWER(i.sku))
      GROUP BY i.sku ORDER BY COUNT(DISTINCT i.rastreio) DESC, i.sku LIMIT 200
    `);
    res.json({ skus: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao carregar os SKUs pendentes.' });
  }
});


// ── Health check / Railway ────────────────────────────────────
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.json({ status: 'online', mensagem: 'API Bipagem', data: new Date() }));

initDB()
  .then(() => initEstoque())
  .then(() => initLotes())
  .then(() => initInsumos())
  .then(() => initEstq())
  .then(() => initEtq())
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`✓ Servidor na porta ${PORT}`));
  })
  .catch(err => { console.error('❌ Erro:', err); process.exit(1); });
