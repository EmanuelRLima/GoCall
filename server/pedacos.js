import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import path from 'path';

// Gravação em pedaços. O navegador do intérprete grava a chamada inteira e,
// antes, só mandava o arquivo no fim: numa chamada de 21 minutos (atendimento
// 42, 21/10/2026) eram 260 MB subindo depois do "Encerrar", a tela desistiu
// de esperar aos 3 minutos e o vídeo se perdeu. Agora cada pedaço sobe
// durante a chamada e fica em disco aqui; no fim falta só o último.
//
// Se a aba fechar ou o computador travar, o que já chegou vira o vídeo do
// atendimento mesmo assim: quem fecha a gravação, nesse caso, é o aviso da
// página saindo ou, sem ele, a inatividade.

const ID_VALIDO = /^[A-Za-z0-9_-]{8,64}$/;
const SEQ_MAXIMO = 100000;
const FALTANDO_NO_EVENTO = 50;

export function idDeGravacaoValido(id) {
  return typeof id === 'string' && ID_VALIDO.test(id);
}

function erroDaGravacao(status, codigo) {
  const erro = new Error(codigo);
  erro.status = status;
  erro.codigo = codigo;
  return erro;
}

const nomeDaParte = (seq) => `${String(seq).padStart(6, '0')}.parte`;

// Pedaço a pedaço, sem ler o arquivo inteiro para a memória: uma chamada
// longa passa de centenas de MB.
async function juntar(partes, destino) {
  const saida = await open(destino, 'w');
  try {
    for (const parte of partes) {
      await saida.write(await readFile(parte));
    }
  } finally {
    await saida.close();
  }
}

export function seqsFaltando(partes, totalInformado = null) {
  const recebidos = Object.keys(partes).map(Number);
  const ultimo = Math.max(-1, ...recebidos, (Number.isInteger(totalInformado) ? totalInformado : 0) - 1);
  const faltando = [];
  for (let seq = 0; seq <= ultimo; seq++) {
    if (!(seq in partes)) faltando.push(seq);
  }
  return faltando;
}

/**
 * `aoFinalizar` recebe o arquivo montado e devolve false quando não conseguiu
 * processar: aí os pedaços ficam em disco para recuperar à mão, em vez de
 * sumirem junto com o arquivo temporário.
 */
export function criarGravacoesEmPedacos({
  pasta,
  inatividadeMs = 10 * 60 * 1000,
  maxBytes = Infinity,
  aoFinalizar,
  agora = () => Date.now(),
  log = console,
}) {
  const pastaTemporaria = path.join(pasta, '.recebendo');
  const abertas = new Map();
  const encerradas = new Set();
  const filas = new Map();
  const processando = new Set();

  const pastaDe = (id) => path.join(pasta, id);

  // Operações da mesma gravação em fila: o pedaço que chega enquanto o
  // anterior ainda está sendo guardado não pode ler o meta.json pela metade.
  function emSerie(id, tarefa) {
    const atual = (filas.get(id) || Promise.resolve()).catch(() => {}).then(tarefa);
    filas.set(id, atual);
    const limpar = () => { if (filas.get(id) === atual) filas.delete(id); };
    atual.then(limpar, limpar);
    return atual;
  }

  async function salvarMeta(meta) {
    const destino = path.join(pastaDe(meta.id), 'meta.json');
    await writeFile(`${destino}.tmp`, JSON.stringify(meta));
    await rename(`${destino}.tmp`, destino);
  }

  async function receberPedaco({ id, sala, papel = null, seq, arquivo, bytes, tipoMime = null, estatisticas = null }) {
    if (!idDeGravacaoValido(id)) throw erroDaGravacao(400, 'id_invalido');
    if (!Number.isInteger(seq) || seq < 0 || seq > SEQ_MAXIMO) throw erroDaGravacao(400, 'seq_invalido');

    return emSerie(id, async () => {
      let meta = abertas.get(id);

      if (!meta) {
        // Sem o primeiro pedaço não há cabeçalho do vídeo, e o resto não
        // abre em player nenhum. Pedaço de gravação já fechada também cai
        // aqui depois de um reinício, quando a lista de encerradas se perde.
        if (seq !== 0 || encerradas.has(id)) throw erroDaGravacao(409, 'gravacao_encerrada');
        if (!sala) throw erroDaGravacao(400, 'sala_obrigatoria');
        meta = {
          id,
          sala,
          papel,
          tipo_mime: tipoMime,
          inicio: agora(),
          ultimo_pedaco_em: agora(),
          partes: {},
          bytes: 0,
          estatisticas: {},
        };
        await mkdir(pastaDe(id), { recursive: true });
      } else if (meta.finalizada_em) {
        throw erroDaGravacao(409, 'gravacao_encerrada');
      }

      // O mesmo pedaço pode chegar duas vezes (a resposta se perdeu e o
      // navegador tentou de novo): substitui, não soma.
      const anterior = meta.partes[seq] || 0;
      if (meta.bytes - anterior + bytes > maxBytes) throw erroDaGravacao(413, 'gravacao_grande_demais');

      await rename(arquivo, path.join(pastaDe(id), nomeDaParte(seq)));
      meta.partes[seq] = bytes;
      meta.bytes += bytes - anterior;
      meta.ultimo_pedaco_em = agora();
      if (estatisticas && Object.keys(estatisticas).length) meta.estatisticas = estatisticas;
      abertas.set(id, meta);
      await salvarMeta(meta);

      return { recebidos: Object.keys(meta.partes).length, bytes: meta.bytes };
    });
  }

  async function processar(meta) {
    if (processando.has(meta.id)) return;
    processando.add(meta.id);

    const seqs = Object.keys(meta.partes).map(Number).sort((a, b) => a - b);
    const faltando = seqsFaltando(meta.partes, meta.total_informado);
    const bruto = path.join(pastaDe(meta.id), 'gravacao.bruta');
    let concluida = false;

    try {
      await juntar(seqs.map(seq => path.join(pastaDe(meta.id), nomeDaParte(seq))), bruto);
      const resultado = await aoFinalizar({
        id: meta.id,
        sala: meta.sala,
        papel: meta.papel,
        inicio: meta.inicio,
        caminho: bruto,
        bytes: meta.bytes,
        pedacos: seqs.length,
        faltando: faltando.slice(0, FALTANDO_NO_EVENTO),
        quantos_faltando: faltando.length,
        motivo: meta.motivo,
        estatisticas: meta.estatisticas || {},
      });
      concluida = resultado !== false;
    } catch (erro) {
      log.error(`Gravação ${meta.id} (sala ${meta.sala}) não foi processada:`, erro);
    }

    try {
      if (concluida) {
        await rm(pastaDe(meta.id), { recursive: true, force: true });
      } else {
        meta.falhou_em = agora();
        await salvarMeta(meta);
        log.error(`Pedaços da gravação ${meta.id} mantidos em ${pastaDe(meta.id)} para recuperar à mão.`);
      }
    } finally {
      abertas.delete(meta.id);
      encerradas.add(meta.id);
      processando.delete(meta.id);
    }
  }

  /**
   * Fecha a gravação e manda processar com o que chegou. Não espera o
   * processamento: converter e subir para o S3 pode levar minutos.
   */
  function finalizar(id, { total = null, estatisticas = null, motivo = 'cliente' } = {}) {
    if (!idDeGravacaoValido(id)) return Promise.reject(erroDaGravacao(400, 'id_invalido'));

    return emSerie(id, async () => {
      const meta = abertas.get(id);
      if (!meta) return { status: encerradas.has(id) ? 'ja_finalizada' : 'desconhecida' };
      if (meta.finalizada_em) return { status: 'ja_finalizada' };

      meta.finalizada_em = agora();
      meta.motivo = motivo;
      if (Number.isInteger(total)) meta.total_informado = total;
      if (estatisticas && Object.keys(estatisticas).length) meta.estatisticas = estatisticas;
      await salvarMeta(meta);

      processar(meta);
      return { status: 'processando', pedacos: Object.keys(meta.partes).length };
    });
  }

  async function varrer() {
    const limite = agora() - inatividadeMs;
    for (const meta of Array.from(abertas.values())) {
      if (meta.finalizada_em || meta.ultimo_pedaco_em > limite) continue;
      await finalizar(meta.id, { motivo: 'inatividade' }).catch((erro) => {
        log.error(`Não consegui fechar a gravação parada ${meta.id}:`, erro);
      });
    }
  }

  /**
   * Na subida do servidor: o que estava gravando continua aberto (o
   * navegador segue mandando depois do reinício), e o que já tinha sido
   * fechado mas não terminou de processar é processado de novo.
   */
  async function recuperar() {
    await mkdir(pasta, { recursive: true });
    await rm(pastaTemporaria, { recursive: true, force: true });
    await mkdir(pastaTemporaria, { recursive: true });

    for (const nome of await readdir(pasta)) {
      if (!idDeGravacaoValido(nome)) continue;
      let meta;
      try {
        meta = JSON.parse(await readFile(path.join(pasta, nome, 'meta.json'), 'utf8'));
      } catch (erro) {
        log.error(`Gravação ${nome} sem meta.json legível; deixada como está.`);
        continue;
      }
      if (meta.falhou_em) {
        encerradas.add(meta.id);
      } else if (meta.finalizada_em) {
        processar(meta);
      } else {
        abertas.set(meta.id, meta);
      }
    }
  }

  async function descartarArquivo(arquivo) {
    await unlink(arquivo).catch(() => {});
  }

  return {
    pastaTemporaria,
    receberPedaco,
    finalizar,
    varrer,
    recuperar,
    descartarArquivo,
    abertas: () => Array.from(abertas.keys()),
  };
}
