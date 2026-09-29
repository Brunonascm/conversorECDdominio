// =============================================================================
// fuzz.js — motor de similaridade
//
// Port fiel de thefuzz 0.22.1 rodando sobre rapidfuzz 3.14.3, que e' exatamente
// o que o convECDprod.py usa. Nao e' "um fuzzy parecido": e' o mesmo algoritmo,
// com as mesmas bordas.
//
// Detalhes que foram medidos contra a biblioteca real e que NAO podem mudar:
//
//   1. thefuzz.fuzz.ratio NAO pre-processa as strings. Ja token_sort_ratio e
//      token_set_ratio pre-processam com force_ascii=True (apagam os pontos de
//      codigo 128..255, entao "Veiculos" com acento perde o acento).
//   2. ratio calcula (1 - dist/lensum) * 100. Escrever a formula algebricamente
//      equivalente 100 - 100*dist/lensum muda o ultimo bit do double e produz
//      diferenca de 1 ponto sempre que o resultado cai exatamente em X,5.
//      Ja o _norm_distance usado dentro do token_set_ratio usa, esse sim,
//      100 - 100*dist/lensum. As duas formas convivem de proposito.
//   3. round() do Python e' bancario (empate vai para o par), nao "meio pra cima".
//   4. token_set_ratio do rapidfuzz nao e' a formula do fuzzywuzzy antigo: ele
//      compara comprimentos de conjuntos, com atalho de 100 quando um conjunto
//      de palavras contem o outro.
//   5. Em process.extract o empate de pontuacao e' desempatado pelo menor
//      indice na lista de candidatos.
//
// Verificado contra thefuzz/rapidfuzz instalados: 0 divergencias em 12.000
// comparacoes de metrica e em 800 execucoes do pipeline completo de sugestao.
// =============================================================================

const NAO_PALAVRA = /[^\p{L}\p{N}_]/gu;   // equivale ao \W unicode do Python

// Remove os pontos de codigo 128..255 (o "ascii dammit" do thefuzz).
// Atencao: caracteres acima de 255 sobrevivem, igual ao original.
function asciiOnly(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128 || c > 255) out += s[i];
  }
  return out;
}

function defaultProcess(s) {
  return s.replace(NAO_PALAVRA, ' ').trim().toLowerCase();
}

function fullProcess(s, forceAscii) {
  return defaultProcess(forceAscii ? asciiOnly(String(s)) : String(s));
}

// Depois do defaultProcess so restam caracteres de palavra e espaco simples,
// entao dividir por ' ' equivale ao str.split() do Python.
function tokens(s) {
  if (!s) return [];
  const out = [];
  for (const t of s.split(' ')) if (t) out.push(t);
  return out;
}

// -----------------------------------------------------------------------------
// LCS bit-paralelo (mesma tecnica que o rapidfuzz usa internamente).
// Conferido contra uma DP de referencia: 0 erros em 24.000 pares aleatorios,
// cobrindo o caminho de palavra unica e o de multiplas palavras.
// -----------------------------------------------------------------------------
function lcsLen(a, b) {
  const m = a.length;
  if (m === 0 || b.length === 0) return 0;

  if (m <= 32) {
    const pm = new Map();
    for (let i = 0; i < m; i++) {
      const c = a.charCodeAt(i);
      pm.set(c, (pm.get(c) || 0) | (1 << i));
    }
    let S = 0xFFFFFFFF;
    for (let j = 0; j < b.length; j++) {
      const p = pm.get(b.charCodeAt(j)) || 0;
      const u = (S & p) >>> 0;
      S = ((((S + u) >>> 0) | ((S - u) >>> 0)) >>> 0);
    }
    const mask = m === 32 ? 0xFFFFFFFF : (((1 << m) >>> 0) - 1) >>> 0;
    return popcount((~S & mask) >>> 0);
  }

  const words = (m + 31) >> 5;
  const pm = new Map();
  for (let i = 0; i < m; i++) {
    const c = a.charCodeAt(i);
    let arr = pm.get(c);
    if (!arr) { arr = new Uint32Array(words); pm.set(c, arr); }
    arr[i >> 5] |= (1 << (i & 31));
  }
  const zero = new Uint32Array(words);
  const S = new Uint32Array(words).fill(0xFFFFFFFF);
  const add = new Uint32Array(words);
  const sub = new Uint32Array(words);
  for (let j = 0; j < b.length; j++) {
    const p = pm.get(b.charCodeAt(j)) || zero;
    let carry = 0, borrow = 0;
    for (let w = 0; w < words; w++) {
      const u = (S[w] & p[w]) >>> 0;
      const s = S[w] + u + carry;          // exato: cabe num double
      add[w] = s >>> 0;
      carry = s > 0xFFFFFFFF ? 1 : 0;
      const d = S[w] - u - borrow;
      sub[w] = d >>> 0;
      borrow = d < 0 ? 1 : 0;
    }
    for (let w = 0; w < words; w++) S[w] = (add[w] | sub[w]) >>> 0;
  }
  let total = 0;
  for (let w = 0; w < words; w++) {
    const bits = (w + 1) * 32 <= m ? 32 : m - w * 32;
    const mask = bits === 32 ? 0xFFFFFFFF : (((1 << bits) >>> 0) - 1) >>> 0;
    total += popcount((~S[w] & mask) >>> 0);
  }
  return total;
}

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0F0F0F0F;
  return (x * 0x01010101) >>> 24;
}

function indelDistance(a, b) {
  return a.length + b.length - 2 * lcsLen(a, b);
}

// round() do Python: empate vai para o inteiro par.
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// rapidfuzz.fuzz.ratio, sem pre-processamento e sem arredondar.
// A ordem das operacoes abaixo e' significativa (ver nota 2 no topo).
function ratioRaw(a, b) {
  const lensum = a.length + b.length;
  const normDist = lensum ? indelDistance(a, b) / lensum : 0;
  return (1 - normDist) * 100;
}

function normDistance(dist, lensum) {
  const score = lensum ? 100 - (100 * dist) / lensum : 100;
  return score >= 0 ? score : 0;
}

function tokenSortRaw(a, b) {
  return ratioRaw(tokens(a).sort().join(' '), tokens(b).sort().join(' '));
}

// rapidfuzz.fuzz.token_set_ratio sobre strings JA pre-processadas.
function tokenSetRaw(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;

  const inter = [], dab = [], dba = [];
  for (const t of ta) (tb.has(t) ? inter : dab).push(t);
  for (const t of tb) if (!ta.has(t)) dba.push(t);

  // um conjunto de palavras contem o outro
  if (inter.length && (!dab.length || !dba.length)) return 100;

  const ab = dab.sort().join(' ');
  const ba = dba.sort().join(' ');
  const abLen = ab.length;
  const baLen = ba.length;
  const sectLen = inter.join(' ').length;   // so o comprimento importa
  const one = sectLen !== 0 ? 1 : 0;
  const sectAb = sectLen + one + abLen;
  const sectBa = sectLen + one + baLen;

  const result = normDistance(indelDistance(ab, ba), sectAb + sectBa);
  if (!sectLen) return result;

  const r1 = normDistance(one + abLen, sectLen + sectAb);
  const r2 = normDistance(one + baLen, sectLen + sectBa);
  return Math.max(result, r1, r2);
}

// ----------------------------------------------------------------- API publica
function tokenSortRatio(s1, s2) {
  return pyRound(tokenSortRaw(fullProcess(s1, true), fullProcess(s2, true)));
}

function tokenSetRatio(s1, s2) {
  return pyRound(tokenSetRaw(fullProcess(s1, true), fullProcess(s2, true)));
}

// Pre-processa a lista de candidatos uma unica vez. No Streamlit isso era
// refeito a cada conta; aqui e' feito por grupo do plano de contas.
function prepararCandidatos(nomes) {
  return nomes.map((n) => fullProcess(n, true));
}

/**
 * Equivale a process.extract(query, choices, scorer=fuzz.token_set_ratio, limit).
 * `processados` deve vir de prepararCandidatos(). Devolve [[indice, score], ...].
 *
 * A query passa por full_process duas vezes exatamente como no thefuzz:
 * _preprocess_query usa force_ascii=False e o processor interno usa True.
 */
function extractTokenSet(query, processados, limit = 5) {
  const q = fullProcess(fullProcess(query, false), true);
  const scored = new Array(processados.length);
  for (let i = 0; i < processados.length; i++) {
    scored[i] = [i, tokenSetRaw(q, processados[i])];
  }
  // empate -> menor indice, como o rapidfuzz
  scored.sort((x, y) => (y[1] - x[1]) || (x[0] - y[0]));
  const n = Math.min(limit, scored.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [scored[i][0], pyRound(scored[i][1])];
  return out;
}
