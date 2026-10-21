// Teste de equipamento: câmera, microfone, som, conexão e uma gravação de até
// 10 segundos feita do mesmo jeito que a gravação da chamada (comum.js). Roda
// na mesma origem das chamadas — a permissão de câmera, a política do iframe
// e o caminho de rede testados são os mesmos que a chamada vai usar.
//
// Embutido no iLibras (?mode=embed), entrega o resultado à página de cima,
// que o guarda junto do usuário. Aberto direto, manda para o servidor.

const parametros = new URLSearchParams(window.location.search);
const emEmbed = parametros.get('mode') === 'embed' && window.parent !== window;
const papel = String(parametros.get('role') || '').toLowerCase();

const DURACAO_GRAVACAO_MS = 10000;
const DURACAO_MINIMA_GRAVACAO_MS = 3000;

const ETAPAS = [
  { id: 'navegador',    titulo: 'Navegador' },
  { id: 'camera',       titulo: 'Câmera' },
  { id: 'microfone',    titulo: 'Microfone' },
  { id: 'alto_falante', titulo: 'Som (alto-falante ou fone)' },
  { id: 'conexao',      titulo: 'Conexão com o servidor de vídeo' },
  { id: 'gravacao',     titulo: 'Gravação de 10 segundos' }
];

const SITUACAO = {
  aguardando: { icone: '', texto: '' },
  testando:   { icone: '', texto: 'testando...' },
  ok:         { icone: '✓', texto: 'ok' },
  atencao:    { icone: '!', texto: 'atenção' },
  falha:      { icone: '✕', texto: 'com problema' },
  pulado:     { icone: '–', texto: 'pulado' }
};

const previa = document.getElementById('previa');
const previaVazia = document.getElementById('previaVazia');
const previaRotulo = document.getElementById('previaRotulo');
const medidorNivel = document.getElementById('medidorNivel');
const seletores = document.getElementById('seletores');
const seletorCamera = document.getElementById('seletorCamera');
const seletorMicrofone = document.getElementById('seletorMicrofone');
const reproducao = document.getElementById('reproducao');
const videoGravado = document.getElementById('videoGravado');
const listaEtapas = document.getElementById('etapas');
const interacao = document.getElementById('interacao');
const interacaoTexto = document.getElementById('interacaoTexto');
const interacaoBotoes = document.getElementById('interacaoBotoes');
const resumo = document.getElementById('resumo');
const resumoTitulo = document.getElementById('resumoTitulo');
const resumoTexto = document.getElementById('resumoTexto');
const iniciarBtn = document.getElementById('iniciarBtn');
const anuncio = document.getElementById('anuncio');

let stream = null;
let rodando = false;
let resultados = {};
// Um AudioContext só, criado no clique de "Iniciar teste": o Safari só deixa
// o áudio começar dentro do gesto, e depois do pedido de permissão da câmera
// o gesto já passou.
let contextoDeAudio = null;
let fonteDoMedidor = null;
let relogioDoMedidor = null;
let nivelAtual = 0;
let urlDoVideoGravado = null;
let sinalizacao = null;

if (emEmbed) {
  document.body.classList.add('embed');
  // Dentro do iLibras o título já está na página de cima.
  document.getElementById('topo').classList.add('hidden');
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function comPrazo(promessa, ms, valorNoPrazo) {
  return Promise.race([promessa, esperar(ms).then(() => valorNoPrazo)]);
}

// ── Etapas na tela ──────────────────────────────────────────────────────

function montarEtapas() {
  listaEtapas.innerHTML = '';
  for (const etapa of ETAPAS) {
    const item = document.createElement('li');
    item.className = 'etapa';
    item.id = 'etapa-' + etapa.id;
    item.dataset.status = 'aguardando';
    item.innerHTML =
      '<span class="etapa-icone" aria-hidden="true"></span>' +
      '<div><p class="etapa-titulo"></p><p class="etapa-detalhe"></p></div>';
    item.querySelector('.etapa-titulo').textContent = etapa.titulo;
    listaEtapas.appendChild(item);
  }
}

function definirEtapa(id, status, detalhe = '', dados = {}) {
  const etapa = ETAPAS.find(e => e.id === id);
  const item = document.getElementById('etapa-' + id);
  const situacao = SITUACAO[status];
  item.dataset.status = status;
  item.querySelector('.etapa-icone').textContent = situacao.icone;

  const titulo = item.querySelector('.etapa-titulo');
  titulo.textContent = etapa.titulo;
  if (situacao.texto) {
    const marca = document.createElement('span');
    marca.className = 'etapa-situacao';
    marca.textContent = '— ' + situacao.texto;
    titulo.appendChild(marca);
  }
  item.querySelector('.etapa-detalhe').textContent = detalhe;

  if (status !== 'testando' && status !== 'aguardando') {
    resultados[id] = { status, detalhe, dados };
    anunciar(`${etapa.titulo}: ${situacao.texto}. ${detalhe}`);
  } else if (status === 'testando') {
    anunciar(`Testando ${etapa.titulo.toLowerCase()}.`);
  }
}

function anunciar(texto) {
  anuncio.textContent = texto;
}

function perguntar(texto, opcoes) {
  return new Promise((resolve) => {
    interacaoTexto.textContent = texto;
    interacaoBotoes.innerHTML = '';
    for (const opcao of opcoes) {
      const botao = document.createElement('button');
      botao.type = 'button';
      botao.className = 'botao ' + (opcao.primario ? 'botao-primario' : 'botao-secundario');
      botao.textContent = opcao.rotulo;
      botao.addEventListener('click', () => {
        if (opcao.acao) { opcao.acao(); return; }
        interacao.classList.add('hidden');
        resolve(opcao.valor);
      });
      interacaoBotoes.appendChild(botao);
    }
    interacao.classList.remove('hidden');
    const primeiro = interacaoBotoes.querySelector('.botao-primario') || interacaoBotoes.querySelector('button');
    if (primeiro) primeiro.focus();
  });
}

// ── Navegador ───────────────────────────────────────────────────────────

function nomeDoNavegador(ua) {
  const achar = (regex) => { const m = regex.exec(ua); return m ? m[1] : null; };
  let v;
  if ((v = achar(/Edg\/(\d+)/))) return 'Microsoft Edge ' + v;
  if ((v = achar(/OPR\/(\d+)/))) return 'Opera ' + v;
  if ((v = achar(/SamsungBrowser\/(\d+)/))) return 'Samsung Internet ' + v;
  if ((v = achar(/Firefox\/(\d+)/))) return 'Firefox ' + v;
  if ((v = achar(/Chrome\/(\d+)/))) return 'Chrome ' + v;
  if ((v = achar(/Version\/(\d+)[\d.]* .*Safari/))) return 'Safari ' + v;
  return 'Navegador desconhecido';
}

function testarNavegador() {
  const ua = navigator.userAgent;
  const nome = nomeDoNavegador(ua);
  const faltando = [];
  if (!window.isSecureContext) faltando.push('conexão segura (https)');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) faltando.push('acesso à câmera');
  if (!window.RTCPeerConnection) faltando.push('videochamada');
  if (!window.MediaRecorder) faltando.push('gravação de vídeo');

  const dados = { nome, agente: ua.slice(0, 300) };

  if (faltando.length) {
    definirEtapa('navegador', 'falha',
      `${nome} não oferece: ${faltando.join(', ')}. Use o Google Chrome ou o Microsoft Edge atualizados.`, dados);
    return false;
  }

  // Navegador de dentro de outro app (WhatsApp, Instagram, Facebook): costuma
  // não liberar a câmera, ou liberar e cortar ao trocar de tela.
  if (/FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)/i.test(ua)) {
    definirEtapa('navegador', 'atencao',
      'Parece que esta página abriu dentro de outro aplicativo. Abra o link no Chrome ou no Safari.', dados);
    return true;
  }

  definirEtapa('navegador', 'ok', nome, dados);
  return true;
}

// ── Câmera ──────────────────────────────────────────────────────────────

async function abrirCameraEMicrofone() {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(restricoesDeMidia()) };
  } catch (erro) {
    if (erro && (erro.name === 'OverconstrainedError' || erro.name === 'ConstraintNotSatisfiedError')) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ video: true, audio: true }) };
      } catch (outro) {
        return { erro: outro };
      }
    }
    // Sem um dos dois o pedido conjunto falha inteiro. Tenta cada um sozinho
    // para dizer qual está faltando, em vez de culpar os dois.
    if (erro && (erro.name === 'NotFoundError' || erro.name === 'DevicesNotFoundError')) {
      const soVideo = await navigator.mediaDevices.getUserMedia({ video: restricoesDeMidia().video }).catch(() => null);
      const soAudio = soVideo ? null : await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (soVideo || soAudio) return { stream: soVideo || soAudio, erro };
    }
    return { erro };
  }
}

function ehCameraVirtual(rotulo) {
  return /virtual|obs|snap camera|manycam|xsplit|droidcam|epoccam|nvidia broadcast|camo/i.test(rotulo || '');
}

// Amostra a imagem em tamanho pequeno por alguns segundos: média de brilho
// (imagem preta = tampa fechada, câmera coberta, driver entregando preto) e
// diferença entre quadros (imagem congelada). É o "vídeo preto" visto daqui,
// antes de alguém do outro lado reclamar.
async function analisarImagem(video, duracaoMs) {
  const largura = 64;
  const altura = 36;
  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const contexto = canvas.getContext('2d', { willReadFrequently: true });

  let quadrosVistos = 0;
  let medirQuadros = null;
  if (typeof video.requestVideoFrameCallback === 'function') {
    medirQuadros = () => { quadrosVistos++; video.requestVideoFrameCallback(medirQuadros); };
    video.requestVideoFrameCallback(medirQuadros);
  }

  let amostras = 0;
  let somaBrilho = 0;
  let somaDiferenca = 0;
  let comparacoes = 0;
  let anterior = null;
  const inicio = performance.now();

  while (performance.now() - inicio < duracaoMs) {
    await esperar(250);
    if (video.readyState < 2 || !video.videoWidth) continue;
    contexto.drawImage(video, 0, 0, largura, altura);
    const pixels = contexto.getImageData(0, 0, largura, altura).data;
    const brilhos = new Float32Array(largura * altura);
    let soma = 0;
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      const brilho = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      brilhos[p] = brilho;
      soma += brilho;
    }
    somaBrilho += soma / brilhos.length;
    if (anterior) {
      let diferenca = 0;
      for (let p = 0; p < brilhos.length; p++) diferenca += Math.abs(brilhos[p] - anterior[p]);
      somaDiferenca += diferenca / brilhos.length;
      comparacoes++;
    }
    anterior = brilhos;
    amostras++;
  }

  const segundos = (performance.now() - inicio) / 1000;
  return {
    amostras,
    brilho: amostras ? Math.round(somaBrilho / amostras) : null,
    variacao: comparacoes ? Math.round((somaDiferenca / comparacoes) * 100) / 100 : null,
    fps_medido: medirQuadros ? Math.round(quadrosVistos / segundos) : null
  };
}

async function testarCamera() {
  const { stream: obtido, erro } = await abrirCameraEMicrofone();

  if (!obtido) {
    const { motivo, mensagem } = descreverErroMidia(erro);
    definirEtapa('camera', 'falha', mensagem, { motivo, erro: erro && erro.name });
    definirEtapa('microfone', 'falha', 'Não foi possível testar sem acesso ao microfone.', { motivo });
    return false;
  }

  stream = obtido;
  previa.srcObject = stream;
  previa.play().catch(() => {});
  iniciarMedidor();
  await preencherSeletores();

  const trilha = stream.getVideoTracks()[0];
  if (!trilha) {
    definirEtapa('camera', 'falha', 'Nenhuma câmera foi encontrada. Conecte uma câmera e teste de novo.', { motivo: 'sem_dispositivo' });
    return true;
  }

  previaVazia.classList.add('hidden');
  previaRotulo.classList.remove('hidden');

  // Dá tempo para a câmera ajustar a exposição antes de medir o brilho.
  await esperar(800);
  const ajustes = typeof trilha.getSettings === 'function' ? trilha.getSettings() : {};
  const imagem = await analisarImagem(previa, 2500);
  const dados = {
    rotulo: trilha.label,
    largura: ajustes.width || previa.videoWidth || null,
    altura: ajustes.height || previa.videoHeight || null,
    fps: ajustes.frameRate ? Math.round(ajustes.frameRate) : null,
    ...imagem
  };
  const nome = trilha.label || 'Câmera';
  const resolucao = dados.largura && dados.altura ? `${dados.largura}×${dados.altura}` : 'resolução desconhecida';
  const fps = imagem.fps_medido || dados.fps;

  if (!imagem.amostras) {
    definirEtapa('camera', 'falha', `${nome} foi aberta, mas não entregou nenhuma imagem. Feche outros programas que usam a câmera e teste de novo.`, dados);
  } else if (imagem.brilho !== null && imagem.brilho < 12) {
    definirEtapa('camera', 'falha', `A imagem está preta. Verifique se a câmera está coberta ou com a tampa de privacidade fechada, ou escolha outra câmera abaixo.`, dados);
  } else if (imagem.variacao === 0 && imagem.amostras > 3) {
    definirEtapa('camera', 'falha', `A imagem está congelada. Desconecte e conecte a câmera de novo, ou escolha outra abaixo.`, dados);
  } else if (ehCameraVirtual(trilha.label)) {
    definirEtapa('camera', 'atencao', `"${nome}" é uma câmera virtual — ela pode mandar imagem preta se o programa dela estiver fechado. Prefira a câmera física, escolhendo abaixo.`, dados);
  } else if (imagem.brilho !== null && imagem.brilho < 45) {
    definirEtapa('camera', 'atencao', `${nome} (${resolucao}): a imagem está escura. Acenda uma luz de frente para você — sinais no escuro ficam difíceis de ler.`, dados);
  } else if (dados.largura && dados.largura < 640) {
    definirEtapa('camera', 'atencao', `${nome}: resolução baixa (${resolucao}). Os sinais podem ficar pouco nítidos.`, dados);
  } else if (fps && fps < 15) {
    definirEtapa('camera', 'atencao', `${nome} (${resolucao}) está mandando só ${fps} quadros por segundo. Pouca luz costuma causar isso; os sinais podem sair travados.`, dados);
  } else {
    definirEtapa('camera', 'ok', `${nome} — ${resolucao}${fps ? `, ${fps} quadros por segundo` : ''}.`, dados);
  }
  return true;
}

async function preencherSeletores() {
  if (!navigator.mediaDevices.enumerateDevices) return;
  const aparelhos = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cameraAtual = stream && stream.getVideoTracks()[0];
  const microfoneAtual = stream && stream.getAudioTracks()[0];

  const preencher = (seletor, tipo, trilhaAtual) => {
    seletor.innerHTML = '';
    const daqui = aparelhos.filter(a => a.kind === tipo);
    const atual = trilhaAtual && typeof trilhaAtual.getSettings === 'function' ? trilhaAtual.getSettings().deviceId : null;
    daqui.forEach((aparelho, indice) => {
      const opcao = document.createElement('option');
      opcao.value = aparelho.deviceId;
      opcao.textContent = aparelho.label || `${tipo === 'videoinput' ? 'Câmera' : 'Microfone'} ${indice + 1}`;
      if (aparelho.deviceId === atual) opcao.selected = true;
      seletor.appendChild(opcao);
    });
    seletor.disabled = rodando || daqui.length < 2;
  };

  preencher(seletorCamera, 'videoinput', cameraAtual);
  preencher(seletorMicrofone, 'audioinput', microfoneAtual);
  seletores.classList.remove('hidden');
}

// Trocar de aparelho grava a preferência (vale para as chamadas, mesma
// origem) e reabre a prévia. O teste completo fica para o "Testar de novo".
async function trocarAparelho(chave, deviceId) {
  gravarPreferencia(chave, deviceId);
  if (rodando) return;
  pararMidia();
  const { stream: novo } = await abrirCameraEMicrofone();
  if (!novo) return;
  stream = novo;
  previa.srcObject = stream;
  previa.play().catch(() => {});
  iniciarMedidor();
  await preencherSeletores();
  resumo.dataset.status = 'atencao';
  resumoTitulo.textContent = 'Aparelho trocado';
  resumoTexto.textContent = 'Clique em "Testar de novo" para conferir tudo com o aparelho novo.';
  resumo.classList.remove('hidden');
}

// ── Microfone ───────────────────────────────────────────────────────────

function obterContextoDeAudio() {
  if (!contextoDeAudio || contextoDeAudio.state === 'closed') contextoDeAudio = new AudioContext();
  if (contextoDeAudio.state === 'suspended') contextoDeAudio.resume().catch(() => {});
  return contextoDeAudio;
}

function iniciarMedidor() {
  pararMedidor();
  const trilha = stream && stream.getAudioTracks()[0];
  if (!trilha) return;

  try {
    const contexto = obterContextoDeAudio();
    fonteDoMedidor = contexto.createMediaStreamSource(stream);
    const analisador = contexto.createAnalyser();
    analisador.fftSize = 1024;
    fonteDoMedidor.connect(analisador);
    const amostra = new Float32Array(analisador.fftSize);

    relogioDoMedidor = setInterval(() => {
      analisador.getFloatTimeDomainData(amostra);
      let soma = 0;
      for (let i = 0; i < amostra.length; i++) soma += amostra[i] * amostra[i];
      nivelAtual = Math.sqrt(soma / amostra.length);
      medidorNivel.style.width = Math.min(100, Math.round(nivelAtual * 600)) + '%';
    }, 60);
  } catch (e) {
    fonteDoMedidor = null;
  }
}

function pararMedidor() {
  if (relogioDoMedidor) clearInterval(relogioDoMedidor);
  relogioDoMedidor = null;
  if (fonteDoMedidor) { try { fonteDoMedidor.disconnect(); } catch (e) {} }
  fonteDoMedidor = null;
  nivelAtual = 0;
  medidorNivel.style.width = '0';
}

async function testarMicrofone() {
  const trilha = stream && stream.getAudioTracks()[0];
  if (!trilha) {
    if (!resultados.microfone) {
      definirEtapa('microfone', 'falha', 'Nenhum microfone foi encontrado. Conecte um microfone (ou fone com microfone) e teste de novo.', { motivo: 'sem_dispositivo' });
    }
    return;
  }

  if (contextoDeAudio && contextoDeAudio.state === 'suspended') await comPrazo(contextoDeAudio.resume().catch(() => {}), 1500);

  definirEtapa('microfone', 'testando', 'Fale algo em voz alta por alguns segundos (ou bata palmas perto do computador).');
  let maximo = 0;
  const inicio = performance.now();
  while (performance.now() - inicio < 5000) {
    await esperar(60);
    maximo = Math.max(maximo, nivelAtual);
  }

  const nome = trilha.label || 'Microfone';
  const dados = { rotulo: trilha.label, nivel_maximo: Math.round(maximo * 1000) / 1000, mudo_pelo_sistema: trilha.muted };
  // Para quem só sinaliza o microfone importa menos que para o intérprete, que
  // é a voz da conversa: lá, sem som é problema; aqui, alerta.
  const semSom = papel === 'surdo' ? 'atencao' : 'falha';

  if (trilha.muted) {
    definirEtapa('microfone', semSom, `${nome} está silenciado pelo sistema. Confira o botão de mudo do fone/notebook e as configurações de som.`, dados);
  } else if (maximo >= 0.03) {
    definirEtapa('microfone', 'ok', `${nome} — som captado.`, dados);
  } else if (maximo >= 0.008) {
    definirEtapa('microfone', 'atencao', `${nome} captou som, mas baixo. Aproxime-se do microfone ou aumente o volume de entrada no sistema.`, dados);
  } else {
    definirEtapa('microfone', semSom, `${nome} não captou nenhum som. Verifique se é o microfone certo (escolha abaixo) e se ele não está no mudo.`, dados);
  }
}

// ── Alto-falante ────────────────────────────────────────────────────────

function tocarSomDeTeste() {
  const contexto = obterContextoDeAudio();
  const agora = contexto.currentTime;
  const volume = contexto.createGain();
  volume.connect(contexto.destination);
  volume.gain.setValueAtTime(0, agora);

  [523.25, 659.25, 783.99].forEach((frequencia, i) => {
    const nota = contexto.createOscillator();
    nota.type = 'sine';
    nota.frequency.value = frequencia;
    nota.connect(volume);
    const inicio = agora + i * 0.35;
    volume.gain.setValueAtTime(0, inicio);
    volume.gain.linearRampToValueAtTime(0.35, inicio + 0.03);
    volume.gain.linearRampToValueAtTime(0, inicio + 0.3);
    nota.start(inicio);
    nota.stop(inicio + 0.32);
  });

  setTimeout(() => { try { volume.disconnect(); } catch (e) {} }, 1600);
}

async function testarAltoFalante() {
  definirEtapa('alto_falante', 'testando', 'Tocamos um som curto.');
  tocarSomDeTeste();
  const resposta = await perguntar('Você ouviu o som de teste?', [
    { rotulo: 'Sim, ouvi', valor: 'sim', primario: true },
    { rotulo: 'Não ouvi', valor: 'nao' },
    { rotulo: 'Tocar de novo', acao: tocarSomDeTeste },
    { rotulo: 'Pular', valor: 'pular' }
  ]);

  if (resposta === 'sim') {
    definirEtapa('alto_falante', 'ok', 'Som funcionando.', { resposta });
  } else if (resposta === 'nao') {
    definirEtapa('alto_falante', 'atencao', 'Confira o volume, se o fone está conectado e se a saída de som certa está escolhida no sistema.', { resposta });
  } else {
    definirEtapa('alto_falante', 'pulado', 'Teste de som não feito.', { resposta });
  }
}

// ── Conexão ─────────────────────────────────────────────────────────────

// Abre o mesmo WebSocket da chamada, recebe a lista de servidores de mídia e
// mede o tempo de ida e volta. Fica aberto até o fim para mandar o resultado.
function conectarSinalizacao() {
  return new Promise((resolve) => {
    const protocolo = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
      socket = new WebSocket(`${protocolo}//${window.location.host}`);
    } catch (e) {
      resolve(null);
      return;
    }

    const estado = { socket, init: null, tempos: [] };
    let enviadoEm = 0;
    const prazo = setTimeout(() => { try { socket.close(); } catch (e) {} resolve(null); }, 8000);

    const pingar = () => { enviadoEm = performance.now(); socket.send(JSON.stringify({ type: 'ping', t: Date.now() })); };

    socket.onmessage = (evento) => {
      let dados;
      try { dados = JSON.parse(evento.data); } catch (e) { return; }
      if (dados.type === 'init') {
        estado.init = dados;
        pingar();
      } else if (dados.type === 'pong' && enviadoEm) {
        estado.tempos.push(Math.round(performance.now() - enviadoEm));
        if (estado.tempos.length < 3) {
          pingar();
        } else {
          clearTimeout(prazo);
          resolve(estado);
        }
      }
    };
    socket.onerror = () => { clearTimeout(prazo); resolve(null); };
  });
}

function tipoDoCandidato(candidato) {
  if (candidato.type) return candidato.type;
  const achado = / typ (\w+)/.exec(candidato.candidate || '');
  return achado ? achado[1] : 'desconhecido';
}

// Que caminhos de rede este computador consegue oferecer: host (rede local),
// srflx (endereço público, via STUN) e relay (via TURN). Sem srflx nem relay,
// a chamada só conecta com alguém na mesma rede.
async function coletarCandidatos(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  const contagem = { host: 0, srflx: 0, relay: 0, prflx: 0 };
  const inicio = performance.now();
  pc.createDataChannel('teste');

  const terminou = new Promise((resolve) => {
    pc.onicecandidate = (evento) => {
      if (!evento.candidate) { resolve(); return; }
      const tipo = tipoDoCandidato(evento.candidate);
      contagem[tipo] = (contagem[tipo] || 0) + 1;
    };
  });

  await pc.setLocalDescription(await pc.createOffer());
  await comPrazo(terminou, 8000);
  pc.close();
  return { ...contagem, ms: Math.round(performance.now() - inicio) };
}

// Duas conexões nesta página, obrigadas a passar pelo TURN, trocando o vídeo
// da câmera. Prova que o servidor de retransmissão aceita a credencial e que
// a mídia passa por ele — o caminho de quem está atrás de rede fechada.
// Imagem que muda sozinha, para o teste de rota não depender da câmera: sem
// ela, um problema de câmera viraria "o servidor não respondeu".
function trilhaSintetica() {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const contexto = canvas.getContext('2d');
  let matiz = 0;
  const relogio = setInterval(() => {
    matiz = (matiz + 12) % 360;
    contexto.fillStyle = `hsl(${matiz}, 70%, 50%)`;
    contexto.fillRect(0, 0, canvas.width, canvas.height);
  }, 100);
  const trilha = canvas.captureStream(10).getVideoTracks()[0];
  return { trilha, parar: () => { clearInterval(relogio); trilha.stop(); } };
}

async function testarRotaPeloServidor(iceServers) {
  const sintetica = trilhaSintetica();
  const trilha = sintetica.trilha;

  const a = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  const b = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' });
  const fechar = () => { a.close(); b.close(); sintetica.parar(); };

  try {
    a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
    b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
    a.addTrack(trilha, new MediaStream([trilha]));

    const conectou = new Promise((resolve) => {
      b.onconnectionstatechange = () => {
        if (b.connectionState === 'connected') resolve(true);
        if (b.connectionState === 'failed') resolve(false);
      };
    });

    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);

    if (!(await comPrazo(conectou, 12000, false))) {
      fechar();
      return { ok: false, motivo: 'nao_conectou' };
    }

    await esperar(2500);
    let quadros = 0;
    (await b.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'video') quadros += r.framesDecoded || 0;
    });
    fechar();
    return { ok: quadros > 0, quadros, motivo: quadros > 0 ? null : 'sem_quadros' };
  } catch (erro) {
    fechar();
    return { ok: false, motivo: 'erro', erro: String(erro.message).slice(0, 200) };
  }
}

async function testarConexao() {
  definirEtapa('conexao', 'testando', 'Falando com o servidor de vídeo...');
  sinalizacao = await conectarSinalizacao();

  if (!sinalizacao || !sinalizacao.init) {
    definirEtapa('conexao', 'falha',
      `Não foi possível falar com o servidor de vídeo (${window.location.host}). Verifique a internet; numa rede de empresa, peça para liberar esse endereço.`,
      { motivo: 'sem_sinalizacao' });
    return;
  }

  const iceServers = sinalizacao.init.iceServers || [];
  const turnConfigurado = !!sinalizacao.init.turn;
  const rtt = Math.round(sinalizacao.tempos.reduce((a, b) => a + b, 0) / sinalizacao.tempos.length);

  definirEtapa('conexao', 'testando', 'Procurando caminhos de rede para o vídeo...');
  const candidatos = await coletarCandidatos(iceServers);

  let rotaServidor = null;
  if (turnConfigurado) {
    definirEtapa('conexao', 'testando', 'Testando o vídeo pelo servidor de retransmissão...');
    rotaServidor = await testarRotaPeloServidor(iceServers);
  }

  const dados = { rtt_ms: rtt, candidatos, turn_configurado: turnConfigurado, rota_servidor: rotaServidor };
  const temDireto = candidatos.srflx > 0;
  const temServidor = !!(rotaServidor && rotaServidor.ok);

  if (!temDireto && !temServidor) {
    definirEtapa('conexao', 'falha',
      turnConfigurado
        ? 'Sua rede está bloqueando o vídeo, inclusive pelo servidor de retransmissão. Tente outra rede (por exemplo, o 4G do celular) ou peça ao suporte de TI para liberar o tráfego de videochamada.'
        : 'Sua rede está bloqueando a conexão de vídeo. Tente outra rede (por exemplo, o 4G do celular) ou peça ao suporte de TI para liberar o tráfego de videochamada (UDP).',
      dados);
  } else if (turnConfigurado && !temServidor) {
    definirEtapa('conexao', 'atencao',
      'A conexão direta funciona, mas o servidor de retransmissão não respondeu. Se a outra pessoa estiver numa rede fechada, o vídeo pode não chegar.',
      dados);
  } else if (!temDireto) {
    definirEtapa('conexao', 'atencao',
      'Sua rede bloqueia a conexão direta; o vídeo vai passar pelo servidor de retransmissão. Funciona, com um pouco mais de atraso.',
      dados);
  } else if (rtt > 400) {
    definirEtapa('conexao', 'atencao', `Conexão lenta (${rtt} ms de resposta). O vídeo pode travar; prefira cabo ou ficar perto do roteador.`, dados);
  } else {
    definirEtapa('conexao', 'ok', `Servidor respondendo em ${rtt} ms.${temServidor ? ' Retransmissão funcionando.' : ''}`, dados);
  }
}

// ── Gravação ────────────────────────────────────────────────────────────

// Mesmo caminho da gravação da chamada: canvas desenhado pelo relógio do
// Worker, áudio misturado num AudioContext, MediaRecorder com o mesmo formato
// e a mesma taxa. Depois o servidor diz se o arquivo tem quadros de vídeo.
async function gravarTrecho() {
  const canvas = document.createElement('canvas');
  canvas.width = GRAVACAO_LARGURA;
  canvas.height = GRAVACAO_ALTURA;
  const contexto = canvas.getContext('2d', { willReadFrequently: true });
  const estatisticas = { quadros_desenhados: 0, quadros_com_video: 0, relogio: 'worker' };
  const inicio = Date.now();

  const desenhar = () => {
    contexto.fillStyle = '#1a1a2e';
    contexto.fillRect(0, 0, canvas.width, canvas.height);
    if (previa.readyState >= previa.HAVE_CURRENT_DATA && previa.videoWidth) {
      desenharVideoEncaixado(contexto, previa, 0, 0, canvas.width, canvas.height);
      estatisticas.quadros_com_video++;
    }
    const segundos = Math.floor((Date.now() - inicio) / 1000);
    contexto.fillStyle = 'rgba(220, 53, 69, 0.8)';
    contexto.fillRect(10, 10, 100, 40);
    contexto.fillStyle = '#ffffff';
    contexto.font = 'bold 20px Arial';
    contexto.fillText(`⏺ 00:${String(segundos).padStart(2, '0')}`, 20, 35);
    estatisticas.quadros_desenhados++;
  };

  const audio = obterContextoDeAudio();
  await comPrazo(audio.resume().catch(() => {}), 1500);
  const destino = audio.createMediaStreamDestination();
  const fonte = stream.getAudioTracks().length ? audio.createMediaStreamSource(stream) : null;
  if (fonte) fonte.connect(destino);

  desenhar();
  const pararRelogio = criarRelogioDeQuadros(GRAVACAO_FPS, desenhar, () => { estatisticas.relogio = 'setInterval'; });
  const faixas = [canvas.captureStream(GRAVACAO_FPS).getVideoTracks()[0], ...destino.stream.getAudioTracks()];
  const formato = escolherFormatoDeGravacao();
  const gravador = new MediaRecorder(new MediaStream(faixas), {
    ...(formato ? { mimeType: formato } : {}),
    videoBitsPerSecond: GRAVACAO_BITS_VIDEO,
    audioBitsPerSecond: GRAVACAO_BITS_AUDIO
  });
  estatisticas.tipo_mime = gravador.mimeType || formato || null;

  const pedacos = [];
  gravador.ondataavailable = (e) => { if (e.data.size > 0) pedacos.push(e.data); };
  const parou = new Promise((resolve) => { gravador.onstop = resolve; });

  let pararAntes = null;
  const pedidoDeParar = new Promise((resolve) => { pararAntes = resolve; });

  gravador.start(1000);

  // Contagem na tela, com opção de parar antes (passados 3 segundos).
  interacaoTexto.innerHTML = 'Gravando: faça alguns sinais e fale algo. <span class="contagem" id="contagem"></span>';
  interacaoBotoes.innerHTML = '';
  const botaoParar = document.createElement('button');
  botaoParar.type = 'button';
  botaoParar.className = 'botao botao-secundario';
  botaoParar.textContent = 'Parar agora';
  botaoParar.disabled = true;
  botaoParar.addEventListener('click', () => pararAntes());
  interacaoBotoes.appendChild(botaoParar);
  interacao.classList.remove('hidden');

  const contagem = document.getElementById('contagem');
  const relogioTela = setInterval(() => {
    const decorrido = Date.now() - inicio;
    contagem.textContent = `${Math.max(0, Math.ceil((DURACAO_GRAVACAO_MS - decorrido) / 1000))} s`;
    botaoParar.disabled = decorrido < DURACAO_MINIMA_GRAVACAO_MS;
  }, 200);

  await Promise.race([esperar(DURACAO_GRAVACAO_MS), pedidoDeParar]);
  clearInterval(relogioTela);
  interacao.classList.add('hidden');

  gravador.stop();
  await parou;
  pararRelogio();
  if (fonte) { try { fonte.disconnect(); } catch (e) {} }

  estatisticas.duracao_ms = Date.now() - inicio;
  const tipo = gravador.mimeType || formato || 'video/webm';
  return { blob: new Blob(pedacos, { type: tipo }), tipo, estatisticas };
}

async function testarGravacao() {
  if (!stream || !stream.getVideoTracks().length) {
    definirEtapa('gravacao', 'falha', 'Sem câmera não há o que gravar.', { motivo: 'sem_camera' });
    return;
  }

  definirEtapa('gravacao', 'testando', 'Gravando um trecho de até 10 segundos...');
  let trecho;
  try {
    trecho = await gravarTrecho();
  } catch (erro) {
    interacao.classList.add('hidden');
    definirEtapa('gravacao', 'falha', 'Este navegador não conseguiu gravar o vídeo. Use o Google Chrome ou o Microsoft Edge atualizados.',
      { motivo: 'nao_gravou', erro: erro && erro.name, mensagem: String((erro && erro.message) || '').slice(0, 200) });
    return;
  }

  if (urlDoVideoGravado) URL.revokeObjectURL(urlDoVideoGravado);
  urlDoVideoGravado = URL.createObjectURL(trecho.blob);
  videoGravado.src = urlDoVideoGravado;
  reproducao.classList.remove('hidden');

  definirEtapa('gravacao', 'testando', 'Conferindo o arquivo no servidor...');
  const dados = { ...trecho.estatisticas, bytes: trecho.blob.size };

  let analise = null;
  try {
    const formulario = new FormData();
    formulario.append('duracao_ms', trecho.estatisticas.duracao_ms);
    formulario.append('gravacao', trecho.blob, `teste.${trecho.tipo.includes('webm') ? 'webm' : 'mp4'}`);
    const resposta = await fetch('/api/diagnostico/gravacao', { method: 'POST', body: formulario });
    analise = await resposta.json().catch(() => null);
    if (!resposta.ok && resposta.status !== 422) analise = null;
  } catch (e) {
    analise = null;
  }

  dados.servidor = analise;

  if (!trecho.estatisticas.quadros_com_video) {
    definirEtapa('gravacao', 'falha', 'A gravação saiu sem imagem: a câmera não entregou quadros durante a gravação.', dados);
  } else if (!analise) {
    definirEtapa('gravacao', 'atencao', 'O navegador gravou (veja o trecho ao lado), mas não foi possível conferir o arquivo no servidor.', dados);
  } else if (!analise.ok && (analise.problemas || []).some(p => /video|ilegivel/.test(p))) {
    definirEtapa('gravacao', 'falha', 'A gravação chegou ao servidor sem vídeo (só com áudio, ou sem quadros). Use o Google Chrome ou o Microsoft Edge atualizados e teste de novo.', dados);
  } else if (!analise.ok) {
    definirEtapa('gravacao', 'atencao', 'O vídeo foi gravado, mas sem áudio. Confira o microfone.', dados);
  } else if (analise.quadros_por_segundo !== null && analise.quadros_por_segundo < 10) {
    definirEtapa('gravacao', 'atencao', `Gravou, mas com poucos quadros por segundo (${analise.quadros_por_segundo}). Os sinais podem ficar travados na gravação. Feche outros programas pesados.`, dados);
  } else {
    definirEtapa('gravacao', 'ok', `Vídeo e áudio gravados${analise.quadros_por_segundo ? ` (${analise.quadros_por_segundo} quadros por segundo)` : ''}. Assista ao trecho ao lado.`, dados);
  }
}

// ── Execução ────────────────────────────────────────────────────────────

function pararMidia() {
  pararMedidor();
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  previa.srcObject = null;
  previaVazia.classList.remove('hidden');
  previaRotulo.classList.add('hidden');
}

function piorSituacao() {
  const valores = Object.values(resultados).map(r => r.status);
  if (valores.includes('falha')) return 'falha';
  if (valores.includes('atencao')) return 'atencao';
  return 'ok';
}

function mostrarResumo(status) {
  const textos = {
    ok: ['Tudo certo para atender', 'Câmera, microfone, conexão e gravação funcionando neste computador.'],
    atencao: ['Funciona, com ressalvas', 'Veja os itens marcados com "!" — dá para atender, mas vale corrigir.'],
    falha: ['Há um problema para resolver', 'Veja os itens marcados com "✕" antes de atender. Se não conseguir resolver, avise o suporte.']
  };
  resumo.dataset.status = status;
  resumoTitulo.textContent = textos[status][0];
  resumoTexto.textContent = textos[status][1];
  resumo.classList.remove('hidden');
}

function entregarResultado(resultado) {
  if (emEmbed) {
    window.parent.postMessage({ type: 'gocall-diagnostico-resultado', resultado }, '*');
    return;
  }
  if (sinalizacao && sinalizacao.socket && sinalizacao.socket.readyState === WebSocket.OPEN) {
    // Evento tem limite de tamanho no servidor: vai a situação e o detalhe de
    // cada etapa, sem os dados técnicos (que o iLibras guarda quando embutido).
    const itens = {};
    for (const [etapa, item] of Object.entries(resultado.itens)) itens[etapa] = { status: item.status, detalhe: item.detalhe };
    sinalizacao.socket.send(JSON.stringify({
      type: 'telemetria',
      papel,
      eventos: [{
        tipo: 'teste_equipamento',
        nivel: resultado.status === 'falha' ? 'aviso' : 'info',
        dados: { ...resultado, agente: undefined, itens },
        em: Date.now()
      }]
    }));
  }
}

async function executar() {
  if (rodando) return;
  obterContextoDeAudio();
  rodando = true;
  resultados = {};
  iniciarBtn.disabled = true;
  iniciarBtn.textContent = 'Testando...';
  resumo.classList.add('hidden');
  reproducao.classList.add('hidden');
  seletorCamera.disabled = true;
  seletorMicrofone.disabled = true;
  montarEtapas();
  pararMidia();

  if (emEmbed) window.parent.postMessage({ type: 'gocall-diagnostico-iniciado' }, '*');

  try {
    definirEtapa('navegador', 'testando');
    const navegadorServe = testarNavegador();

    if (navegadorServe) {
      definirEtapa('camera', 'testando', 'Se o navegador pedir, clique em "Permitir".');
      const temMidia = await testarCamera();
      if (temMidia) await testarMicrofone();
      await testarAltoFalante();
      await testarConexao();
      await testarGravacao();
    }

    for (const etapa of ETAPAS) {
      if (!resultados[etapa.id]) definirEtapa(etapa.id, 'pulado', 'Não foi possível testar.');
    }
  } catch (erro) {
    for (const etapa of ETAPAS) {
      if (!resultados[etapa.id]) {
        definirEtapa(etapa.id, 'falha', 'O teste foi interrompido por um erro inesperado.', {
          erro: erro && erro.name, mensagem: String((erro && erro.message) || '').slice(0, 200)
        });
      }
    }
  }

  const status = piorSituacao();
  const camera = stream && stream.getVideoTracks()[0];
  const microfone = stream && stream.getAudioTracks()[0];
  const resultado = {
    versao: 1,
    status,
    papel: papel || null,
    navegador: nomeDoNavegador(navigator.userAgent),
    agente: navigator.userAgent.slice(0, 300),
    camera: camera ? camera.label : null,
    microfone: microfone ? microfone.label : null,
    itens: resultados,
    concluido_em: new Date().toISOString()
  };

  mostrarResumo(status);
  entregarResultado(resultado);

  rodando = false;
  iniciarBtn.disabled = false;
  iniciarBtn.textContent = 'Testar de novo';
  await preencherSeletores();

  // A prévia continua para a pessoa ajustar o enquadramento, mas a câmera
  // tem de ser liberada antes de uma chamada: some depois de um minuto.
  setTimeout(() => { if (!rodando) pararMidia(); }, 60000);
  if (sinalizacao && sinalizacao.socket) {
    setTimeout(() => { try { sinalizacao.socket.close(); } catch (e) {} }, 1000);
  }
}

// Avisa a página de cima da altura do conteúdo, para o iframe crescer junto
// em vez de criar uma segunda barra de rolagem.
if (emEmbed && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    window.parent.postMessage({ type: 'gocall-diagnostico-altura', altura: document.documentElement.scrollHeight }, '*');
  }).observe(document.body);
}

iniciarBtn.addEventListener('click', executar);
seletorCamera.addEventListener('change', () => trocarAparelho(CHAVE_CAMERA, seletorCamera.value));
seletorMicrofone.addEventListener('change', () => trocarAparelho(CHAVE_MICROFONE, seletorMicrofone.value));
window.addEventListener('pagehide', pararMidia);

montarEtapas();
