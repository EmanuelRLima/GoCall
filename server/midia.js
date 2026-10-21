import { execFile } from 'child_process';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

// Abaixo disso o vídeo é, na prática, uma foto: o quadro só muda quando o
// navegador volta a desenhar o canvas. Foi o que se viu numa gravação que
// "só tinha áudio" — a faixa de vídeo existia, mas quase sem quadros.
const QUADROS_POR_SEGUNDO_MINIMO = 1;

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
export function avaliarGravacao(analise, duracaoInformadaS = null) {
  const problemas = [];
  const duracao = analise.duracao || duracaoInformadaS || null;

  let quadrosPorSegundo = null;
  if (!analise.video) {
    problemas.push('sem_faixa_de_video');
  } else if (!analise.video.pacotes) {
    problemas.push('video_sem_quadros');
  } else if (duracao) {
    quadrosPorSegundo = Math.round((analise.video.pacotes / duracao) * 10) / 10;
    if (quadrosPorSegundo < QUADROS_POR_SEGUNDO_MINIMO) problemas.push('video_quase_parado');
  }

  if (!analise.audio) problemas.push('sem_faixa_de_audio');

  return {
    ok: problemas.length === 0,
    problemas,
    duracao,
    quadros_por_segundo: quadrosPorSegundo,
  };
}
