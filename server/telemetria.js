// Eventos da chamada (entrou, conexão falhou, vídeo parou, gravação sem
// vídeo...) que antes não deixavam rastro nenhum: o log do GoCall só tinha
// "Server running". Cada evento vira uma linha no log daqui e segue em lote
// para o iLibras, que guarda junto do atendimento e alerta pelo Nightwatch.

export const NIVEIS = ['info', 'aviso', 'erro'];

const TIPO_VALIDO = /^[a-z0-9_]{1,60}$/;
const DADOS_MAX_CARACTERES = 4000;
const FILA_MAXIMA = 1000;
const LOTE_MAXIMO = 100;
const UM_DIA_MS = 24 * 60 * 60 * 1000;

function objetoSimples(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function textoCurto(valor, maximo) {
  if (valor === undefined || valor === null) return null;
  const texto = String(valor).trim();
  return texto ? texto.slice(0, maximo) : null;
}

/**
 * O WebSocket é público (a sala do surdo não tem login), então tudo que chega
 * do navegador é tratado como entrada de qualquer um: tipo em formato fixo,
 * nível de uma lista, dados limitados em tamanho e hora plausível.
 */
export function normalizarEventoDoCliente(bruto, agoraMs = Date.now()) {
  if (!objetoSimples(bruto)) return null;

  const tipo = String(bruto.tipo || '');
  if (!TIPO_VALIDO.test(tipo)) return null;

  const nivel = NIVEIS.includes(bruto.nivel) ? bruto.nivel : 'info';

  let dados = objetoSimples(bruto.dados) ? bruto.dados : {};
  try {
    if (JSON.stringify(dados).length > DADOS_MAX_CARACTERES) dados = { truncado: true };
  } catch (e) {
    dados = { invalido: true };
  }

  const em = Number(bruto.em);
  const emValido = Number.isFinite(em) && Math.abs(em - agoraMs) < UM_DIA_MS ? em : agoraMs;

  return { tipo, nivel, dados, em: emValido };
}

export function criarTelemetria({ url, token, fetchImpl = globalThis.fetch, log = console, intervaloMs = 10000 } = {}) {
  const fila = [];
  let enviando = false;
  let envioAgendado = null;

  function registrar(evento) {
    const completo = {
      sala: textoCurto(evento.sala, 120),
      origem: evento.origem === 'cliente' ? 'cliente' : 'servidor',
      papel: textoCurto(evento.papel, 30),
      cliente: textoCurto(evento.cliente, 30),
      tipo: evento.tipo,
      nivel: NIVEIS.includes(evento.nivel) ? evento.nivel : 'info',
      dados: objetoSimples(evento.dados) ? evento.dados : {},
      em: Number.isFinite(evento.em) ? evento.em : Date.now(),
    };

    // Uma linha por evento, em JSON: dá para filtrar o log do supervisor com
    // grep pela sala mesmo sem o iLibras no ar.
    log.log('[evento] ' + JSON.stringify(completo));

    if (!url) return;

    fila.push(completo);
    if (fila.length > FILA_MAXIMA) fila.splice(0, fila.length - FILA_MAXIMA);

    // Erro sai na hora: é o que vira alerta, e esperar o próximo ciclo só
    // atrasa o aviso de uma chamada que está quebrando agora.
    if (completo.nivel === 'erro' && !envioAgendado) {
      envioAgendado = setTimeout(() => { envioAgendado = null; enviar(); }, 500);
    }
  }

  async function enviar() {
    if (!url || enviando || !fila.length) return;
    enviando = true;

    const lote = fila.splice(0, LOTE_MAXIMO);
    try {
      const resposta = await fetchImpl(`${url.replace(/\/$/, '')}/api/webhooks/gocall/eventos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Token': token || '' },
        body: JSON.stringify({ eventos: lote }),
      });

      // 4xx não melhora repetindo (token errado, payload recusado): descarta
      // o lote e deixa o motivo no log. 5xx e rede caída voltam para a fila.
      if (resposta.status >= 500) {
        fila.unshift(...lote);
        log.error(`Eventos: iLibras respondeu ${resposta.status}; ${lote.length} evento(s) voltam para a fila.`);
      } else if (!resposta.ok) {
        log.error(`Eventos: iLibras recusou o lote (${resposta.status}): ${await resposta.text()}`);
      }
    } catch (erro) {
      fila.unshift(...lote);
      log.error('Eventos: falha ao enviar ao iLibras:', erro.message);
    } finally {
      if (fila.length > FILA_MAXIMA) fila.splice(0, fila.length - FILA_MAXIMA);
      enviando = false;
    }
  }

  const relogio = setInterval(enviar, intervaloMs);
  if (relogio.unref) relogio.unref();

  return {
    registrar,
    enviar,
    pendentes: () => fila.length,
    parar: () => clearInterval(relogio),
  };
}
