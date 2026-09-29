// =============================================================================
// sped.js — leitura, analise e geracao dos arquivos
//
// Port de convECDprod.py. As decisoes de arquitetura do original continuam
// valendo aqui, so que agora o "servidor" e' o proprio navegador do usuario:
//
//   - LEITURA EM FLUXO: o arquivo e' lido em blocos de 8 MB e nunca existe como
//     texto inteiro na memoria. Os 277 MB do arquivo de teste custam ~8 MB de
//     pico, nao 277.
//   - UMA PASSADA SO: analisarSped percorre o arquivo uma unica vez.
//   - GERACAO DIFERIDA: o SPED ajustado so e' montado no clique, e vai direto
//     para o disco quando o navegador permite gravacao em fluxo.
//
// O arquivo nunca sai da maquina. Nao ha upload.
// =============================================================================


// str.strip() do Python: o conjunto de espacos dele nao e' igual ao do
// String.prototype.trim(). Faixa latin-1: \t \n \v \f \r \x1c-\x1f espaco \x85 \xa0
const ESPACOS = new Set([9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160]);

function pyStrip(s) {
  let a = 0, b = s.length;
  while (a < b && ESPACOS.has(s.charCodeAt(a))) a++;
  while (b > a && ESPACOS.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// latin-1 e' um mapeamento direto byte -> ponto de codigo, entao a decodificacao
// e' exata. Nao da para usar TextDecoder('latin1'): pela especificacao do
// navegador esse rotulo aponta para windows-1252, que difere nos bytes 80-9F.
const BLOCO_DEC = 0x8000;
function latin1Decode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += BLOCO_DEC) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + BLOCO_DEC));
  }
  return s;
}

// encode("latin-1", errors="replace"): o que nao cabe em um byte vira '?'.
function latin1Encode(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c <= 255 ? c : 63;
  }
  return out;
}

/**
 * Percorre o SPED linha a linha sem materializar o arquivo.
 * Mesmo filtro do original: descarta linha em branco e tira espacos das pontas.
 * Se `aoAchar` devolver false, a leitura para (usado no |9999|).
 */
async function percorrerLinhas(file, aoAchar, aposBloco) {
  const TAM = 8 * 1024 * 1024;
  let resto = '';
  let lidos = 0;

  for (let pos = 0; pos < file.size; pos += TAM) {
    const buf = await file.slice(pos, pos + TAM).arrayBuffer();
    lidos += buf.byteLength;
    const texto = resto + latin1Decode(new Uint8Array(buf));

    let ini = 0;
    for (;;) {
      const nl = texto.indexOf('\n', ini);
      if (nl < 0) break;
      const linha = pyStrip(texto.slice(ini, nl));
      ini = nl + 1;
      if (linha && aoAchar(linha) === false) { if (aposBloco) await aposBloco(lidos, file.size); return; }
    }
    resto = texto.slice(ini);
    if (aposBloco) await aposBloco(lidos, file.size);
  }

  const ultima = pyStrip(resto);
  if (ultima) aoAchar(ultima);
  if (aposBloco) await aposBloco(file.size, file.size);
}

function limparNomeArquivo(nome) {
  return pyStrip(nome.replace(/[\\/*?:"<>|]/g, ''));
}

// datetime.strptime(s, "%d%m%Y"). O \d{1,2} do Python e' guloso com retrocesso,
// e o do JavaScript tambem, entao a divisao dos campos e' a mesma.
function parseDataSped(s) {
  const m = /^(\d{1,2})(\d{1,2})(\d{4})$/.exec(s);
  if (!m) return null;
  const d = +m[1], mes = +m[2], y = +m[3];
  if (mes < 1 || mes > 12 || d < 1) return null;
  const ultimo = new Date(Date.UTC(y, mes, 0)).getUTCDate();
  if (d > ultimo) return null;
  return new Date(Date.UTC(y, mes - 1, d));
}

const ddmmyyyy = (dt) =>
  String(dt.getUTCDate()).padStart(2, '0') + '/' +
  String(dt.getUTCMonth() + 1).padStart(2, '0') + '/' +
  dt.getUTCFullYear();

// float() do Python: string vazia ou invalida levanta excecao, que o original
// captura devolvendo 0.0. Number('') seria 0 e Number('0x10') seria 16, entao
// o formato e' validado antes.
function pyFloat(s) {
  const t = pyStrip(s);
  if (!/^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(t)) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// =============================================================================
// ANALISE DO SPED — uma unica passada
// =============================================================================
async function analisarSped(file, aoProgredir) {
  let nomeEmpresa = 'EMPRESA';
  let dtInicial = null, dtFinal = null;

  const initialBalances = new Map();
  const finalBalances = new Map();
  const contasComMovimento = new Set();
  const contasI050 = [];
  let qtdI150 = 0;
  let achou0000 = false;

  await percorrerLinhas(file, (line) => {
    if (line.startsWith('|0000|')) {
      if (!achou0000) {
        achou0000 = true;
        const p = line.split('|');
        if (p.length > 5) nomeEmpresa = limparNomeArquivo(p[5]);
        if (p.length > 3) dtInicial = parseDataSped(p[3]);
        if (p.length > 4) dtFinal = parseDataSped(p[4]);
      }
    } else if (line.startsWith('|I150|')) {
      qtdI150++;
    } else if (line.startsWith('|I155|')) {
      const reg = line.split('|');
      if (reg.length >= 10) {
        const cod = pyStrip(reg[2]);
        const valIni = pyStrip(reg[4]);
        const dcIni = pyStrip(reg[5]);
        const valFim = pyStrip(reg[8]);
        const dcFim = pyStrip(reg[9]);
        if (!initialBalances.has(cod)) {
          // Com mais de um periodo I150, o saldo inicial valido e' o do primeiro.
          initialBalances.set(cod, qtdI150 <= 1 ? [valIni, dcIni] : ['0,00', dcIni]);
        }
        finalBalances.set(cod, [valFim, dcFim]);
      }
      if (reg.length > 2) contasComMovimento.add(pyStrip(reg[2]));
    } else if (line.startsWith('|I250|')) {
      const reg = line.split('|');
      if (reg.length > 2) contasComMovimento.add(pyStrip(reg[2]));
    } else if (line.startsWith('|I050|')) {
      const reg = line.split('|');
      if (reg.length > 6) contasI050.push([pyStrip(reg[6]), reg.slice(7)]);
    }
  }, aoProgredir);

  const contasOrigem = [];
  const vistos = new Set();
  for (const [codCta, resto] of contasI050) {
    if (!contasComMovimento.has(codCta) || vistos.has(codCta)) continue;
    vistos.add(codCta);

    // Heuristica original do nome, reproduzida inclusive na assimetria: o
    // comprimento e' medido no campo sem espacos, mas o teste de "e' numero"
    // roda no campo cru.
    let nomeConta = 'Sem Nome';
    for (const campo of resto) {
      if (pyStrip(campo).length > 2 && !isNumeric(campo.replace(/\./g, ''))) {
        nomeConta = pyStrip(campo);
        break;
      }
    }

    const classifRaw = codCta;
    const classifLimpa = classifRaw.replace(/^0+/, '');
    const grupo = classifLimpa.length > 0 ? classifLimpa[0] : (classifRaw.length > 0 ? classifRaw[0] : '');

    contasOrigem.push({ cod: codCta, classif: classifRaw, nome: nomeConta, grupo });
  }

  return {
    nomeEmpresa, dtInicial, dtFinal,
    initialBalances, finalBalances, contasOrigem,
    qtdPeriodosI150: qtdI150,
  };
}

// str.isnumeric(): falso para string vazia.
function isNumeric(s) {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

// =============================================================================
// PLANO DE CONTAS
// =============================================================================
function textoCelula(valor) {
  if (valor === null || valor === undefined) return '';
  let texto = pyStrip(String(valor));
  const low = texto.toLowerCase();
  if (low === 'nan' || low === 'nat' || low === 'none' || low === '<na>') return '';
  if (/^-?\d+\.0+$/.test(texto)) texto = texto.split('.')[0];
  return texto;
}

function prepararPlano(matriz) {
  const largura = matriz.length ? matriz[0].length : 0;
  if (largura < 3) {
    throw new Error('A planilha precisa de pelo menos 3 colunas: codigo, classificacao e nome.');
  }
  const temTipo = largura >= 4;

  const contas = [];
  for (const linha of matriz) {
    const codigo = textoCelula(linha[0]);
    const classificacao = textoCelula(linha[1]);
    const nome = textoCelula(linha[2]);
    let tipo = temTipo ? textoCelula(linha[3]) : 'A';

    // Linha sem codigo ou sem nome e' linha em branco da planilha.
    if (codigo === '' || nome === '') continue;

    tipo = tipo.toUpperCase();
    if (tipo.startsWith('S')) continue;   // sintetica nao e' destino

    const limpa = pyStrip(classificacao).replace(/^0+/, '');
    const grupo = limpa.length ? limpa[0] : '0';

    contas.push({
      Codigo: codigo,
      Nome: nome,
      Display: `${codigo} | ${classificacao} - ${nome}`,
      Grupo: grupo,
    });
  }

  const porCodigo = new Map();
  const porGrupo = new Map();
  for (const c of contas) {
    if (!porCodigo.has(c.Codigo)) porCodigo.set(c.Codigo, c);
    if (!porGrupo.has(c.Grupo)) porGrupo.set(c.Grupo, []);
    porGrupo.get(c.Grupo).push(c);
  }
  const naoPatrimoniais = contas.filter((c) => c.Grupo !== '1' && c.Grupo !== '2');

  return { contas, porCodigo, porGrupo, naoPatrimoniais };
}

/**
 * Opcoes oferecidas no menu. Atencao: a regra NAO e' a mesma usada na busca por
 * similaridade. Para os grupos 1 e 2 usa o proprio grupo; para qualquer outro,
 * usa todas as contas que nao sejam 1 nem 2.
 */
function candidatasOpcoes(plano, grupo) {
  if (grupo === '1' || grupo === '2') {
    const f = plano.porGrupo.get(grupo);
    return f && f.length ? f : plano.contas;
  }
  return plano.naoPatrimoniais.length ? plano.naoPatrimoniais : plano.contas;
}

// =============================================================================
// MOTOR DE SUGESTAO — media entre token_set_ratio e token_sort_ratio, corte 65
// =============================================================================
async function sugerirMapeamento(contasOrigem, plano, aoProgredir) {
  const cache = new Map();
  const sugestoes = new Map();

  for (let i = 0; i < contasOrigem.length; i++) {
    const conta = contasOrigem[i];

    let grupoCache = cache.get(conta.grupo);
    if (!grupoCache) {
      const doGrupo = plano.porGrupo.get(conta.grupo);
      const candidatas = doGrupo && doGrupo.length ? doGrupo : plano.contas;
      grupoCache = { candidatas, processados: prepararCandidatos(candidatas.map((c) => c.Nome)) };
      cache.set(conta.grupo, grupoCache);
    }
    const { candidatas, processados } = grupoCache;

    let melhorMatch = null;
    let melhorScore = -1;
    for (const [idx, flexivel] of extractTokenSet(conta.nome, processados, 5)) {
      const rigido = tokenSortRatio(conta.nome, candidatas[idx].Nome);
      const media = (flexivel + rigido) / 2;
      if (media > melhorScore) { melhorScore = media; melhorMatch = candidatas[idx].Nome; }
    }
    const score = Math.trunc(melhorScore);

    let codSugerido = null, displaySugerido = null;
    if (score >= 65) {
      // Busca pelo NOME, e nao pelo indice: se o plano tiver nomes repetidos,
      // vale a primeira ocorrencia, igual ao original.
      for (const c of candidatas) {
        if (c.Nome === melhorMatch) { codSugerido = c.Codigo; displaySugerido = c.Display; break; }
      }
    }

    sugestoes.set(conta.cod, { score, codSugerido, displaySugerido });

    if ((i & 63) === 0 && aoProgredir) {
      aoProgredir(i + 1, contasOrigem.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (aoProgredir) aoProgredir(contasOrigem.length, contasOrigem.length);
  return sugestoes;
}

// =============================================================================
// GERACAO DO SPED AJUSTADO
//
// O separador e' escrito ANTES de cada linha a partir da segunda, entao nao ha
// quebra no fim do arquivo — os bytes sao os mesmos do "\r\n".join() original.
// =============================================================================
async function gerarSpedAjustado(file, mapFinal, gravar, aoProgredir) {
  let primeiro = true;
  let buf = [];

  const escrever = (linha) => {
    if (primeiro) primeiro = false; else buf.push('\r\n');
    buf.push(linha);
  };
  const despejar = async () => {
    if (!buf.length) return;
    await gravar(latin1Encode(buf.join('')));
    buf = [];
  };

  await percorrerLinhas(file, (line) => {
    if (line.startsWith('|9999|')) { escrever(line); return false; }
    if (line.startsWith('|I250|')) {
      const reg = line.split('|');
      if (reg.length > 2 && mapFinal.has(reg[2])) {
        reg[2] = pyStrip(String(mapFinal.get(reg[2]))).replace(/\|/g, '');
      }
      escrever(reg.join('|'));
    } else {
      escrever(line);
    }
  }, async (lidos, total) => {
    await despejar();
    if (aoProgredir) aoProgredir(lidos, total);
  });

  await despejar();
}

// =============================================================================
// BALANCO (|6000| / |6100|)
//
// A ordem de iteracao de mapFinal define a ordem das linhas. Por isso mapFinal
// e' um Map e os backups sao lidos com um parser que preserva a ordem.
// =============================================================================
function montarBalanco(mapFinal, tipoSaldo, dtFmt, initialBalances, finalBalances) {
  const linhas = ['|6000|V||||'];
  let totalDebito = 0, totalCredito = 0;
  let temDados = false;

  for (const [codAntigo, destino] of mapFinal) {
    const novo = String(destino ?? '').replace(/\|/g, '');
    const par = (tipoSaldo === 'Inicial (Abertura)' ? initialBalances : finalBalances).get(codAntigo)
      || ['0,00', 'D'];
    const [valStr, dc] = par;
    const val = pyFloat(valStr.replace(/,/g, '.'));

    if (val > 0) {
      if (dc === 'D') totalDebito += val; else totalCredito += val;
      linhas.push(dc === 'D'
        ? `|6100|${dtFmt}|${novo}||${valStr}||SALDO DE ABERTURA EM ${dtFmt}|||||`
        : `|6100|${dtFmt}||${novo}|${valStr}||SALDO DE ABERTURA EM ${dtFmt}|||||`);
      temDados = true;
    }
  }
  return { linhas, totalDebito, totalCredito, temDados };
}

function formatMoeda(valor) {
  const s = Math.abs(valor).toFixed(2);
  const [inteiro, dec] = s.split('.');
  const agrupado = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${valor < 0 ? '-' : ''}${agrupado},${dec}`;
}

// to_csv(index=False, sep=';') do pandas: terminador \r\n e aspas so quando
// necessario, dobrando as aspas internas. Conferido contra pandas 2.2.1.
function montarCsv(registros, colunas) {
  const campo = (v) => {
    const s = String(v ?? '');
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let out = colunas.join(';') + '\r\n';
  for (const r of registros) out += colunas.map((c) => campo(r[c])).join(';') + '\r\n';
  return out;
}
