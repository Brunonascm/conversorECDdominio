// =============================================================================
// xlsxlite.js — leitor minimo de .xlsx, sem dependencia externa
//
// Substitui o pd.read_excel(..., header=None, dtype=str). So precisa ler:
// primeira planilha, todas as linhas, quatro primeiras colunas, tudo como texto.
//
// Usa DecompressionStream('deflate-raw'), que ja e' nativo nos navegadores
// atuais. Nao carrega uma biblioteca de ~900 KB para fazer isso.
//
// O dtype=str do pandas existia para impedir que o codigo 50 virasse "50.0" e a
// classificacao 1110101001 virasse "1110101001.0" quando havia linha em branco
// na planilha. Aqui o problema nao existe na origem: o valor numerico inteiro e'
// devolvido como o texto cru do XML, sem passar por float.
// =============================================================================

const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function u16(dv, p) { return dv.getUint16(p, true); }
function u32(dv, p) { return dv.getUint32(p, true); }

function lerDiretorioCentral(buf) {
  const dv = new DataView(buf);
  const limite = Math.max(0, buf.byteLength - 66000);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= limite; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo nao parece ser um .xlsx valido (ZIP sem indice).');

  const total = u16(dv, eocd + 10);
  const inicio = u32(dv, eocd + 16);
  if (total === 0xFFFF || inicio === 0xFFFFFFFF) {
    throw new Error('Planilha em formato ZIP64 nao suportada. Salve novamente pelo Excel.');
  }

  const entradas = new Map();
  const dec = new TextDecoder('utf-8');
  let p = inicio;
  for (let n = 0; n < total; n++) {
    if (u32(dv, p) !== 0x02014b50) break;
    const metodo = u16(dv, p + 10);
    const tamComp = u32(dv, p + 20);
    const tamNome = u16(dv, p + 28);
    const tamExtra = u16(dv, p + 30);
    const tamCom = u16(dv, p + 32);
    const offLocal = u32(dv, p + 42);
    const nome = dec.decode(new Uint8Array(buf, p + 46, tamNome));
    entradas.set(nome, { metodo, tamComp, offLocal });
    p += 46 + tamNome + tamExtra + tamCom;
  }
  return entradas;
}

async function extrair(buf, entradas, nome) {
  const e = entradas.get(nome);
  if (!e) return null;
  const dv = new DataView(buf);
  if (u32(dv, e.offLocal) !== 0x04034b50) throw new Error('ZIP corrompido em ' + nome);
  const inicio = e.offLocal + 30 + u16(dv, e.offLocal + 26) + u16(dv, e.offLocal + 28);
  const bruto = new Uint8Array(buf, inicio, e.tamComp);

  let bytes;
  if (e.metodo === 0) {
    bytes = bruto;
  } else if (e.metodo === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Este navegador nao consegue descompactar .xlsx. Use Chrome, Edge ou Firefox atualizado.');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bruto]).stream().pipeThrough(ds);
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('Compressao ZIP nao suportada (metodo ' + e.metodo + ') em ' + nome);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function xml(texto) {
  const doc = new DOMParser().parseFromString(texto, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML invalido dentro do .xlsx.');
  return doc;
}

const tags = (no, nome) => no.getElementsByTagNameNS('*', nome);

// Texto de um <si> ou <is>, juntando as partes de texto rico e ignorando a
// anotacao fonetica <rPh>, igual ao openpyxl.
function textoDe(no) {
  let s = '';
  for (const t of tags(no, 't')) {
    let pai = t.parentNode, fonetico = false;
    while (pai && pai !== no) {
      if (pai.localName === 'rPh') { fonetico = true; break; }
      pai = pai.parentNode;
    }
    if (!fonetico) s += t.textContent;
  }
  return s;
}

function colunaDe(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Le o .xlsx e devolve uma matriz de strings (linhas x colunas).
 * Celula ausente vira "" — equivalente ao NaN do pandas depois do texto_celula().
 */
async function lerXlsx(arrayBuffer) {
  const entradas = lerDiretorioCentral(arrayBuffer);

  // Primeira planilha na ordem da pasta de trabalho (sheet_name=0 do pandas).
  const wb = await extrair(arrayBuffer, entradas, 'xl/workbook.xml');
  if (!wb) throw new Error('Arquivo .xlsx sem xl/workbook.xml. Salve novamente pelo Excel.');
  const primeira = tags(xml(wb), 'sheet')[0];
  if (!primeira) throw new Error('A planilha nao tem nenhuma aba.');

  let alvo = null;
  const rid = primeira.getAttributeNS(RELS_NS, 'id') || primeira.getAttribute('r:id');
  const relsTxt = await extrair(arrayBuffer, entradas, 'xl/_rels/workbook.xml.rels');
  if (rid && relsTxt) {
    for (const r of tags(xml(relsTxt), 'Relationship')) {
      if (r.getAttribute('Id') === rid) { alvo = r.getAttribute('Target'); break; }
    }
  }
  let caminho = alvo
    ? (alvo.startsWith('/') ? alvo.slice(1) : 'xl/' + alvo.replace(/^\.\//, ''))
    : 'xl/worksheets/sheet1.xml';
  if (!entradas.has(caminho)) caminho = 'xl/worksheets/sheet1.xml';

  // Textos compartilhados
  const sstTxt = await extrair(arrayBuffer, entradas, 'xl/sharedStrings.xml');
  const sst = [];
  if (sstTxt) for (const si of tags(xml(sstTxt), 'si')) sst.push(textoDe(si));

  const shTxt = await extrair(arrayBuffer, entradas, caminho);
  if (shTxt === null) throw new Error('Nao encontrei a primeira aba dentro do arquivo.');
  const doc = xml(shTxt);

  const linhas = [];
  let maxCol = 0;
  let idxImplicito = 0;

  for (const row of tags(doc, 'row')) {
    const rAttr = row.getAttribute('r');
    const idx = rAttr ? parseInt(rAttr, 10) - 1 : idxImplicito;
    idxImplicito = idx + 1;
    while (linhas.length <= idx) linhas.push([]);
    const destino = linhas[idx];

    let colImplicita = 0;
    for (const c of tags(row, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? colunaDe(ref) : colImplicita;
      colImplicita = col + 1;
      if (col > maxCol) maxCol = col;
      while (destino.length <= col) destino.push('');
      destino[col] = valorCelula(c, sst);
    }
  }

  const larg = maxCol + 1;
  for (const l of linhas) while (l.length < larg) l.push('');
  return linhas;
}

function valorCelula(c, sst) {
  const t = c.getAttribute('t') || 'n';
  if (t === 'inlineStr') {
    const is = tags(c, 'is')[0];
    return is ? textoDe(is) : '';
  }
  const v = tags(c, 'v')[0];
  if (!v) return '';
  const bruto = v.textContent;

  if (t === 's') {
    const i = parseInt(bruto, 10);
    return Number.isFinite(i) && sst[i] !== undefined ? sst[i] : '';
  }
  if (t === 'str' || t === 'e' || t === 'd') return bruto;
  if (t === 'b') return bruto === '1' ? 'True' : 'False';

  // Numerico. Inteiro fica com o texto cru do XML: e' isso que impede uma
  // classificacao longa de perder precisao ao virar double.
  const s = bruto.trim();
  if (/^-?\d+$/.test(s)) return s;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}
