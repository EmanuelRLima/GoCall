// Peças usadas pela chamada (app.js) e pelo teste de equipamento
// (diagnostico.js). O teste só diz alguma coisa se gravar e abrir a câmera do
// mesmo jeito que a chamada — por isso o código é um só.

// Sem constraints o navegador escolhe sozinho, e a escolha costuma ser 4:3 em
// baixa resolução. Em boa parte das webcams o 4:3 é o 16:9 recortado nas
// laterais — some justamente a faixa onde as mãos do intérprete trabalham.
// Tudo em 'ideal' de propósito: câmera que não atender entrega o que puder em
// vez de estourar OverconstrainedError e deixar o atendimento sem vídeo.
const VIDEO_CONSTRAINTS = {
  width:       { ideal: 1280 },
  height:      { ideal: 720 },
  aspectRatio: { ideal: 16 / 9 },
  frameRate:   { ideal: 30 }
};

// Câmera e microfone escolhidos no teste de equipamento. O teste e a chamada
// estão na mesma origem, então a escolha feita lá vale aqui. Em 'ideal': se o
// aparelho sumir (câmera USB desconectada), o navegador usa o padrão.
const CHAVE_CAMERA = 'gocall.camera';
const CHAVE_MICROFONE = 'gocall.microfone';

function lerPreferencia(chave) {
  try { return localStorage.getItem(chave) || null; } catch (e) { return null; }
}

function gravarPreferencia(chave, valor) {
  try {
    if (valor) localStorage.setItem(chave, valor);
    else localStorage.removeItem(chave);
  } catch (e) {
    // Armazenamento bloqueado (aba anônima, cookies de terceiros desligados):
    // a escolha vale só até fechar a página.
  }
}

function restricoesDeMidia() {
  const camera = lerPreferencia(CHAVE_CAMERA);
  const microfone = lerPreferencia(CHAVE_MICROFONE);
  return {
    video: camera ? { ...VIDEO_CONSTRAINTS, deviceId: { ideal: camera } } : VIDEO_CONSTRAINTS,
    audio: microfone ? { deviceId: { ideal: microfone } } : true
  };
}

// Traduz a falha do getUserMedia para algo acionável. O que os navegadores
// padronizam é o .name do erro; a mensagem que vem junto é técnica e em
// inglês, então não serve para a tela de quem está atendendo.
function descreverErroMidia(erro) {
  switch (erro && erro.name) {
    // Dispositivo existe e foi liberado, mas o sistema não conseguiu abrir:
    // na prática é sempre outro app segurando a câmera. Vale para desktop e
    // para Android; TrackStartError é o nome antigo do mesmo caso no Chrome.
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        motivo: 'em_uso',
        mensagem: 'Sua câmera ou microfone já está sendo usado por outro aplicativo. '
                + 'Feche o outro programa (Teams, Meet, Zoom, app de câmera) e entre novamente.'
      };

    // O Firefox usa AbortError onde o Chrome usa NotReadableError, mas pela
    // spec ele é o balde do "deu errado e não é nenhum dos outros". Trata
    // como ocupado (é a causa comum) sem afirmar que é.
    case 'AbortError':
      return {
        motivo: 'em_uso',
        mensagem: 'Não foi possível iniciar a câmera ou o microfone. '
                + 'Verifique se outro aplicativo está usando o dispositivo e entre novamente.'
      };

    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        motivo: 'sem_permissao',
        mensagem: 'Permissão de câmera/microfone negada. '
                + 'Libere o acesso nas configurações do navegador e entre novamente.'
      };

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        motivo: 'sem_dispositivo',
        mensagem: 'Nenhuma câmera ou microfone foi encontrado neste dispositivo.'
      };

    default:
      return { motivo: 'falha', mensagem: 'Falha ao acessar câmera/microfone.' };
  }
}

// Ritmo dos quadros da gravação. Timer de Worker não para quando a aba fica
// escondida (o do requestAnimationFrame para, e o setInterval da página cai
// para um por segundo ou menos). Sem Worker, fica o setInterval: pior, mas
// ainda melhor que o rAF. `aoUsarReserva` avisa quando foi preciso cair nele.
function criarRelogioDeQuadros(fps, aoTique, aoUsarReserva) {
  const intervalo = Math.round(1000 / fps);
  let worker = null;
  let relogio = null;
  let url = null;

  const usarSetInterval = () => {
    if (worker) { worker.terminate(); worker = null; }
    if (!relogio) relogio = setInterval(aoTique, intervalo);
    if (aoUsarReserva) aoUsarReserva();
  };

  try {
    const codigo = 'let t=null;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
    url = URL.createObjectURL(new Blob([codigo], { type: 'text/javascript' }));
    worker = new Worker(url);
    // A URL só é liberada depois do primeiro tique: revogada logo após o
    // new Worker, alguns navegadores ainda não tinham lido o script.
    worker.onmessage = () => {
      if (url) { URL.revokeObjectURL(url); url = null; }
      aoTique();
    };
    worker.onerror = usarSetInterval;
    worker.postMessage(intervalo);
  } catch (e) {
    usarSetInterval();
  }

  return () => {
    if (worker) { worker.postMessage(0); worker.terminate(); worker = null; }
    if (relogio) { clearInterval(relogio); relogio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
  };
}

function escolherFormatoDeGravacao() {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  // H.264 antes de tudo: costuma ter codificador na placa de vídeo e toca
  // em qualquer aparelho. Pedir só "video/mp4" deixava o navegador escolher, e
  // o Edge escolhia VP9, codificado pelo processador: num computador modesto a
  // gravação saiu com 5 quadros por segundo dos 30 desenhados.
  const candidatos = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidatos.find(tipo => MediaRecorder.isTypeSupported(tipo)) || '';
}

// Encaixa o quadro na célula preservando a proporção. O drawImage esticado
// deformava o vídeo (uma célula de 960x1080 recebendo um 16:9), e sinal
// deformado é sinal ilegível na gravação, que é o registro do atendimento.
function desenharVideoEncaixado(contexto, video, x, y, largura, altura) {
  const larguraFonte = video.videoWidth || 16;
  const alturaFonte  = video.videoHeight || 9;
  const escala = Math.min(largura / larguraFonte, altura / alturaFonte);
  const larguraDestino = larguraFonte * escala;
  const alturaDestino  = alturaFonte * escala;
  contexto.drawImage(
    video,
    x + (largura - larguraDestino) / 2,
    y + (altura - alturaDestino) / 2,
    larguraDestino,
    alturaDestino
  );
}

// 1280x720: as câmeras entregam no máximo 720p e, em 1920x1080, quase metade
// da imagem gravada era faixa preta. Codificar Full HD em tempo real era o que
// pesava no computador do intérprete (gravação a 5-14 quadros/s numa máquina
// modesta, em 21/10/2026). A taxa acompanha a área, com folga para os sinais.
const GRAVACAO_LARGURA = 1280;
const GRAVACAO_ALTURA = 720;
const GRAVACAO_FPS = 30;
const GRAVACAO_BITS_VIDEO = 1500000;
const GRAVACAO_BITS_AUDIO = 128000;
// A gravação sobe em pedaços durante a chamada. Cinco segundos (~1 MB) é o
// máximo que se perde se a aba fechar de repente.
const GRAVACAO_PEDACO_MS = 5000;
