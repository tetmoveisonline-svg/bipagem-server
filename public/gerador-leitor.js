/* Leitor do arquivo de etiquetas da Shopee (roda no navegador).
   Entrada: o ZIP da Shopee (etiquetas em ZPL + romaneio em PDF), ou os dois arquivos soltos.
   Saída: cada etiqueta com rastreio, pedido e itens (SKU, variação, quantidade), e o ZPL com o SKU no rodapé.
   Nada é enviado ao servidor aqui: a leitura acontece no computador de quem enviou. */
(function () {
  'use strict';
  const AQUI = (document.currentScript && document.currentScript.src) || document.baseURI;

  /* ───────── ZIP (sem biblioteca: usa o descompactador do próprio navegador) ───────── */
  async function inflar(bytes, formato) {
    const ds = new DecompressionStream(formato);
    const resp = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await resp.arrayBuffer());
  }
  async function lerZip(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf);
    let fim = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
    }
    if (fim < 0) throw new Error('O arquivo não é um ZIP válido.');
    const total = dv.getUint16(fim + 10, true);
    let p = dv.getUint32(fim + 16, true);
    const arquivos = [];
    for (let n = 0; n < total; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const metodo = dv.getUint16(p + 10, true), tamComp = dv.getUint32(p + 20, true);
      const lenNome = dv.getUint16(p + 28, true), lenExtra = dv.getUint16(p + 30, true), lenCom = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const nome = new TextDecoder().decode(b.subarray(p + 46, p + 46 + lenNome));
      const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const comp = b.subarray(ini, ini + tamComp);
      if (!nome.endsWith('/')) {
        let dados;
        if (metodo === 0) dados = comp.slice();
        else if (metodo === 8) dados = await inflar(comp, 'deflate-raw');
        else throw new Error('ZIP com compressão não suportada.');
        arquivos.push({ nome, dados });
      }
      p += 46 + lenNome + lenExtra + lenCom;
    }
    return arquivos;
  }

  /* ───────── ZPL: achar e decodificar a imagem de cada etiqueta ───────── */
  function b64Bytes(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Hexadecimal do ZPL, com a compactação por repetição (G..Y, g..z, vírgula, !, :).
  function hexZpl(txt, total, porLinha) {
    const out = new Uint8Array(total);
    const nibPorLinha = porLinha * 2;
    let nib = 0, rep = 0;
    const put = (v) => { if ((nib >> 1) < total) { if (nib & 1) out[nib >> 1] |= v; else out[nib >> 1] = v << 4; } nib++; };
    const valor = (c) => parseInt(c, 16);
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i], k = txt.charCodeAt(i);
      if (k >= 71 && k <= 89) { rep += k - 70; continue; }            // G..Y = 1..19
      if (k >= 103 && k <= 122) { rep += (k - 102) * 20; continue; }  // g..z = 20..400
      if (c === ',') { while (nib % nibPorLinha) put(0); rep = 0; continue; }
      if (c === '!') { while (nib % nibPorLinha) put(15); rep = 0; continue; }
      if (c === ':') { const ini = nib - nibPorLinha; if (ini >= 0) for (let j = 0; j < nibPorLinha; j++) { const s = ini + j; put((s & 1) ? (out[s >> 1] & 15) : (out[s >> 1] >> 4)); } rep = 0; continue; }
      if (/[0-9A-Fa-f]/.test(c)) { const v = valor(c), q = rep || 1; for (let j = 0; j < q; j++) put(v); rep = 0; }
    }
    return out;
  }
  async function dadosGrafico(txt, total, porLinha) {
    const t = txt.trim();
    let m = /^:Z64:([A-Za-z0-9+/=\s]+):[0-9A-Fa-f]{4}/.exec(t);
    if (m) return await inflar(b64Bytes(m[1].replace(/\s+/g, '')), 'deflate');
    m = /^:B64:([A-Za-z0-9+/=\s]+):[0-9A-Fa-f]{4}/.exec(t);
    if (m) return b64Bytes(m[1].replace(/\s+/g, ''));
    return hexZpl(t, total, porLinha);
  }
  // Devolve um trecho do arquivo por etiqueta, com a imagem (1 bit por ponto, 1 = preto).
  async function lerZpl(texto) {
    const etiquetas = [];
    const re = /~DG([^,]*),(\d+),(\d+),/g;
    const marcas = [];
    let m;
    while ((m = re.exec(texto))) marcas.push({ ini: m.index, fimCab: re.lastIndex, total: +m[2], porLinha: +m[3] });
    for (let i = 0; i < marcas.length; i++) {
      const k = marcas[i], fimTrecho = i + 1 < marcas.length ? marcas[i + 1].ini : texto.length;
      const trecho = texto.slice(k.ini, fimTrecho);
      const xa = texto.indexOf('^XA', k.fimCab);
      if (xa < 0 || xa > fimTrecho) continue;
      const bytes = await dadosGrafico(texto.slice(k.fimCab, xa), k.total, k.porLinha);
      if (!k.porLinha || bytes.length < k.porLinha) continue;
      etiquetas.push({ trecho, bytes, largura: k.porLinha * 8, altura: Math.floor(bytes.length / k.porLinha), porLinha: k.porLinha });
    }
    return etiquetas;
  }
  function paraCanvas(e) {
    const c = document.createElement('canvas'); c.width = e.largura; c.height = e.altura;
    const ctx = c.getContext('2d'), img = ctx.createImageData(e.largura, e.altura), d = img.data;
    for (let y = 0; y < e.altura; y++) for (let x = 0; x < e.largura; x++) {
      const preto = (e.bytes[y * e.porLinha + (x >> 3)] >> (7 - (x & 7))) & 1;
      const o = (y * e.largura + x) * 4, v = preto ? 0 : 255;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* ───────── Rastreio: QR code da etiqueta ───────── */
  function lerQr(canvas) {
    if (typeof jsQR !== 'function') return null;
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d');
    const areas = [[0, 0, W, H], [W / 2, 0, W / 2, H / 3], [0, H * 0.2, W / 2, H * 0.3], [W / 2, H * 0.6, W / 2, H * 0.25], [0, 0, W, H / 2], [0, H / 2, W, H / 2]];
    for (const a of areas) {
      const x = Math.floor(a[0]), y = Math.floor(a[1]), w = Math.floor(a[2]), h = Math.floor(a[3]);
      try {
        const d = ctx.getImageData(x, y, w, h);
        const r = jsQR(d.data, w, h, { inversionAttempts: 'dontInvert' });
        if (r && r.data && r.data.trim().length >= 6) return r.data.trim().toUpperCase();
      } catch (e) {}
    }
    return null;
  }

  /* ───────── Romaneio em PDF ───────── */
  async function lerRomaneio(bytes) {
    if (!window.pdfjsLib) throw new Error('Leitor de PDF não carregado.');
    const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const blocos = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      // O romaneio vem girado na página. Passa cada texto para o sistema de leitura dele:
      // u = posição ao longo da linha, v = posição da linha (cresce para baixo).
      const its = [];
      for (const it of tc.items) {
        const s = (it.str || '').trim(); if (!s) continue;
        const a = it.transform[0], b = it.transform[1], e = it.transform[4], f = it.transform[5];
        const nrm = Math.hypot(a, b) || 1, ax = a / nrm, bx = b / nrm;
        its.push({ s, u: e * ax + f * bx, v: e * bx - f * ax, w: it.width || 0 });
      }
      const cabs = its.filter(i => /^Produto$/i.test(i.s));
      const linhasCab = [];
      cabs.sort((p, q) => p.v - q.v || p.u - q.u).forEach(c => {
        const l = linhasCab.find(x => Math.abs(x.v - c.v) < 3); if (l) l.itens.push(c); else linhasCab.push({ v: c.v, itens: [c] });
      });
      linhasCab.forEach((linha, li) => {
        linha.itens.sort((p, q) => p.u - q.u);
        const vAnt = li > 0 ? linhasCab[li - 1].v : -Infinity;
        const vProx = li + 1 < linhasCab.length ? linhasCab[li + 1].v : Infinity;
        linha.itens.forEach((cab, ci) => {
          const u0 = cab.u - 22, u1 = ci + 1 < linha.itens.length ? linha.itens[ci + 1].u - 22 : Infinity;
          const dentro = its.filter(i => i.u >= u0 && i.u < u1);
          const naLinha = dentro.filter(i => Math.abs(i.v - linha.v) < 3);
          // O título da coluna pode vir colado ao vizinho no mesmo texto ("Qnt SKU"): estima a posição dentro dele.
          const col = (rx) => { for (const i of naLinha) { const mm = rx.exec(i.s); if (mm) return i.u + (i.s.length ? i.w * mm.index / i.s.length : 0); } return null; };
          const uVar = col(/Varia/i), uQnt = col(/\b(Qnt|Qtd|Quant)/i), uSku = col(/\bSKU\b/i);
          if (uVar == null || uQnt == null || uSku == null) return;
          // Pedido: texto ao lado de "ID Pedido", acima do cabeçalho da tabela.
          const acima = dentro.filter(i => i.v < linha.v - 3 && i.v > vAnt + 3).sort((p, q) => q.v - p.v || p.u - q.u);
          let pedido = '', pacote = 1;
          const anc = acima.find(i => /ID\s*Pedido/i.test(i.s));
          if (anc) {
            let resto = anc.s.replace(/.*ID\s*Pedido\s*:?/i, '').trim();
            if (!resto) { const viz = acima.filter(i => i !== anc && Math.abs(i.v - anc.v) < 3 && i.u > anc.u).sort((p, q) => p.u - q.u)[0]; resto = viz ? viz.s : ''; }
            const mm = /^([A-Za-z0-9]+)(?:\s+package\s+(\d+))?/i.exec(resto);
            if (mm) { pedido = mm[1].toUpperCase(); pacote = mm[2] ? +mm[2] : 1; }
            if (mm && !mm[2]) { const pk = acima.map(i => /package\s+(\d+)/i.exec(i.s)).filter(Boolean)[0]; if (pk) pacote = +pk[1]; }
          }
          if (!pedido) return;
          // Linhas da tabela: cada número na primeira coluna abre um item.
          // O bloco deste pedido termina onde começa o próximo (linha de corte ou novo "ID Pedido").
          const marcos = dentro.filter(i => i.v > linha.v + 3 && /^(Corte aqui|Checklist|ID\s*Pedido)/i.test(i.s)).map(i => i.v);
          const vFim = Math.min(vProx - 3, marcos.length ? Math.min.apply(null, marcos) - 1 : Infinity);
          const abaixo = dentro.filter(i => i.v > linha.v + 3 && i.v < vFim);
          const inicios = abaixo.filter(i => i.u < cab.u - 4 && /^\d+$/.test(i.s)).sort((p, q) => p.v - q.v);
          const itens = [];
          inicios.forEach((ini, k) => {
            const vF = k + 1 < inicios.length ? inicios[k + 1].v - 2 : Infinity;
            const cel = abaixo.filter(i => i.v >= ini.v - 2 && i.v < vF && i !== ini).sort((p, q) => p.v - q.v || p.u - q.u);
            const junta = (a, b, sep) => cel.filter(i => i.u >= a - 4 && i.u < b - 4).map(i => i.s).join(sep).trim();
            const qtd = parseInt(junta(uQnt, uSku, ''), 10);
            itens.push({ produto: junta(cab.u, uVar, ' '), variacao: junta(uVar, uQnt, ' '), qtd: Number.isInteger(qtd) && qtd > 0 ? qtd : 1, sku: junta(uSku, Infinity, '') });
          });
          blocos.push({ pedido, pacote, itens, pagina: n });
        });
      });
    }
    return blocos;
  }

  /* ───────── Casar etiqueta com pedido: lê o número do pedido impresso na etiqueta ───────── */
  const CONFUSOES = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', '/': '7', Z: '2', S: '5', B: '8', G: '6' };
  const limpar = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9|/]/g, '');
  const normal = (s) => limpar(s).replace(/[OQDIL|/ZSBG]/g, c => CONFUSOES[c]);
  function distancia(a, b) {
    const n = a.length, m = b.length; if (!n) return m; if (!m) return n;
    let ant = new Array(m + 1), cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) ant[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      for (let j = 1; j <= m; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      const t = ant; ant = cur; cur = t;
    }
    return ant[m];
  }
  // Melhor semelhança (0 a 1) entre o pedido e qualquer trecho de uma linha lida.
  function semelhanca(pedido, linha) {
    let melhor = 0;
    [[limpar(pedido), limpar(linha)], [normal(pedido), normal(linha)]].forEach(([p, l]) => {
      if (!p || !l) return;
      const L = p.length;
      for (let tam = L - 2; tam <= L + 2; tam++) {
        if (tam < 4) continue;
        if (l.length <= tam) { melhor = Math.max(melhor, 1 - distancia(p, l) / Math.max(L, l.length)); continue; }
        for (let i = 0; i + tam <= l.length; i++) melhor = Math.max(melhor, 1 - distancia(p, l.substr(i, tam)) / Math.max(L, tam));
      }
    });
    return melhor;
  }
  let _ocr = null;
  async function ocr() {
    if (_ocr) return _ocr;
    if (!window.Tesseract) throw new Error('Leitor de texto não carregado.');
    const base = new URL('vendor/tess/', AQUI).href;
    _ocr = await Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true });
    return _ocr;
  }
  async function lerTexto(canvas, area) {
    const w = await ocr();
    let alvo = canvas;
    if (area) {
      alvo = document.createElement('canvas'); alvo.width = area[2]; alvo.height = area[3];
      alvo.getContext('2d').drawImage(canvas, area[0], area[1], area[2], area[3], 0, 0, area[2], area[3]);
    }
    const r = await w.recognize(alvo);
    return (r.data.text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  }
  const LIMIAR = 0.78, FOLGA = 0.12;

  /* ───────── Rodapé com SKU ───────── */
  const FAIXA_ALT = 68, FAIXA_MARGEM = 4;
  function faixaLivre(e) {
    // Maior faixa em branco no fim da etiqueta.
    let y = e.altura - 1, livre = 0;
    for (; y >= 0; y--) {
      let tinta = 0; const o = y * e.porLinha;
      for (let x = 0; x < e.porLinha; x++) if (e.bytes[o + x]) { tinta = 1; break; }
      if (tinta) break; livre++;
    }
    return livre;
  }
  function desenharRodape(largura, itens) {
    const c = document.createElement('canvas'); c.width = largura; c.height = FAIXA_ALT;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, largura, FAIXA_ALT);
    g.fillStyle = '#fff'; g.textBaseline = 'middle';
    const fonte = (px) => 'bold ' + px + 'px Arial, Helvetica, sans-serif';
    const cabe = (txt, px, max) => { g.font = fonte(px); while (px > 12 && g.measureText(txt).width > max) { px -= 1; g.font = fonte(px); } return px; };
    const caixaQtd = (txt, y, alt) => {
      g.font = fonte(alt > 40 ? 30 : 20); const w = g.measureText(txt).width + 20;
      g.fillStyle = '#fff'; g.fillRect(largura - w - 8, y, w, alt);
      g.fillStyle = '#000'; g.fillText(txt, largura - w + 2, y + alt / 2 + 1); g.fillStyle = '#fff';
      return w + 16;
    };
    if (itens.length === 1) {
      const it = itens[0], q = caixaQtd('QTD ' + it.qtd, 6, FAIXA_ALT - 12);
      g.font = fonte(22); g.fillText('SKU', 14, FAIXA_ALT / 2 + 2);
      const disp = largura - q - 78, sku = it.sku || 'SEM SKU';
      let px = cabe(sku, 54, disp * 0.55); g.fillText(sku, 68, FAIXA_ALT / 2 + 2);
      const wSku = g.measureText(sku).width, resto = disp - wSku - 26;
      if (it.variacao && resto > 60) { cabe(it.variacao, 30, resto); g.fillText(it.variacao, 68 + wSku + 24, FAIXA_ALT / 2 + 2); }
    } else if (itens.length === 2) {
      itens.forEach((it, i) => {
        const y = 3 + i * 32, q = caixaQtd('QTD ' + it.qtd, y, 29);
        const txt = (it.sku || 'SEM SKU') + (it.variacao ? '   ' + it.variacao : '');
        cabe(txt, 26, largura - q - 30); g.fillText(txt, 14, y + 15);
      });
    } else {
      const total = itens.reduce((s, i) => s + i.qtd, 0);
      const txt = itens.length + ' PRODUTOS, ' + total + ' UNIDADES. VER LISTA NA ETIQUETA SEGUINTE';
      cabe(txt, 28, largura - 28); g.fillText(txt, 14, FAIXA_ALT / 2 + 2);
    }
    return c;
  }
  function desenharLista(largura, pedido, rastreio, itens) {
    const linhaAlt = 54, alt = 150 + itens.length * linhaAlt;
    const c = document.createElement('canvas'); c.width = largura; c.height = alt;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, largura, alt); g.fillStyle = '#000'; g.textBaseline = 'middle';
    g.font = 'bold 34px Arial, Helvetica, sans-serif'; g.fillText('LISTA DE SEPARAÇÃO', 20, 36);
    g.font = '24px Arial, Helvetica, sans-serif'; g.fillText('Pedido ' + pedido + '   Rastreio ' + rastreio, 20, 80);
    g.fillRect(20, 108, largura - 40, 3);
    itens.forEach((it, i) => {
      const y = 150 + i * linhaAlt;
      g.font = 'bold 30px Arial, Helvetica, sans-serif'; g.fillText(it.qtd + ' x  ' + (it.sku || 'SEM SKU'), 20, y);
      const w = g.measureText(it.qtd + ' x  ' + (it.sku || 'SEM SKU')).width;
      g.font = '24px Arial, Helvetica, sans-serif'; g.fillText((it.variacao || '').slice(0, 40), 20 + w + 24, y);
    });
    return c;
  }
  function canvasParaGfa(c) {
    const w = c.width, h = c.height, porLinha = Math.ceil(w / 8), d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const HEX = '0123456789ABCDEF'; let hex = '';
    for (let y = 0; y < h; y++) for (let bx = 0; bx < porLinha; bx++) {
      let v = 0;
      for (let k = 0; k < 8; k++) { const x = bx * 8 + k; if (x < w) { const o = (y * w + x) * 4; if (d[o] + d[o + 1] + d[o + 2] < 384) v |= 0x80 >> k; } }
      hex += HEX[v >> 4] + HEX[v & 15];
    }
    const total = porLinha * h;
    return '^GFA,' + total + ',' + total + ',' + porLinha + ',' + hex;
  }
  // ZPL de uma etiqueta: o trecho original da Shopee, intacto, mais o rodapé desenhado por cima da área em branco.
  function zplComSku(et) {
    const yRodape = et.altura - FAIXA_ALT - FAIXA_MARGEM;
    const extra = '^FO0,' + yRodape + canvasParaGfa(desenharRodape(et.largura, et.itens)) + '^FS';
    const t = et.trecho;
    let pos = -1;
    const xg = t.indexOf('^XG');
    if (xg >= 0) { const fs = t.indexOf('^FS', xg); if (fs >= 0) pos = fs + 3; }
    if (pos < 0) { const xz = t.indexOf('^XZ'); pos = xz >= 0 ? xz : t.length; }
    let saida = t.slice(0, pos) + extra + t.slice(pos);
    if (et.itens.length > 2) saida = saida.replace(/\s*$/, '') + '\n^XA^FO0,20' + canvasParaGfa(desenharLista(et.largura, et.pedido, et.rastreio, et.itens)) + '^FS^XZ\n';
    return saida;
  }
  function previa(et, comSku) {
    const c = paraCanvas(et);
    if (comSku && et.itens && et.itens.length) c.getContext('2d').drawImage(desenharRodape(et.largura, et.itens), 0, et.altura - FAIXA_ALT - FAIXA_MARGEM);
    return c;
  }

  /* ───────── Fluxo completo ───────── */
  async function lerArquivos(files, progresso) {
    const avisa = (texto, feito, total) => { try { progresso && progresso({ texto, feito, total }); } catch (e) {} };
    let zplTxt = null, pdfBytes = null;
    const entradas = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      if (/\.zip$/i.test(f.name)) (await lerZip(buf)).forEach(a => entradas.push(a));
      else entradas.push({ nome: f.name, dados: new Uint8Array(buf) });
    }
    for (const a of entradas) {
      if (/\.pdf$/i.test(a.nome) && !pdfBytes) pdfBytes = a.dados;
      else if (/\.(txt|zpl|prn)$/i.test(a.nome) && !zplTxt) zplTxt = new TextDecoder('utf-8').decode(a.dados);
    }
    if (!zplTxt) throw new Error('Não encontrei o arquivo de etiquetas (ZPL) dentro do envio.');
    if (!pdfBytes) throw new Error('Não encontrei o romaneio (PDF) dentro do envio.');

    avisa('Lendo o romaneio', 0, 1);
    const blocos = await lerRomaneio(pdfBytes);
    if (!blocos.length) throw new Error('Não consegui ler nenhum pedido no romaneio.');
    avisa('Abrindo as etiquetas', 0, 1);
    const ets = await lerZpl(zplTxt);
    if (!ets.length) throw new Error('Formato de etiqueta não reconhecido. Envie este arquivo para análise.');

    // Rastreio e leitura do número do pedido, etiqueta por etiqueta.
    for (let i = 0; i < ets.length; i++) {
      avisa('Lendo etiqueta ' + (i + 1) + ' de ' + ets.length, i, ets.length);
      const e = ets[i], cv = paraCanvas(e);
      e.rastreio = lerQr(cv);
      e.linhas = await lerTexto(cv, [0, 0, e.largura, Math.floor(e.altura * 0.36)]);
      if (!e.rastreio) {
        const todas = await lerTexto(cv, null); e.linhasTodas = todas;
        const mm = /\b(BR[0-9A-Z]{10,16})\b/.exec(todas.join(' ').toUpperCase().replace(/[^A-Z0-9 ]/g, ' '));
        if (mm) { e.rastreio = mm[1]; e.rastreioPorTexto = true; }
      }
      e.livre = faixaLivre(e);
      e.pontos = blocos.map(b => Math.max.apply(null, e.linhas.map(l => semelhanca(b.pedido, l)).concat([0])));
    }
    // Atribuição: do par mais parecido para o menos, exigindo folga sobre o segundo colocado.
    const pedidosUnicos = Array.from(new Set(blocos.map(b => b.pedido)));
    const casar = () => {
      const pares = [];
      ets.forEach((e, i) => { if (e.pedido) return; pedidosUnicos.forEach(p => { const k = blocos.findIndex(b => b.pedido === p); pares.push({ i, p, s: e.pontos[k] }); }); });
      pares.sort((a, b) => b.s - a.s);
      pares.forEach(par => {
        const e = ets[par.i]; if (e.pedido || par.s < LIMIAR) return;
        const outros = pedidosUnicos.filter(p => p !== par.p).map(p => e.pontos[blocos.findIndex(b => b.pedido === p)]);
        const segundo = outros.length ? Math.max.apply(null, outros) : 0;
        if (par.s - segundo < FOLGA) return;
        const vagas = blocos.filter(b => b.pedido === par.p).length, usadas = ets.filter(x => x.pedido === par.p).length;
        if (usadas >= vagas) return;
        e.pedido = par.p; e.confianca = par.s;
      });
    };
    casar();
    // Segunda tentativa, lendo a etiqueta inteira, só para as que ficaram sem pedido.
    const faltam = ets.filter(e => !e.pedido);
    for (let j = 0; j < faltam.length; j++) {
      const e = faltam[j];
      avisa('Relendo etiqueta ' + (j + 1) + ' de ' + faltam.length, j, faltam.length);
      const todas = e.linhasTodas || await lerTexto(paraCanvas(e), null);
      e.pontos = blocos.map((b, k) => Math.max(e.pontos[k], Math.max.apply(null, todas.map(l => semelhanca(b.pedido, l)).concat([0]))));
    }
    if (faltam.length) casar();

    // Monta o resultado. Pedido com mais de um pacote: os pacotes seguem a ordem das etiquetas.
    const usados = {};
    const etiquetas = ets.map((e, idx) => {
      const r = { idx, rastreio: e.rastreio || '', pedido: e.pedido || '', confianca: e.confianca || 0, itens: [], pacote: 1, avisos: [],
        largura: e.largura, altura: e.altura, porLinha: e.porLinha, bytes: e.bytes, trecho: e.trecho, livre: e.livre };
      if (!r.rastreio) r.avisos.push('Rastreio não lido');
      if (e.rastreioPorTexto) r.avisos.push('Rastreio lido pelo texto, confira');
      if (e.livre < FAIXA_ALT + FAIXA_MARGEM) r.avisos.push('Sem área livre no rodapé');
      if (r.pedido) {
        const doPedido = blocos.filter(b => b.pedido === r.pedido).sort((a, b) => a.pacote - b.pacote);
        const n = usados[r.pedido] || 0; usados[r.pedido] = n + 1;
        const bloco = doPedido[Math.min(n, doPedido.length - 1)];
        r.itens = bloco.itens.map(i => Object.assign({}, i)); r.pacote = bloco.pacote;
        if (doPedido.length > 1) r.avisos.push('Pedido com mais de um pacote, confira');
        if (!r.itens.length) r.avisos.push('Romaneio sem itens');
        if (r.itens.some(i => !i.sku)) r.avisos.push('Item sem SKU no romaneio');
      } else r.avisos.push('Pedido não identificado');
      return r;
    });
    const casados = new Set(etiquetas.filter(e => e.pedido).map(e => e.pedido));
    return { etiquetas, pedidos: blocos, pedidosSemEtiqueta: pedidosUnicos.filter(p => !casados.has(p)) };
  }
  function definirPedido(resultado, et, pedido) {
    const bloco = resultado.pedidos.find(b => b.pedido === pedido);
    et.pedido = pedido || ''; et.itens = bloco ? bloco.itens.map(i => Object.assign({}, i)) : []; et.pacote = bloco ? bloco.pacote : 1; et.manual = true;
    et.avisos = et.avisos.filter(a => a !== 'Pedido não identificado');
  }
  async function encerrar() { if (_ocr) { try { await _ocr.terminate(); } catch (e) {} _ocr = null; } }

  window.EtqLeitor = { lerArquivos, zplComSku, previa, definirPedido, encerrar, _interno: { lerZip, lerZpl, lerRomaneio, semelhanca, paraCanvas, lerQr, FAIXA_ALT, FAIXA_MARGEM } };
})();
