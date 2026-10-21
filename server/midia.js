import { execFile } from 'child_process';
import { unlink } from 'fs/promises';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

// Abaixo disso o vídeo é, na prática, uma foto: o quadro só muda quando o
// navegador volta a desenhar o canvas. Foi o que se viu numa gravação que
// "só tinha áudio" — a faixa de vídeo existia, mas quase sem quadros.
const QUADROS_POR_SEGUNDO_MINIMO = 1;

// O MediaRecorder codifica no próprio computador, sem perda de pacote: um
// arquivo saudável decodifica sem erro nenhum. A folga cobre um quadro
// estranho no começo, não um vídeo que o player não consegue abrir.
const ERROS_DE_DECODIFICACAO_TOLERADOS = 2;
const SEGUNDOS_DECODIFICADOS_NA_CONFERENCIA = 20;

function rodar(binario, argumentos, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(binario, argumentos, { maxBuffer: 10 * 1024 * 1024, timeout }, (erro, saida, saidaDeErro) => {
      if (erro) {
        erro.message = `${erro.message.split('\n')[0]} ${String(saidaDeErro).trim().slice(-500)}`.trim();
        return reject(erro);
      }
      resolve({ saida, saidaDeErro: String(saidaDeErro) });
    });
  });
}

function rodarFfmpeg(argumentos) {
  // Sem timeout: recodificar uma chamada longa leva minutos.
  return rodar(ffmpegInstaller.path, ['-hide_banner', '-v', 'error', '-y', ...argumentos], 0);
}

/**
 * Lê as faixas de um arquivo de mídia com o ffprobe. Só demultiplexa (conta
 * pacotes, não decodifica), então é rápido mesmo para uma chamada longa.
 */
export function analisarMidia(caminho) {
  const argumentos = [
    '-v', 'error',
    '-count_packets',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    caminho,
  ];

  return new Promise((resolve, reject) => {
    execFile(ffprobeInstaller.path, argumentos, { maxBuffer: 10 * 1024 * 1024, timeout: 120000 }, (erro, saida) => {
      if (erro) return reject(erro);
      try {
        resolve(resumirSaidaDoFfprobe(JSON.parse(saida)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function numeroOuNulo(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function resumirSaidaDoFfprobe(saida) {
  const faixas = Array.isArray(saida.streams) ? saida.streams : [];
  const video = faixas.find(f => f.codec_type === 'video');
  const audio = faixas.find(f => f.codec_type === 'audio');

  return {
    duracao: numeroOuNulo(saida.format && saida.format.duration),
    bytes: numeroOuNulo(saida.format && saida.format.size),
    formato: (saida.format && saida.format.format_name) || null,
    video: video ? {
      codec: video.codec_name || null,
      largura: numeroOuNulo(video.width),
      altura: numeroOuNulo(video.height),
      pacotes: numeroOuNulo(video.nb_read_packets),
    } : null,
    audio: audio ? {
      codec: audio.codec_name || null,
      pacotes: numeroOuNulo(audio.nb_read_packets),
    } : null,
  };
}

/**
 * Diz se a gravação serve como registro do atendimento. A duração de
 * referência é a do arquivo; quando o contêiner não traz (WebM direto do
 * MediaRecorder não traz), usa a que o navegador mediu.
 */
export function avaliarGravacao(analise, duracaoInformadaS = null, decodificacao = null) {
  const problemas = [];
  const duracao = analise.duracao || duracaoInformadaS || null;

  let quadrosPorSegundo = null;
  if (!analise.video) {
    problemas.push('sem_faixa_de_video');
  } else if (!analise.video.pacotes) {
    problemas.push('video_sem_quadros');
  } else {
    if (duracao) {
      quadrosPorSegundo = Math.round((analise.video.pacotes / duracao) * 10) / 10;
      if (quadrosPorSegundo < QUADROS_POR_SEGUNDO_MINIMO) problemas.push('video_quase_parado');
    }
    // Contar pacotes não basta: a gravação de 20/10/2026 que "só tinha áudio"
    // tinha 15 quadros por segundo, todos ilegíveis.
    if (decodificacao && decodificacao.erros > ERROS_DE_DECODIFICACAO_TOLERADOS) {
      problemas.push('video_ilegivel');
    }
  }

  if (!analise.audio) problemas.push('sem_faixa_de_audio');

  return {
    ok: problemas.length === 0,
    problemas,
    duracao,
    quadros_por_segundo: quadrosPorSegundo,
  };
}

/**
 * Decodifica o começo do vídeo e conta as reclamações do decodificador. É o
 * que separa "tem quadros" de "o player mostra os quadros".
 */
export async function conferirDecodificacao(caminho, segundos = SEGUNDOS_DECODIFICADOS_NA_CONFERENCIA) {
  const { saida, saidaDeErro } = await rodar(ffprobeInstaller.path, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', `%+${segundos}`,
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'json',
    caminho,
  ]);
  const faixa = (JSON.parse(saida).streams || [])[0];
  return {
    quadros: numeroOuNulo(faixa && faixa.nb_read_frames),
    erros: saidaDeErro.split('\n').filter(linha => linha.trim()).length,
  };
}

// Primeira linha do dump do ffprobe: "00000000: 0000 0001 6742 c02a ...  ....gB.*"
export function comecaComCodigoDeInicio(dump) {
  const primeiraLinha = String(dump || '').trim().split('\n')[0] || '';
  const hexa = primeiraLinha.replace(/^[0-9a-f]+:\s*/i, '').split('  ')[0].replace(/\s+/g, '');
  return hexa.toLowerCase().startsWith('00000001');
}

/**
 * O Chrome 126, o primeiro a gravar MP4, põe o H.264 com código de início
 * (Anexo B) dentro de um MP4 que declara prefixo de tamanho. Todos os quadros
 * estão no arquivo, mas nenhum player os mostra: a gravação toca só o áudio.
 */
export async function h264ComCodigoDeInicio(caminho) {
  const { saida } = await rodar(ffprobeInstaller.path, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name',
    '-show_packets', '-show_data',
    '-read_intervals', '%+#1',
    '-of', 'json',
    caminho,
  ]);
  const json = JSON.parse(saida);
  const faixa = (json.streams || [])[0];
  const pacote = (json.packets || [])[0];
  return Boolean(faixa && faixa.codec_name === 'h264' && pacote && comecaComCodigoDeInicio(pacote.data));
}

/**
 * Converte o que o navegador gravou no MP4 que fica como registro. O vídeo é
 * copiado sem recodificar sempre que dá; o áudio vira AAC.
 */
export async function converterGravacao(entrada, saida) {
  const codigoDeInicio = await h264ComCodigoDeInicio(entrada).catch(() => false);
  const intermediario = codigoDeInicio ? `${saida}.ts` : null;
  let origem = entrada;

  try {
    if (codigoDeInicio) {
      // O MPEG-TS espera exatamente esse formato, então o ffmpeg copia os
      // quadros como estão; na volta para o MP4 ele os converte para o
      // formato que o contêiner declara. Leva menos de um segundo.
      await rodarFfmpeg(['-i', entrada, '-map', '0:v', '-map', '0:a?', '-c', 'copy', '-f', 'mpegts', intermediario]);
      origem = intermediario;
    }

    try {
      await rodarFfmpeg(['-i', origem, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', saida]);
      return { reempacotada: codigoDeInicio, recodificada: false };
    } catch (erroNaCopia) {
      // O MP4 não aceita todo vídeo que um navegador grava (o VP8 do Firefox,
      // por exemplo). Recodificar custa CPU, mas perder a gravação inteira
      // custa o registro do atendimento. "-vsync vfr" mantém os tempos do
      // navegador; sem ele o ffmpeg duplicava quadros para preencher uma taxa
      // fixa e a conversão não terminava.
      await rodarFfmpeg([
        '-i', origem,
        '-vsync', 'vfr',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        saida,
      ]);
      return { reempacotada: codigoDeInicio, recodificada: true, erro_na_copia: erroNaCopia.message.slice(0, 300) };
    }
  } finally {
    if (intermediario) await unlink(intermediario).catch(() => {});
  }
}
