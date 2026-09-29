// =============================================================================
// ojson.js — JSON que preserva a ordem das chaves
//
// POR QUE ISTO EXISTE:
// JSON.parse devolve um objeto comum, e objeto comum do JavaScript reordena
// chaves que parecem inteiros. Um backup com {"50": "1", "10": "2"} volta como
// {"10": "2", "50": "1"}. Dicionario do Python nao faz isso.
//
// Isso nao seria detalhe cosmetico: a ordem de iteracao de map_final_para_geracao
// define a ordem das linhas |6100| do Balanco. Usar JSON.parse direto mudaria o
// arquivo entregue depois de recarregar um backup.
//
// parseOrdenado devolve Map, que preserva a ordem de insercao igual ao Python.
// =============================================================================

function parseOrdenado(texto) {
  let i = 0;

  const erro = (m) => { throw new SyntaxError(`${m} (posicao ${i})`); };
  const pular = () => { while (i < texto.length && ' \t\n\r'.includes(texto[i])) i++; };

  function valor() {
    pular();
    if (i >= texto.length) erro('fim inesperado');
    const c = texto[i];
    if (c === '{') return objeto();
    if (c === '[') return lista();
    if (c === '"') return cadeia();
    if (texto.startsWith('true', i)) { i += 4; return true; }
    if (texto.startsWith('false', i)) { i += 5; return false; }
    if (texto.startsWith('null', i)) { i += 4; return null; }
    return numero();
  }

  function objeto() {
    const m = new Map();
    i++; pular();
    if (texto[i] === '}') { i++; return m; }
    for (;;) {
      pular();
      if (texto[i] !== '"') erro('esperava nome de chave');
      const k = cadeia();
      pular();
      if (texto[i] !== ':') erro("esperava ':'");
      i++;
      m.set(k, valor());
      pular();
      if (texto[i] === ',') { i++; continue; }
      if (texto[i] === '}') { i++; return m; }
      erro("esperava ',' ou '}'");
    }
  }

  function lista() {
    const a = [];
    i++; pular();
    if (texto[i] === ']') { i++; return a; }
    for (;;) {
      a.push(valor());
      pular();
      if (texto[i] === ',') { i++; continue; }
      if (texto[i] === ']') { i++; return a; }
      erro("esperava ',' ou ']'");
    }
  }

  function cadeia() {
    i++;
    let s = '';
    for (;;) {
      if (i >= texto.length) erro('texto sem fechamento');
      const c = texto[i];
      if (c === '"') { i++; return s; }
      if (c === '\\') {
        i++;
        const e = texto[i++];
        if (e === 'u') { s += String.fromCharCode(parseInt(texto.substr(i, 4), 16)); i += 4; }
        else if (e === 'n') s += '\n';
        else if (e === 't') s += '\t';
        else if (e === 'r') s += '\r';
        else if (e === 'b') s += '\b';
        else if (e === 'f') s += '\f';
        else s += e;
      } else { s += c; i++; }
    }
  }

  function numero() {
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(texto.slice(i));
    if (!m) erro('valor invalido');
    i += m[0].length;
    return Number(m[0]);
  }

  const v = valor();
  pular();
  return v;
}

// -----------------------------------------------------------------------------
// Serializacao equivalente a json.dumps(obj, indent=4) do Python: mesma
// indentacao, mesmos separadores e ensure_ascii (nao-ASCII vira \uXXXX).
// -----------------------------------------------------------------------------
function dumpsOrdenado(valor, indent = 4, nivel = 0) {
  const pad = ' '.repeat(indent * (nivel + 1));
  const padFim = ' '.repeat(indent * nivel);

  if (valor instanceof Map) {
    if (valor.size === 0) return '{}';
    const partes = [];
    for (const [k, v] of valor) {
      partes.push(`${pad}${escapar(String(k))}: ${dumpsOrdenado(v, indent, nivel + 1)}`);
    }
    return `{\n${partes.join(',\n')}\n${padFim}}`;
  }
  if (Array.isArray(valor)) {
    if (valor.length === 0) return '[]';
    const partes = valor.map((v) => pad + dumpsOrdenado(v, indent, nivel + 1));
    return `[\n${partes.join(',\n')}\n${padFim}]`;
  }
  if (valor === null) return 'null';
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  if (typeof valor === 'number') return String(valor);
  return escapar(String(valor));
}

function escapar(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else if (c < 0x7f) out += ch;
    else if (c > 0xffff) {
      // par substituto, igual ao ensure_ascii do Python
      const v = c - 0x10000;
      out += '\\u' + (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      out += '\\u' + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else out += '\\u' + c.toString(16).padStart(4, '0');
  }
  return out + '"';
}
