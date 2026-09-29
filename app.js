// =============================================================================
// app.js — interface e orquestracao
//
// Equivalente ao corpo do convECDprod.py. O que era st.session_state virou o
// objeto S; o que era reexecucao do script virou render().
//
// Diferenca de fundo em relacao ao Streamlit: nao existe servidor. O arquivo
// SPED nunca sobe para lugar nenhum, e a memoria usada e' a da aba do
// navegador, que o sistema operacional gerencia e libera sozinho.
// =============================================================================


const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SELECIONE = '-- SELECIONE --';
const MANUAL = '📝 -- DIGITAR MANUALMENTE --';

const S = {
  plano: null,
  arquivoSped: null,
  dados: null,
  sugestoes: null,
  deParaMap: new Map(),   // Map preserva a ordem de insercao, igual ao dict do Python
  conferidos: new Map(),
  manuais: new Map(),     // equivale a st.session_state[f"in_{cod}"]
  selecao: new Map(),     // equivale ao estado do selectbox
  pagina: 1,
  busca: '',
  ocultarMapeadas: false,
  ocultarConferidas: false,
  porPagina: 25,
  tipoSaldo: 'Inicial (Abertura)',
  balancoProcessado: false,
  balancoTotais: { D: 0, C: 0 },
  balancoTemDados: false,
  temConjuntoXml: false,
};

// ------------------------------------------------------------- utilitarios
function msg(el, texto, classe) {
  el.className = 'msg' + (classe ? ' ' + classe : '');
  el.textContent = texto || '';
}

// str() do Python, para os valores lidos de um JSON de backup.
function pyStr(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  return String(v);
}
function pyBool(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}

function baixar(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let progAtivo = false;
function progAbrir(texto) { progAtivo = true; $('overlayTxt').textContent = texto; $('overlayBarra').style.width = '0%'; $('overlay').hidden = false; }
function progSet(feito, total) { if (progAtivo) $('overlayBarra').style.width = (total ? (feito / total) * 100 : 0).toFixed(1) + '%'; }
function progTexto(t) { if (progAtivo) $('overlayTxt').textContent = t; }
function progFechar() { progAtivo = false; $('overlay').hidden = true; }

// =============================================================================
// PLANO DE CONTAS
// =============================================================================
async function carregarPlanoPadrao() {
  msg($('msgPlano'), '');
  $('capPlano').textContent = '';
  cacheOpcoes.clear();
  try {
    const res = await fetch('plano_padrao.xlsx', { cache: 'no-cache' });
    if (!res.ok) {
      S.plano = null;
      msg($('msgPlano'), "Arquivo 'plano_padrao.xlsx' não encontrado.", 'aviso');
      return render();
    }
    S.plano = prepararPlano(await lerXlsx(await res.arrayBuffer()));
  } catch (e) {
    S.plano = null;
    if (location.protocol === 'file:') {
      msg($('msgPlano'), 'Aberto direto do disco, o navegador não deixa ler o plano_padrao.xlsx sozinho. ' +
        'Desmarque a opção acima e selecione o plano manualmente — ou use a versão publicada no GitHub Pages, onde o plano padrão carrega normalmente.', 'aviso');
    } else {
      msg($('msgPlano'), 'Erro ao ler plano_padrao.xlsx: ' + e.message, 'erro');
    }
  }
  await recalcularSugestoes();
  render();
}

async function carregarPlanoArquivo(file) {
  msg($('msgPlano'), '');
  cacheOpcoes.clear();
  try {
    S.plano = prepararPlano(await lerXlsx(await file.arrayBuffer()));
  } catch (e) {
    S.plano = null;
    msg($('msgPlano'), 'Erro ao ler arquivo Excel: ' + e.message, 'erro');
  }
  await recalcularSugestoes();
  render();
}

// As sugestoes dependem do plano de destino. Trocar o plano com um SPED ja
// carregado obriga a refazer a analise — no Streamlit isso acontecia sozinho
// porque a chave do cache incluia o plano.
async function recalcularSugestoes() {
  if (!S.plano || !S.dados || !S.dados.contasOrigem.length) return;
  progAbrir('Analisando as contas...');
  try {
    S.sugestoes = await sugerirMapeamento(S.dados.contasOrigem, S.plano, progSet);
  } finally {
    progFechar();
  }
}

// =============================================================================
// SPED
// =============================================================================
async function carregarSped(file) {
  S.arquivoSped = file;
  S.dados = null; S.sugestoes = null; S.pagina = 1;
  S.balancoProcessado = false;
  S.selecao.clear();
  msg($('msgSped'), '');

  try {
    progAbrir('Lendo o arquivo SPED...');
    S.dados = await analisarSped(file, async (lidos, total) => {
      progSet(lidos, total);
      await new Promise((r) => setTimeout(r, 0));
    });

    if (S.dados.contasOrigem.length) {
      progTexto('Analisando as contas...');
      S.sugestoes = await sugerirMapeamento(S.dados.contasOrigem, S.plano, progSet);
    }
  } catch (e) {
    S.dados = null;
    msg($('msgSped'), 'Erro ao ler o SPED: ' + e.message, 'erro');
  } finally {
    progFechar();
  }
  resetarData();
  render();
}

// =============================================================================
// ESTADO DERIVADO — equivale ao bloco principal do script Streamlit
// =============================================================================
function calcular() {
  const contas = S.dados.contasOrigem;
  const mapFinal = new Map(S.deParaMap);   // a ordem daqui define a ordem do Balanco
  const itens = [];
  let mapeadas = 0;

  for (const conta of contas) {
    const cod = String(conta.cod);
    const sug = S.sugestoes.get(cod);
    const estaNoMapa = S.deParaMap.has(cod);
    const valorNoMapa = String(S.deParaMap.get(cod) ?? '');

    let resolvida = false;
    if (estaNoMapa) {
      resolvida = true;
    } else if (sug.score >= 65) {
      resolvida = true;
      mapFinal.set(cod, sug.codSugerido);
    }
    if (resolvida) mapeadas++;

    itens.push({
      cod, nome: conta.nome, classif: conta.classif, grupo: conta.grupo,
      score: sug.score, codSugerido: sug.codSugerido, displaySugerido: sug.displaySugerido,
      resolvida, estaNoMapa, valorNoMapa,
    });
  }

  let conferidas = 0;
  for (const v of S.conferidos.values()) if (v) conferidas++;

  return { itens, mapFinal, mapeadas, conferidas, total: contas.length };
}

// Opcoes do menu por grupo, montadas uma vez por grupo presente na pagina.
const cacheOpcoes = new Map();
function opcoesDoGrupo(grupo) {
  let o = cacheOpcoes.get(grupo);
  if (!o) {
    const lista = candidatasOpcoes(S.plano, grupo).map((c) => c.Display);
    o = { lista, conjunto: new Set(lista) };
    cacheOpcoes.set(grupo, o);
  }
  return o;
}

// Reproduz o calculo de valor_inicial do original, incluindo a injecao de uma
// opcao extra quando o destino gravado nao esta na lista do grupo.
function estadoSelecao(item) {
  const { lista, conjunto } = opcoesDoGrupo(item.grupo);
  let extra = null;
  let valor = SELECIONE;

  if (item.estaNoMapa) {
    const destino = S.plano.porCodigo.get(item.valorNoMapa);
    if (destino) {
      valor = destino.Display;
      if (!conjunto.has(valor)) extra = valor;
    } else {
      valor = MANUAL;
      if (!S.manuais.has(item.cod)) S.manuais.set(item.cod, item.valorNoMapa);
    }
  } else if (item.displaySugerido) {
    valor = item.displaySugerido;
    if (!conjunto.has(valor)) extra = valor;
  }

  if (S.selecao.has(item.cod)) {
    const v = S.selecao.get(item.cod);
    if (v !== SELECIONE && v !== MANUAL && !conjunto.has(v) && v !== extra) extra = v;
    valor = v;
  }

  const opcoes = extra ? [SELECIONE, MANUAL, extra, ...lista] : [SELECIONE, MANUAL, ...lista];
  return { valor, opcoes };
}

// =============================================================================
// RENDER
// =============================================================================
function render() {
  // --- barra lateral: plano
  $('blocoPlanoCustom').hidden = $('usarPadrao').checked;
  $('capPlano').textContent = S.plano ? `${S.plano.contas.length} contas analíticas no plano de destino.` : '';

  $('blocoSped').hidden = !S.plano;
  $('avisoSped').hidden = !!S.plano;

  const temMapa = S.deParaMap.size > 0;
  $('btnSalvarBackup').hidden = !temMapa;
  $('btnExportarModelo').hidden = !temMapa;

  const pronto = S.plano && S.dados;
  $('aguardando').hidden = !!pronto;
  $('app').hidden = !pronto;
  if (!pronto) return;

  // --- aviso de multiplos periodos I150
  const cp = $('capPeriodos');
  if (S.dados.qtdPeriodosI150 > 1) {
    cp.hidden = false;
    cp.textContent = `ℹ️ Arquivo com ${S.dados.qtdPeriodosI150} períodos de saldo (I150). O saldo inicial considerado é o do primeiro período.`;
  } else cp.hidden = true;

  if (!S.dados.contasOrigem.length) {
    $('app').hidden = true;
    $('aguardando').hidden = false;
    msg($('aguardando'), 'Nenhuma conta com movimento detectada.', 'erro');
    return;
  }
  msg($('aguardando'), 'Aguardando arquivos...', 'info');

  const st = calcular();
  renderProgresso(st);
  renderLista(st);
  renderMetricas(st);
  renderFinalizacao(st);
}

function renderProgresso({ mapeadas, conferidas, total }) {
  const pm = total ? mapeadas / total : 0;
  const pc = total ? conferidas / total : 0;
  $('barraMap').style.width = (pm * 100) + '%';
  $('barraConf').style.width = (pc * 100) + '%';
  $('txtMap').innerHTML = `<b>Mapeamento Automatizado + Manual:</b> ${mapeadas}/${total} (${(pm * 100).toFixed(1)}%)`;
  $('txtConf').innerHTML = `<b>Conferência Realizada:</b> ${conferidas}/${total} (${(pc * 100).toFixed(1)}%)`;
}

function renderMetricas({ mapeadas, conferidas, total }) {
  $('mTotal').textContent = total;
  $('mMap').textContent = mapeadas;
  $('mMapPct').textContent = ((total ? mapeadas / total : 0) * 100).toFixed(1) + '%';
  $('mConf').textContent = conferidas;
  $('mConfPct').textContent = ((total ? conferidas / total : 0) * 100).toFixed(1) + '%';
}

function renderLista({ itens }) {
  const termo = S.busca.trim().toLowerCase();
  const visiveis = itens.filter((it) => {
    if (termo && !(it.nome.toLowerCase().includes(termo) || it.cod.toLowerCase().includes(termo) || it.classif.toLowerCase().includes(termo))) return false;
    if (S.ocultarMapeadas && it.resolvida) return false;
    if (S.ocultarConferidas && S.conferidos.get(it.cod)) return false;
    return true;
  });

  const lista = $('listaContas');
  if (!visiveis.length) {
    $('paginacao').innerHTML = '';
    $('capPagina').textContent = '';
    lista.innerHTML = '<p class="msg info">Nenhuma conta corresponde aos filtros ativos.</p>';
    return;
  }

  const totalPaginas = Math.max(1, Math.ceil(visiveis.length / S.porPagina));
  if (S.pagina > totalPaginas) S.pagina = 1;

  let sel = '<select id="selPagina">';
  for (let p = 1; p <= totalPaginas; p++) sel += `<option value="${p}"${p === S.pagina ? ' selected' : ''}>Página ${p}</option>`;
  $('paginacao').innerHTML = sel + '</select>';
  $('selPagina').onchange = (e) => { S.pagina = +e.target.value; render(); };

  const off = (S.pagina - 1) * S.porPagina;
  const daPagina = visiveis.slice(off, off + S.porPagina);
  $('capPagina').textContent = `Exibindo ${off + 1} a ${Math.min(off + S.porPagina, visiveis.length)} de ${visiveis.length} contas.`;

  let html = '';
  for (const it of daPagina) {
    const conferida = !!S.conferidos.get(it.cod);
    const { valor } = estadoSelecao(it);

    let selo;
    if (it.estaNoMapa) selo = '<span class="selo u">📌 Mapeado pelo Usuário</span>';
    else if (it.score >= 85) selo = `<span class="selo a">🟢 Alta Confiança (${it.score}% - Recomendada)</span>`;
    else if (it.score >= 65) selo = `<span class="selo m">🟡 Média Confiança (${it.score}% - Requer Revisão)</span>`;
    else selo = `<span class="selo b">🔴 Não mapeada (Baixa Confiança - ${it.score}%)</span>`;

    const manual = valor === MANUAL
      ? `<input class="manual" type="text" data-manual="${esc(it.cod)}" value="${esc(S.manuais.get(it.cod) ?? S.deParaMap.get(it.cod) ?? '')}" placeholder="Cód. manual para ${esc(it.cod)}">`
      : '';

    html += `<div class="cont-row">
      <div>
        <div class="nome${conferida ? ' feita' : ''}">${esc(it.nome)}${conferida ? '  ✅ <i>(Conferida)</i>' : ''}</div>
        <div class="caption">Cod no SPED: ${esc(it.cod)} | Grupo: ${esc(it.grupo)}</div>
      </div>
      <div>
        ${selo}
        <button class="combo-btn" data-combo="${esc(it.cod)}" title="${esc(valor)}">${esc(valor)}</button>
        ${manual}
      </div>
      <label class="conf">
        <input type="checkbox" data-conf="${esc(it.cod)}"${conferida && it.resolvida ? ' checked' : ''}${it.resolvida ? '' : ' disabled'}>
        <span>Marcar como Conferido</span>
      </label>
    </div>`;
  }
  lista.innerHTML = html;

  for (const b of lista.querySelectorAll('[data-combo]')) {
    b.onclick = () => abrirCombo(b, daPagina.find((x) => x.cod === b.dataset.combo));
  }
  for (const i of lista.querySelectorAll('[data-manual]')) {
    i.onchange = () => { atualizarManual(i.dataset.manual, i.value); render(); };
  }
  for (const c of lista.querySelectorAll('[data-conf]')) {
    c.onchange = () => { S.conferidos.set(c.dataset.conf, !!c.checked); render(); };
  }
}

// ----------------------------------------------------- seletor com busca
let comboItem = null;
function abrirCombo(botao, item) {
  if (!item) return;
  comboItem = item;
  const { opcoes } = estadoSelecao(item);
  const painel = $('combo');
  const r = botao.getBoundingClientRect();
  painel.hidden = false;
  painel.style.left = Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - painel.offsetWidth - 8)) + 'px';
  painel.style.top = (r.bottom + scrollY + 4) + 'px';
  $('comboBusca').value = '';
  desenharCombo(opcoes, '');
  $('comboBusca').focus();
}

function desenharCombo(opcoes, termo) {
  const t = termo.trim().toLowerCase();
  const achados = t ? opcoes.filter((o) => o.toLowerCase().includes(t)) : opcoes;
  const mostrar = achados.slice(0, 400);
  let html = mostrar.map((o) => `<button type="button" data-op="${esc(o)}">${esc(o)}</button>`).join('');
  if (!achados.length) html = '<div class="vazio">Nenhuma conta encontrada.</div>';
  else if (achados.length > mostrar.length) html += `<div class="vazio">… e mais ${achados.length - mostrar.length}. Refine a busca.</div>`;
  $('comboLista').innerHTML = html;
  for (const b of $('comboLista').querySelectorAll('[data-op]')) {
    b.onclick = () => { atualizarDropdown(comboItem.cod, b.dataset.op); fecharCombo(); render(); };
  }
}
function fecharCombo() { $('combo').hidden = true; comboItem = null; }

// -------------------------------------------- acoes equivalentes aos callbacks
function atualizarDropdown(cod, valor) {
  S.selecao.set(cod, valor);
  if (valor && valor !== SELECIONE && !valor.includes('📝')) {
    S.deParaMap.set(cod, String(valor.split(' | ')[0]));
  } else if (valor === MANUAL) {
    S.deParaMap.set(cod, '');
  } else if (valor === SELECIONE) {
    S.deParaMap.delete(cod);
  }
}
function atualizarManual(cod, valor) {
  S.manuais.set(cod, valor);
  if (valor) S.deParaMap.set(cod, String(valor));
}

// =============================================================================
// FINALIZACAO
// =============================================================================
function renderFinalizacao(st) {
  const { mapFinal, mapeadas, conferidas, total } = st;
  const pendentes = total - mapeadas;
  const pendentesConf = total - conferidas;
  const nome = S.dados.nomeEmpresa;

  // --- 1. arquivo final
  const c1 = $('finalArquivo');
  if (pendentes > 0) {
    c1.innerHTML = `<p class="msg aviso">⚠️ Faltam ${pendentes} mapeamentos.</p>
      <button class="btn block" disabled>🚀 Gerar SPED</button>`;
  } else {
    c1.innerHTML = (pendentesConf > 0
      ? `<p class="msg aviso">⚠️ Há ${pendentesConf} contas pendentes de conferência pelo cliente. (Download Liberado)</p>`
      : '<p class="msg ok">✅ Tudo pronto e conferido!</p>')
      + `<button class="btn block primario" id="btnSped" title="O arquivo é montado no momento do clique.">💾 Baixar SPED Ajustado</button>`
      + (S.temConjuntoXml ? `<hr><a class="btn block" href="${encodeURI('Conjunto SPED.xml')}" download="Conjunto SPED.xml">⬇️ Baixar Conjunto SPED (XML)</a>` : '');
    $('btnSped').onclick = () => baixarSped(mapFinal, `SPED_AJUSTADO_${nome}.txt`);
  }

  // --- 2. balanco
  const rb = $('resultadoBalanco');
  if (S.balancoProcessado) {
    const t = S.balancoTotais;
    const diff = t.D - t.C;
    let h = `<hr><p class="caption">Débitos: ${formatMoeda(t.D)}</p><p class="caption">Créditos: ${formatMoeda(t.C)}</p>`;
    h += Math.abs(diff) > 0.01
      ? `<p class="msg erro">Diferença: ${formatMoeda(diff)}</p>`
      : '<p class="msg ok">Diferença: R$ 0,00</p>';
    if (S.balancoTemDados && pendentes === 0) h += '<button class="btn block primario" id="btnBalanco">💾 Baixar Balanço</button>';
    else if (pendentes > 0) h += '<p class="msg aviso">Resolva pendências.</p>';
    else h += '<p class="msg aviso">Sem dados.</p>';
    rb.innerHTML = h;
    const bb = $('btnBalanco');
    if (bb) bb.onclick = () => baixarBalanco(mapFinal, nome);
  } else rb.innerHTML = '';

  // --- 3. conferencia
  const pend = S.dados.contasOrigem.filter((c) => !mapFinal.has(c.cod));
  const c3 = $('finalConferencia');
  if (pend.length) {
    c3.innerHTML = `<p class="msg aviso">${pend.length} pendentes.</p><button class="btn block" id="btnCsv">📑 Relatório CSV</button>`;
    $('btnCsv').onclick = () => {
      const csv = montarCsv(pend, ['cod', 'classif', 'nome', 'grupo']);
      baixar(new Blob(['\ufeff' + csv], { type: 'text/csv' }), 'contas_pendentes.csv');
    };
  } else {
    c3.innerHTML = '<p class="msg ok">✅ Tudo Mapeado OK!</p>';
  }
}

function dataBalancoFmt() {
  const v = $('dataBalanco').value;
  if (!v) return ddmmyyyy(new Date());
  const [y, m, d] = v.split('-').map(Number);
  return ddmmyyyy(new Date(Date.UTC(y, m - 1, d)));
}

function resetarData() {
  // st.date_input recalcula o padrao quando o tipo de saldo muda.
  let padrao = new Date();
  padrao = new Date(Date.UTC(padrao.getFullYear(), padrao.getMonth(), padrao.getDate()));
  if (S.tipoSaldo === 'Inicial (Abertura)' && S.dados?.dtInicial) {
    padrao = new Date(S.dados.dtInicial.getTime() - 86400000);
  } else if (S.tipoSaldo === 'Final (Fechamento)' && S.dados?.dtFinal) {
    padrao = S.dados.dtFinal;
  }
  $('dataBalanco').value = padrao.toISOString().slice(0, 10);
}

async function baixarSped(mapFinal, nomeArquivo) {
  // showSaveFilePicker precisa ser chamado ainda dentro do clique, antes de
  // qualquer await. Com ele, o arquivo vai direto para o disco em fluxo e os
  // 217 MB nunca ficam inteiros na memoria.
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: nomeArquivo,
        types: [{ description: 'Arquivo de texto', accept: { 'text/plain': ['.txt'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      handle = null;
    }
  }

  progAbrir('Montando o SPED ajustado...');
  try {
    if (handle) {
      const w = await handle.createWritable();
      await gerarSpedAjustado(S.arquivoSped, mapFinal, (b) => w.write(b), progSet);
      await w.close();
      progTexto('Arquivo gravado.');
    } else {
      const partes = [];
      await gerarSpedAjustado(S.arquivoSped, mapFinal, (b) => { partes.push(b); }, progSet);
      baixar(new Blob(partes, { type: 'text/plain' }), nomeArquivo);
    }
  } catch (e) {
    alert('Erro ao gerar o SPED: ' + e.message);
  } finally {
    progFechar();
  }
}

function baixarBalanco(mapFinal, nome) {
  const dtFmt = dataBalancoFmt();
  const { linhas } = montarBalanco(mapFinal, S.tipoSaldo, dtFmt, S.dados.initialBalances, S.dados.finalBalances);
  baixar(new Blob([latin1Encode(linhas.join('\r\n'))], { type: 'text/plain' }),
    `BALANCO_${nome}_${dtFmt.replace(/\//g, '')}.txt`);
}

// =============================================================================
// BACKUP E MODELO
// =============================================================================
async function carregarBackup(file) {
  try {
    const dados = parseOrdenado(await file.text());
    const ehEnvelope = dados instanceof Map && (dados.has('de_para_map') || dados.has('conferidos'));
    const mapa = ehEnvelope ? (dados.get('de_para_map') ?? new Map()) : dados;
    const conf = ehEnvelope ? (dados.get('conferidos') ?? new Map()) : new Map();

    let n = 0, nc = 0;
    for (const [k, v] of mapa) { S.deParaMap.set(String(k), pyStr(v)); S.manuais.set(String(k), pyStr(v)); n++; }
    for (const [k, v] of conf) { S.conferidos.set(String(k), pyBool(v)); nc++; }
    S.selecao.clear();

    msg($('msgBackup'), `Backup carregado! ${n} mapeadas (${nc} conferidas).`, 'ok');
  } catch (e) {
    msg($('msgBackup'), 'Erro no backup: ' + e.message, 'erro');
  }
  render();
}

async function carregarModelo(file) {
  try {
    const dados = parseOrdenado(await file.text());
    const mapa = (dados instanceof Map && dados.has('de_para_map')) ? dados.get('de_para_map') : dados;

    let n = 0;
    for (const [k, v] of mapa) {
      const kk = String(k), vv = pyStr(v);
      S.deParaMap.set(kk, vv);
      S.conferidos.set(kk, false);
      S.manuais.set(kk, vv);
      n++;
    }
    S.selecao.clear();
    msg($('msgModelo'), `Modelo aplicado! ${n} relacionamentos carregados (Aguardando conferência).`, 'ok');
  } catch (e) {
    msg($('msgModelo'), 'Erro no modelo: ' + e.message, 'erro');
  }
  render();
}

// =============================================================================
// LIGACAO DOS CONTROLES
// =============================================================================
$('usarPadrao').onchange = (e) => {
  S.plano = null; msg($('msgPlano'), ''); cacheOpcoes.clear();
  if (e.target.checked) carregarPlanoPadrao();
  else { $('filePlano').value = ''; render(); }
};
$('filePlano').onchange = (e) => e.target.files[0] && carregarPlanoArquivo(e.target.files[0]);
$('fileSped').onchange = (e) => e.target.files[0] && carregarSped(e.target.files[0]);
$('fileBackup').onchange = (e) => e.target.files[0] && carregarBackup(e.target.files[0]);
$('fileModelo').onchange = (e) => e.target.files[0] && carregarModelo(e.target.files[0]);

$('ocultarMapeadas').onchange = (e) => { S.ocultarMapeadas = e.target.checked; S.pagina = 1; render(); };
$('ocultarConferidas').onchange = (e) => { S.ocultarConferidas = e.target.checked; S.pagina = 1; render(); };
$('porPagina').onchange = (e) => { S.porPagina = +e.target.value; S.pagina = 1; render(); };

let tBusca;
$('busca').oninput = (e) => {
  clearTimeout(tBusca);
  tBusca = setTimeout(() => { S.busca = e.target.value; S.pagina = 1; render(); }, 150);
};

$('btnConferirTodas').onclick = () => {
  for (const it of calcular().itens) if (it.resolvida) S.conferidos.set(it.cod, true);
  render();
};
$('btnLimparConf').onclick = () => { S.conferidos = new Map(); render(); };

for (const r of document.querySelectorAll('input[name=tipoSaldo]')) {
  r.onchange = () => { S.tipoSaldo = r.value; S.balancoProcessado = false; resetarData(); render(); };
}
$('btnProcessarBalanco').onclick = () => {
  const { mapFinal } = calcular();
  const r = montarBalanco(mapFinal, S.tipoSaldo, dataBalancoFmt(), S.dados.initialBalances, S.dados.finalBalances);
  S.balancoTotais = { D: r.totalDebito, C: r.totalCredito };
  S.balancoProcessado = true;
  S.balancoTemDados = r.temDados;
  render();
};

$('btnSalvarBackup').onclick = () => {
  const dados = new Map([['de_para_map', S.deParaMap], ['conferidos', S.conferidos]]);
  baixar(new Blob([dumpsOrdenado(dados, 4)], { type: 'application/json' }), 'backup_mapeamento_ecd.json');
};
$('btnExportarModelo').onclick = () => {
  const dados = new Map([['de_para_map', S.deParaMap]]);
  baixar(new Blob([dumpsOrdenado(dados, 4)], { type: 'application/json' }), 'modelo_de_para_compartilhado.json');
};

$('comboBusca').oninput = () => { if (comboItem) desenharCombo(estadoSelecao(comboItem).opcoes, $('comboBusca').value); };
document.addEventListener('mousedown', (e) => {
  if (!$('combo').hidden && !$('combo').contains(e.target) && !e.target.dataset.combo) fecharCombo();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharCombo(); });

// --- tema (escuro e' o padrao; a escolha fica salva neste navegador)
function aplicarTema(claro) {
  if (claro) document.documentElement.dataset.tema = 'claro';
  else delete document.documentElement.dataset.tema;
  $('btnTema').textContent = claro ? '🌙 Modo escuro' : '☀️ Modo claro';
  try { localStorage.setItem('tema', claro ? 'claro' : 'escuro'); } catch (e) {}
}
$('btnTema').onclick = () => aplicarTema(document.documentElement.dataset.tema !== 'claro');
aplicarTema(document.documentElement.dataset.tema === 'claro');

// --- arranque
fetch(encodeURI('Conjunto SPED.xml'), { method: 'HEAD' })
  .then((r) => { S.temConjuntoXml = r.ok; if (r.ok && S.dados) render(); })
  .catch(() => {});

carregarPlanoPadrao();
