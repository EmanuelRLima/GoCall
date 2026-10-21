let ws;
let myId;
let currentRoom = null;
let localStream;
let isAudioMuted = false;
let isVideoMuted = false;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingCanvas = null;
let recordingContext = null;
let recordingAudioContext = null;
let roomIsRecording = false;
let lastRecordingResult = null;
let recordingUploadResolve = null;
let isUploadingRecording = false;
// Encerrar é caminho de mão única e reentrante: o end-call faz os peers
// saírem, o handlePeerLeft chamaria hangup() de novo no meio do upload e a
// gravação subiria duas vezes. O primeiro pedido manda; os outros voltam.
let encerrando = false;
// A sala foi encerrada por quem conduz o atendimento — não é uma saída
// qualquer, então quem fica não volta para o formulário do lobby.
let salaEncerrada = false;

// Gravação. O quadro era desenhado no requestAnimationFrame, que o navegador
// para por completo quando a aba fica escondida (outra aba na frente, janela
// minimizada ou coberta): o vídeo congelava e a gravação saía "só com áudio".
// Agora quem marca o ritmo é um relógio num Worker, que segue rodando.
let pararRelogioDeQuadros = null;
let relogioVigiaGravacao = null;
let destinoDeAudioDaGravacao = null;
const fontesDeAudioDaGravacao = new Map();
let estatisticasDaGravacao = null;
// A sala da gravação fica guardada à parte: se a conexão com o servidor cair
// no meio, currentRoom some, e a gravação subiria sem dizer de que sala é.
let salaDaGravacao = null;
// A gravação sobe em pedaços durante a chamada, não mais inteira no fim: os
// 260 MB de uma chamada de 21 minutos levavam mais que os 3 minutos que a
// tela esperava, e o vídeo se perdia. Cada pedaço fica na fila até o
// servidor confirmar.
let gravacaoId = null;
let proximoPedaco = 0;
const pedacosParaEnviar = [];
let enviandoPedacos = false;
let aoEsvaziarFilaDePedacos = null;
let envioDaGravacaoRecusado = false;
let gravacaoFinalizada = false;
let envioAtrasado = false;
let ultimoErroDoEnvio = null;

const peerConnections = new Map();
// O que cada conexão precisa lembrar além do RTCPeerConnection: quem fez a
// oferta (é quem reinicia o ICE), as tentativas, os relógios e os candidatos
// que chegaram antes da hora.
const infoDosPares = new Map();
// Candidatos de um par cuja conexão ainda não existe. Antes eram descartados
// em silêncio — e cada candidato perdido é um caminho de rede a menos.
const candidatosAntecipados = new Map();

const peerTiles = new Map();
// O tile local tinha o id do WebSocket como chave; o id muda a cada
// reconexão, e o tile antigo passava a ser tratado como de outra pessoa.
const TILE_LOCAL = 'local';

// Câmera e microfone de cada participante, como ele mesmo anunciou. É o que
// separa "desligou a câmera" de "o vídeo não está chegando".
const estadoMidiaDosPares = new Map();

// Reescrita pelo servidor no 'init', que é quem conhece o TURN. Fica o STUN
// enquanto isso, para o caso de o servidor ser uma versão antiga.
let iceServers = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];
let turnDisponivel = false;

// Sinalização. As mensagens são tratadas uma de cada vez, na ordem em que
// chegam: com o onmessage assíncrono, um candidato podia ser aplicado no meio
// do setRemoteDescription da oferta e ser recusado.
let filaDeMensagens = Promise.resolve();
let relogioPing = null;
let pingSemRespostaDesde = null;
// A conexão com o servidor caiu durante a chamada: ao reconectar, volta para
// esta sala sem pedir câmera de novo e sem desmontar a tela.
let salaParaVoltar = null;

let relogioMonitor = null;
let relogioSozinho = null;
let entrouNaSalaEm = null;
let sozinhoDesde = null;
let avisouSozinho = false;
let entrandoNaSala = false;

// Carga do processador ('nominal', 'fair', 'serious' ou 'critical'), quando o
// navegador informa. É o que separa "a rede travou" de "o computador não deu
// conta" quando o vídeo de um lado para de sair.
let pressaoDaCpu = null;
let piorPressaoDaCpu = null;
let ultimaAmostraDeQualidade = 0;
const INTERVALO_AMOSTRA_QUALIDADE_MS = 60000;
const ORDEM_DA_PRESSAO = ['nominal', 'fair', 'serious', 'critical'];

// Quem ficou sozinho espera este tempo antes de encerrar: um F5 do surdo ou
// uma troca de rede derrubavam a chamada na hora, com o intérprete indo para
// o feedback de um atendimento que ainda não tinha acabado.
const ESPERA_PELA_VOLTA_MS = 30000;
const MAX_TENTATIVAS_ICE = 6;
// Ao fechar o navegador a câmera e o microfone terminam antes da página.
// Esperar um pouco antes de acusar deixa esse caso morrer junto com ela.
const ESPERA_ANTES_DE_ACUSAR_TRILHA_MS = 2000;
let paginaSaindo = false;

const parametros = new URLSearchParams(window.location.search);
const isEmbedMode = parametros.get('mode') === 'embed';
const isInterpreter = parametros.get('role') === 'interprete';
// O papel vira o rótulo que os outros veem. Sem role na URL o servidor devolve
// 'Participante', que ainda diz mais do que um pedaço do id.
const papelNaChamada = parametros.get('role') || '';
const salaDaUrl = parametros.get('room') || null;

// Em modo embed o lobby fica escondido, então a mensagem acima não chegaria a
// ninguém. Quem a exibe é a página do iLibras que embute o GoCall — e é ela
// que recusa a chamada, devolvendo o atendimento para a fila.
function avisarFalhaDeMidia(motivo, mensagem) {
  if (!isEmbedMode || window.parent === window) return;
  window.parent.postMessage({ type: 'webrtc-midia-indisponivel', motivo, mensagem }, '*');
}

// Muita câmera (e o driver do Windows) sobe com zoom digital aplicado,
// fechando o enquadramento no rosto. Quando a track expõe a capability de
// zoom, puxamos para o mínimo: é o ângulo mais aberto que o hardware dá.
async function abrirAnguloMaximo(stream) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') return;

  try {
    const caps = track.getCapabilities();
    if (caps.zoom && typeof caps.zoom.min === 'number') {
      await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
    }
  } catch (e) {
    // Firefox não implementa getCapabilities e alguns drivers recusam o
    // applyConstraints. Sem zoom out, mas com vídeo: seguimos com o padrão.
  }
}


const lobbyEl     = document.getElementById('lobby');
const roomEl      = document.getElementById('room');
const myIdElement = document.getElementById('myId');
const roomIdInput = document.getElementById('roomId');
const joinBtn     = document.getElementById('joinBtn');
const lobbyStatus = document.getElementById('lobbyStatus');

const videosGrid  = document.getElementById('videosGrid');
const roomLabel   = document.getElementById('roomLabel');
const muteBtn     = document.getElementById('muteBtn');
const videoBtn    = document.getElementById('videoBtn');
const encerradaEl     = document.getElementById('encerrada');
const encerradaTexto  = document.getElementById('encerradaTexto');
const statusElement = document.getElementById('status');

const chatEl         = document.getElementById('chat');
const chatBtn        = document.getElementById('chatBtn');
const chatBadge      = document.getElementById('chatBadge');
const chatFecharBtn  = document.getElementById('chatFecharBtn');
const chatMensagens  = document.getElementById('chatMensagens');
const chatForm       = document.getElementById('chatForm');
const chatTexto      = document.getElementById('chatTexto');

// Rótulo de cada participante ('Intérprete', 'Surdo', 'Suporte'), vindo do
// servidor. Substitui o pedaço do id que aparecia no tile e não dizia nada.
const peerRotulos = new Map();
let chatAberto = false;
let chatNaoLidas = 0;


// ── Eventos da chamada ──────────────────────────────────────────────────
// O que acontece aqui (conexão que não fecha, vídeo que para, gravação sem
// quadros) vai para o servidor e de lá para o iLibras, junto do atendimento.
// Antes nada disso deixava rastro, e cada relato de "vídeo preto" virava
// suposição. Enquanto a conexão está caída os eventos esperam na fila.
const filaDeEventos = [];

function registrarEvento(tipo, nivel = 'info', dados = {}) {
  filaDeEventos.push({ tipo, nivel, dados, em: Date.now() });
  if (filaDeEventos.length > 200) filaDeEventos.splice(0, filaDeEventos.length - 200);
  enviarEventos();
}

function enviarEventos() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (filaDeEventos.length) {
    ws.send(JSON.stringify({
      type: 'telemetria',
      sala: currentRoom || salaParaVoltar || salaDaUrl,
      papel: papelNaChamada,
      eventos: filaDeEventos.splice(0, 20)
    }));
  }
}

function descreverAmbiente() {
  const video = localStream && localStream.getVideoTracks()[0];
  const audio = localStream && localStream.getAudioTracks()[0];
  const ajustes = video && typeof video.getSettings === 'function' ? video.getSettings() : {};
  return {
    navegador: navigator.userAgent.slice(0, 300),
    embed: isEmbedMode,
    turn: turnDisponivel,
    camera: video ? {
      rotulo: video.label,
      largura: ajustes.width || null,
      altura: ajustes.height || null,
      fps: ajustes.frameRate ? Math.round(ajustes.frameRate) : null
    } : null,
    microfone: audio ? audio.label : null,
    rede: navigator.connection ? navigator.connection.effectiveType : null
  };
}


// Mesmo de-para que o servidor aplica ao 'papel' recebido no join-room. Aqui
// serve só para o próprio tile, que é desenhado antes do servidor responder.
function rotuloDoPapel(papel) {
  const mapa = { interprete: 'Intérprete', suporte: 'Suporte', surdo: 'Surdo' };
  return mapa[String(papel || '').toLowerCase()] || '';
}

/**
 * Atualiza um botão que alterna entre dois estados. O ícone é decorativo (fica
 * num <span aria-hidden>); quem carrega o significado é o aria-label, que diz a
 * PRÓXIMA ação, e o aria-pressed, que diz o estado ATUAL.
 *
 * Antes, o textContent era trocado direto — o que apagava o span e deixava o
 * rótulo congelado no estado inicial.
 */
function atualizarBotaoAlternavel(botao, { icone, rotulo, ativo }) {
  const span = botao.querySelector('span[aria-hidden="true"]');
  if (span) span.textContent = icone;
  else botao.textContent = icone;

  botao.setAttribute('aria-label', rotulo);
  botao.setAttribute('aria-pressed', ativo ? 'true' : 'false');
}

function abrirChat() {
  chatAberto = true;
  chatEl.classList.remove('hidden');
  chatBtn.setAttribute('aria-expanded', 'true');
  chatBtn.setAttribute('aria-label', 'Fechar chat');
  chatNaoLidas = 0;
  atualizarBadge();
  chatMensagens.scrollTop = chatMensagens.scrollHeight;
}

function fecharChat() {
  chatAberto = false;
  chatEl.classList.add('hidden');
  chatBtn.setAttribute('aria-expanded', 'false');
  chatBtn.setAttribute('aria-label', 'Abrir chat');
}

function alternarChat() {
  if (chatAberto) fecharChat(); else abrirChat();
}

function atualizarBadge() {
  chatBadge.textContent = chatNaoLidas > 9 ? '9+' : String(chatNaoLidas);
  chatBadge.classList.toggle('hidden', chatNaoLidas === 0);
}

function limparChat() {
  chatMensagens.innerHTML = '';
  chatNaoLidas = 0;
  atualizarBadge();
  fecharChat();
  mostrarVazioSeVazio();
}

function mostrarVazioSeVazio() {
  if (chatMensagens.children.length) return;
  const vazio = document.createElement('p');
  vazio.className = 'chat-vazio';
  vazio.textContent = 'Nenhuma mensagem ainda. Escreva abaixo para falar com quem está na chamada.';
  chatMensagens.appendChild(vazio);
}

function tirarVazio() {
  const vazio = chatMensagens.querySelector('.chat-vazio');
  if (vazio) vazio.remove();
}

// Rola só se já estava no fim: senão quem subiu para reler uma mensagem seria
// puxado de volta a cada chegada.
function rolarChatSePerto() {
  const distanciaDoFim = chatMensagens.scrollHeight - chatMensagens.scrollTop - chatMensagens.clientHeight;
  if (distanciaDoFim < 80) chatMensagens.scrollTop = chatMensagens.scrollHeight;
}

function horaCurta(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function adicionarEventoChat(texto) {
  tirarVazio();
  const el = document.createElement('div');
  el.className = 'chat-evento';
  el.textContent = texto;
  chatMensagens.appendChild(el);
  rolarChatSePerto();
}

function receberMensagemChat(dados) {
  tirarVazio();

  const propria = dados.de === myId;
  const el = document.createElement('div');
  el.className = 'chat-msg' + (propria ? ' propria' : '');

  const autor = document.createElement('span');
  autor.className = 'chat-autor';
  autor.textContent = propria ? 'Você' : (dados.rotulo || 'Participante');

  // textContent e nunca innerHTML: o texto vem de outro participante e a sala
  // do surdo é pública, então qualquer um pode digitar o que quiser aqui.
  const corpo = document.createElement('span');
  corpo.className = 'chat-texto';
  corpo.textContent = dados.texto;

  const hora = document.createElement('span');
  hora.className = 'chat-hora';
  hora.textContent = horaCurta(dados.em || Date.now());

  el.appendChild(autor);
  el.appendChild(corpo);
  el.appendChild(hora);
  chatMensagens.appendChild(el);

  // Mensagem que chega com o chat fechado abre o painel. Aviso sonoro não
  // serve para quem é surdo, e um contador discreto passa despercebido no
  // meio de uma conversa em sinais — aqui precisa aparecer.
  if (!chatAberto && !propria) abrirChat();

  rolarChatSePerto();
}

function enviarMensagemChat(evento) {
  evento.preventDefault();
  const texto = chatTexto.value.trim();
  if (!texto) return;
  if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) {
    adicionarEventoChat('Sem conexão com o servidor. Mensagem não enviada.');
    return;
  }
  sendMessage({ type: 'chat', texto });
  chatTexto.value = '';
}

function createTile(id, label, stream, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.dataset.peerId = id;

  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.textContent = '👤';

  const video = document.createElement('video');
  // O quadro é de alguém: sem rótulo, o leitor de tela anuncia só "vídeo".
  video.setAttribute('aria-label', 'Vídeo de ' + label);
  video.setAttribute('title', label);
  video.autoplay = true;
  video.playsinline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  if (isLocal) video.muted = true;
  if (isLocal) video.setAttribute('muted', '');

  const lbl = document.createElement('span');
  lbl.className = 'tile-label';
  lbl.textContent = label;

  // Por que o quadro está preto: conexão caindo, câmera desligada pelo outro
  // lado ou vídeo que não chega. Sem isso o tile preto não dizia nada, e
  // cada lado achava que o problema era do outro.
  const aviso = document.createElement('div');
  aviso.className = 'tile-aviso hidden';
  aviso.setAttribute('role', 'status');

  tile.appendChild(avatar);
  tile.appendChild(video);
  tile.appendChild(lbl);
  tile.appendChild(aviso);

  videosGrid.appendChild(tile);
  updateGridCount();

  if (stream) {
    video.srcObject = stream;
    tile.classList.add('has-video');
    tocarVideo(tile, video);
  }

  return tile;
}

function removeTile(peerId) {
  const tile = peerTiles.get(peerId);
  if (tile) {
    tile.remove();
    peerTiles.delete(peerId);
    updateGridCount();
  }
}

function updateGridCount() {
  const count = videosGrid.children.length;
  videosGrid.dataset.count = count;
}

function setTileStream(tile, stream) {
  const video = tile.querySelector('video');
  if (video.srcObject !== stream) video.srcObject = stream;
  tile.classList.add('has-video');
  tocarVideo(tile, video);
}

// Mais de um motivo pode valer ao mesmo tempo; aparece o mais importante.
function definirAviso(peerId, motivo, texto) {
  const tile = peerTiles.get(peerId);
  if (!tile) return false;
  tile._avisos = tile._avisos || {};
  if (texto) tile._avisos[motivo] = texto; else delete tile._avisos[motivo];

  const atual = ['conexao', 'camera', 'video'].map(m => tile._avisos[m]).find(Boolean);
  const el = tile.querySelector('.tile-aviso');
  el.textContent = atual || '';
  el.classList.toggle('hidden', !atual);
  return true;
}

// O navegador barra vídeo com som sem um clique na página (política de
// autoplay). Sem tratamento o play() falhava calado e o tile ficava preto.
// Sem som o vídeo ainda passa — e vídeo é o que importa para quem sinaliza —,
// então entra mudo e um botão pede o toque que libera o áudio.
function tocarVideo(tile, video) {
  video.play().catch((erro) => {
    if (!erro || erro.name !== 'NotAllowedError' || video.muted) return;
    registrarEvento('autoplay_bloqueado', 'aviso', {});
    video.muted = true;
    video.play().catch(() => {});
    mostrarBotaoDeSom(tile);
  });
}

function mostrarBotaoDeSom(tile) {
  if (tile.querySelector('.tile-som')) return;
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'tile-som';
  botao.textContent = '🔇 Toque aqui para ativar o som';
  botao.addEventListener('click', liberarSom);
  tile.appendChild(botao);
}

// Qualquer toque na página serve: o que o navegador exige é um gesto.
function liberarSom() {
  for (const [peerId, tile] of peerTiles) {
    if (peerId === TILE_LOCAL) continue;
    const botao = tile.querySelector('.tile-som');
    if (!botao) continue;
    const video = tile.querySelector('video');
    video.muted = false;
    video.play()
      .then(() => botao.remove())
      .catch(() => { video.muted = true; video.play().catch(() => {}); });
  }
  if (recordingAudioContext && recordingAudioContext.state === 'suspended') {
    recordingAudioContext.resume().catch(() => {});
  }
}

function sendMessage(msg) {
  // Fora do OPEN o send() lança (CONNECTING) ou descarta calado (CLOSING):
  // os dois casos acontecem justamente quando a rede está oscilando.
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// ── Conexão com o servidor ──────────────────────────────────────────────

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.onopen = () => {
    showLobbyStatus('Conectado ao servidor', 'success');
    joinBtn.disabled = false;
    iniciarPing();
  };

  socket.onmessage = (event) => {
    // Qualquer mensagem prova que a conexão está viva, não só o pong.
    pingSemRespostaDesde = null;
    filaDeMensagens = filaDeMensagens
      .then(() => tratarMensagem(event.data))
      .catch((erro) => registrarEvento('erro_na_sinalizacao', 'aviso', {
        mensagem: String((erro && erro.message) || erro).slice(0, 300)
      }));
  };

  socket.onerror = () => {
    showLobbyStatus('Falha na conexão WebSocket', 'error');
    joinBtn.disabled = true;
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    tratarQuedaDoWebSocket('fechou');
  };
}

// O servidor derruba quem não responde ao ping dele, mas o navegador não fica
// sabendo de uma conexão meio-aberta (rede trocada, Wi-Fi que voltou): o
// onclose pode levar minutos. Este eco descobre em segundos.
function iniciarPing() {
  pararPing();
  pingSemRespostaDesde = null;
  relogioPing = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pingSemRespostaDesde && Date.now() - pingSemRespostaDesde > 12000) {
      derrubarWebSocket('sem_resposta');
      return;
    }
    if (!pingSemRespostaDesde) {
      pingSemRespostaDesde = Date.now();
      sendMessage({ type: 'ping', t: pingSemRespostaDesde });
    }
  }, 4000);
}

function pararPing() {
  if (relogioPing) clearInterval(relogioPing);
  relogioPing = null;
}

function derrubarWebSocket(motivo) {
  const antigo = ws;
  if (antigo) {
    antigo.onopen = antigo.onmessage = antigo.onerror = antigo.onclose = null;
    try { antigo.close(); } catch (e) {}
  }
  tratarQuedaDoWebSocket(motivo);
}

// A mídia vai direto de um navegador ao outro, sem passar pelo servidor: a
// queda do WebSocket não precisa derrubar a chamada. Antes ela desmontava a
// sala inteira e pedia a câmera de novo; agora a tela fica, a sinalização
// volta e a conexão com cada participante é refeita por cima.
function tratarQuedaDoWebSocket(motivo) {
  pararPing();
  showLobbyStatus('Desconectado do servidor. Reconectando...', 'error');
  joinBtn.disabled = true;

  if (currentRoom) {
    salaParaVoltar = currentRoom;
    currentRoom = null;
    showStatus('Conexão com o servidor caiu. Reconectando...', 'error');
    registrarEvento('sinalizacao_caiu', 'aviso', { motivo, gravando: isRecording });
  }

  setTimeout(connectWebSocket, 3000);
}

function voltarParaSala() {
  const sala = salaParaVoltar;
  salaParaVoltar = null;
  currentRoom = sala;
  sendMessage({ type: 'join-room', room: sala, papel: papelNaChamada });
  registrarEvento('sinalizacao_voltou', 'info', {});
}

async function tratarMensagem(texto) {
  const data = JSON.parse(texto);
  switch (data.type) {
    case 'init': {
      myId = data.id;
      myIdElement.textContent = myId;
      if (Array.isArray(data.iceServers) && data.iceServers.length) iceServers = data.iceServers;
      turnDisponivel = !!data.turn;
      enviarEventos();

      if (salaParaVoltar && localStream && !salaEncerrada && !encerrando) {
        voltarParaSala();
        break;
      }

      // Auto-join quando o parâmetro ?room= está na URL (integração iLibras).
      // O WebSocket reconecta sozinho; sem a guarda de salaEncerrada o
      // auto-join devolveria o surdo à sala que o intérprete encerrou.
      // Sem await: o pedido de câmera pode esperar a pessoa clicar em
      // "Permitir", e a fila de mensagens não pode parar por isso.
      if (salaDaUrl && !salaEncerrada && !currentRoom) {
        roomIdInput.value = salaDaUrl;
        joinRoom();
      }
      break;
    }

    case 'pong':
      break;

    case 'room-joined': {
      for (const [id, rotulo] of Object.entries(data.rotulos || {})) peerRotulos.set(id, rotulo);
      const peers = data.peers.filter(id => id !== myId);
      // Voltando de uma queda: quem saiu da sala enquanto a conexão estava
      // fora não vai mandar peer-left para este id novo.
      for (const id of Array.from(peerConnections.keys())) {
        if (!peers.includes(id)) handlePeerLeft(id);
      }
      await enterRoom(data.room, peers);
      break;
    }

    case 'room-full':
      showLobbyStatus('Sala lotada (máximo 5 participantes)', 'error');
      registrarEvento('sala_lotada', 'aviso', {});
      currentRoom = null;
      break;

    case 'peer-joined':
      if (data.rotulo) peerRotulos.set(data.peerId, data.rotulo);
      cancelarEsperaSozinho();
      showStatus(`Novo participante entrando...`, 'info');
      adicionarEventoChat((data.rotulo || 'Participante') + ' entrou na chamada');
      // Quem chega não sabe que a câmera daqui está desligada.
      if (isVideoMuted || isAudioMuted) anunciarEstadoDaMidia();
      break;

    // Quem conduz o atendimento encerrou: a sala acabou para todos.
    case 'room-closed':
      salaEncerrada = true;
      mostrarTelaEncerrada('O atendimento foi encerrado pelo intérprete.');
      hangup('sala_encerrada');
      break;

    case 'peer-left':
      handlePeerLeft(data.peerId);
      break;

    case 'offer':
      await handleOffer(data);
      break;

    case 'answer':
      await handleAnswer(data);
      break;

    case 'ice-candidate':
      await handleIceCandidate(data);
      break;

    // Só quem fez a oferta reinicia o ICE; o outro lado pede por aqui.
    case 'pedir-reinicio':
      await reiniciarIce(data.from, 'pedido_do_par');
      break;

    case 'estado-midia':
      estadoMidiaDosPares.set(data.from, {
        camera: data.camera !== false,
        microfone: data.microfone !== false
      });
      aplicarEstadoDaMidia(data.from);
      break;

    case 'chat':
      receberMensagemChat(data);
      break;

    case 'recording-started':
      if (data.recorderId !== myId) {
        roomIsRecording = true;
        showStatus((peerRotulos.get(data.recorderId) || 'Outro participante') + ' está gravando...', 'info');
      }
      break;

    case 'recording-stopped':
      if (data.recorderId !== myId) {
        roomIsRecording = false;
        showStatus('Gravação finalizada', 'info');
      }
      break;
  }
}

// O pedido de câmera pode levar segundos (a pessoa ainda vai tocar em
// "Permitir"), e um segundo clique em "Entrar" nesse meio-tempo abria duas
// câmeras e entrava duas vezes na sala. Foi o que atrasou em 20 s a conexão
// de uma chamada em 21/10/2026.
async function joinRoom() {
  if (entrandoNaSala || currentRoom) return;
  entrandoNaSala = true;
  try {
    await entrarNaSala();
  } finally {
    entrandoNaSala = false;
  }
}

async function entrarNaSala() {
  const room = roomIdInput.value.trim();
  if (!room) {
    showLobbyStatus('Informe o ID da sala', 'error');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showLobbyStatus('Aguardando conexão com o servidor...', 'error');
    return;
  }

  showLobbyStatus('Acessando câmera/microfone...', 'info');

  try {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    localStream = await navigator.mediaDevices.getUserMedia(restricoesDeMidia());
  } catch (error) {
    // Repetir sem constraints só resolve quando foi a constraint que não coube.
    // Câmera ocupada, permissão negada ou ausência de dispositivo falham de novo
    // igual, e aí o que precisa chegar à tela é o motivo real — não um genérico.
    let falha = error;

    if (error && (error.name === 'OverconstrainedError' || error.name === 'ConstraintNotSatisfiedError')) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        falha = null;
      } catch (erroSemConstraints) {
        falha = erroSemConstraints;
      }
    }

    if (falha) {
      const { motivo, mensagem } = descreverErroMidia(falha);
      showLobbyStatus(mensagem, 'error');
      avisarFalhaDeMidia(motivo, mensagem);
      // É o caso em que a outra pessoa "não entra nunca": ela ficou presa
      // aqui, e do lado de lá só se via a sala vazia.
      registrarEvento('midia_indisponivel', 'erro', {
        motivo,
        erro: falha && falha.name,
        mensagem: String((falha && falha.message) || '').slice(0, 300),
        navegador: navigator.userAgent.slice(0, 300)
      });
      return;
    }
  }

  await abrirAnguloMaximo(localStream);
  vigiarTrilhasLocais(localStream);

  lobbyEl.classList.add('hidden');
  roomEl.classList.remove('hidden');
  videosGrid.innerHTML = '';
  peerTiles.clear();
  peerRotulos.clear();
  updateGridCount();
  const rotuloProprio = rotuloDoPapel(papelNaChamada);
  const localTile = createTile(TILE_LOCAL, rotuloProprio ? 'Você (' + rotuloProprio + ')' : 'Você', localStream, true);
  peerTiles.set(TILE_LOCAL, localTile);

  currentRoom = room;
  entrouNaSalaEm = Date.now();
  sozinhoDesde = null;
  avisouSozinho = false;
  limparChat();
  sendMessage({ type: 'join-room', room, papel: papelNaChamada });
  registrarEvento('midia_pronta', 'info', descreverAmbiente());
  iniciarMonitor();
  showLobbyStatus('Entrando na sala...', 'info');
}

async function enterRoom(room, peers) {
  try {
    roomLabel.textContent = `Sala: ${room}`;
    showStatus(`${peers.length + 1} participante(s)`, 'success');
    for (const peerId of peers) {
      await startCallTo(peerId);
    }
    if (isInterpreter && !isRecording && !mediaRecorder) {
      setTimeout(() => startRecording(), 1000);
    }
  } catch (error) {
    showLobbyStatus('Erro ao entrar na sala: ' + error.message, 'error');
    registrarEvento('erro_ao_entrar', 'erro', { mensagem: String(error.message).slice(0, 300) });
  }
}

// A câmera pode sumir no meio da chamada: cabo USB, outro programa que a
// toma, a tampa de privacidade. Quem está do outro lado só vê o quadro preto.
function vigiarTrilhasLocais(stream) {
  for (const track of stream.getTracks()) {
    const ehVideo = track.kind === 'video';

    track.addEventListener('ended', () => {
      setTimeout(() => {
        if (paginaSaindo || !localStream || !localStream.getTracks().includes(track)) return;
        registrarEvento(ehVideo ? 'camera_parou' : 'microfone_parou', 'erro', { rotulo: track.label });
        showStatus(ehVideo
          ? 'Sua câmera parou de funcionar. Verifique se ela foi desconectada ou se outro programa a está usando.'
          : 'Seu microfone parou de funcionar. Verifique se ele foi desconectado.', 'error');
      }, ESPERA_ANTES_DE_ACUSAR_TRILHA_MS);
    });

    // "mute" aqui não é o botão de silenciar: é o sistema deixando de entregar
    // quadros (ou som) para o navegador. O outro lado recebe preto.
    track.addEventListener('mute', () => {
      if (!localStream || !localStream.getTracks().includes(track)) return;
      registrarEvento(ehVideo ? 'camera_sem_imagem' : 'microfone_sem_som', 'aviso', { rotulo: track.label });
    });
    track.addEventListener('unmute', () => {
      if (!localStream || !localStream.getTracks().includes(track)) return;
      registrarEvento(ehVideo ? 'camera_voltou' : 'microfone_voltou', 'info', {});
    });
  }
}

// ── Conexão com cada participante ───────────────────────────────────────

function tipoDoCandidato(candidato) {
  if (!candidato) return 'desconhecido';
  if (candidato.type) return candidato.type;
  const achado = / typ (\w+)/.exec(candidato.candidate || '');
  return achado ? achado[1] : 'desconhecido';
}

function contarCandidato(contagem, candidato) {
  const tipo = tipoDoCandidato(candidato);
  contagem[tipo] = (contagem[tipo] || 0) + 1;
}

function fecharPar(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
    peerConnections.delete(peerId);
  }
  const info = infoDosPares.get(peerId);
  if (info) {
    clearTimeout(info.relogioQueda);
    clearTimeout(info.relogioConexao);
    infoDosPares.delete(peerId);
  }
}

function createPeerConnection(peerId, ofertante) {
  fecharPar(peerId);

  const pc = new RTCPeerConnection({ iceServers });
  const info = {
    ofertante,
    tentativas: 0,
    reiniciando: false,
    desistiu: false,
    caiu: false,
    relogioQueda: null,
    relogioConexao: null,
    criadoEm: Date.now(),
    conectadoEm: null,
    candidatosLocais: {},
    candidatosRemotos: {},
    pendentes: candidatosAntecipados.get(peerId) || [],
    amostra: null,
    checagensSemQuadro: 0,
    videoParado: false,
    videoParadoDesde: null,
    errosTurn: []
  };
  info.pendentes.forEach(c => contarCandidato(info.candidatosRemotos, c));
  candidatosAntecipados.delete(peerId);
  infoDosPares.set(peerId, info);
  peerConnections.set(peerId, pc);
  cancelarEsperaSozinho();

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // O ontrack chega junto com a descrição remota, antes de qualquer pacote
  // de vídeo: o tile aparece já aqui, mas "conectada" só vale no
  // connectionState. Antes era aqui que se dizia "Chamada conectada" — e,
  // sem rota de rede entre os dois, o tile ficava preto para sempre.
  pc.ontrack = (event) => {
    let tile = peerTiles.get(peerId);
    if (!tile) {
      tile = createTile(peerId, peerRotulos.get(peerId) || 'Participante', null, false);
      peerTiles.set(peerId, tile);
    }
    const stream = event.streams[0] || new MediaStream([event.track]);
    setTileStream(tile, stream);
    ligarAudioNaGravacao(peerId, stream);
    aplicarEstadoDaMidia(peerId);
    if (pc.connectionState !== 'connected') {
      definirAviso(peerId, 'conexao', 'Conectando o vídeo...');
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    contarCandidato(info.candidatosLocais, event.candidate);
    sendMessage({ type: 'ice-candidate', candidate: event.candidate, target: peerId });
  };

  // Erro de TURN sozinho não quer dizer nada: em máquina com IPv6 sem rota,
  // o Chrome reporta 701 em toda chamada mesmo com o relay funcionando pelo
  // IPv4. E faltar candidato relay também não: quando os dois lados se acham
  // na rede local, o Chrome encerra a coleta antes de o TURN responder. Os
  // erros só são guardados, para ir junto quando a conexão não fechar.
  pc.onicecandidateerror = (event) => {
    if (!/^turns?:/.test(event.url || '') || info.errosTurn.length >= 5) return;
    const erro = `${event.errorCode} ${String(event.errorText || '').slice(0, 80)} (${event.url})`;
    if (!info.errosTurn.includes(erro)) info.errosTurn.push(erro);
  };

  pc.onconnectionstatechange = () => tratarEstadoDaConexao(peerId, pc);

  // Rede que não deixa nada passar às vezes não chega a 'failed': fica em
  // 'connecting' indefinidamente, com o tile preto dos dois lados.
  info.relogioConexao = setTimeout(() => conexaoDemorou(peerId, pc), 20000);

  return pc;
}

function rotuloDe(peerId) {
  return peerRotulos.get(peerId) || 'o participante';
}

function conexaoDemorou(peerId, pc) {
  const info = infoDosPares.get(peerId);
  if (!info || peerConnections.get(peerId) !== pc || pc.connectionState === 'connected') return;

  registrarEvento('conexao_nao_estabelecida', 'aviso', {
    estado: pc.connectionState,
    ice: pc.iceConnectionState,
    coleta: pc.iceGatheringState,
    candidatos_locais: info.candidatosLocais,
    candidatos_remotos: info.candidatosRemotos,
    turn: turnDisponivel,
    erros_turn: info.errosTurn,
    segundos: Math.round((Date.now() - info.criadoEm) / 1000)
  });
  // Não conectou e este lado nem conseguiu endereço no TURN: o servidor de
  // retransmissão não respondeu (porta bloqueada na rede, credencial vencida).
  if (turnDisponivel && !info.candidatosLocais.relay) {
    registrarEvento('turn_falhou', 'aviso', { erros: info.errosTurn, coleta: pc.iceGatheringState });
  }
  if (!definirAviso(peerId, 'conexao', 'Não foi possível conectar o vídeo. Tentando de novo...')) {
    showStatus(`Não foi possível conectar com ${rotuloDe(peerId)}. Tentando de novo...`, 'error');
  }
  reiniciarIce(peerId, 'nao_conectou');
}

function tratarEstadoDaConexao(peerId, pc) {
  if (peerConnections.get(peerId) !== pc) return;
  const info = infoDosPares.get(peerId);
  if (!info) return;
  const estado = pc.connectionState;

  if (estado === 'connected') {
    clearTimeout(info.relogioQueda);
    clearTimeout(info.relogioConexao);
    info.relogioQueda = info.relogioConexao = null;

    const primeiraVez = !info.conectadoEm;
    const msAteConectar = Date.now() - info.criadoEm;
    info.conectadoEm = info.conectadoEm || Date.now();
    info.tentativas = 0;
    info.caiu = false;
    info.desistiu = false;
    definirAviso(peerId, 'conexao', null);
    showStatus('Chamada conectada', 'success');

    descreverRota(pc).then(rota => registrarEvento(
      primeiraVez ? 'conexao_estabelecida' : 'conexao_restabelecida', 'info',
      { ...rota, turn: turnDisponivel, ms_ate_conectar: primeiraVez ? msAteConectar : undefined }
    ));
    return;
  }

  if (estado === 'disconnected') {
    // 'disconnected' costuma se resolver sozinho em segundos (Wi-Fi
    // oscilando, troca de rede). Antes ele era tratado como saída do
    // participante e a chamada caía na hora.
    info.caiu = true;
    definirAviso(peerId, 'conexao', 'Conexão instável — reconectando...');
    registrarEvento('conexao_instavel', 'aviso', {});
    clearTimeout(info.relogioQueda);
    info.relogioQueda = setTimeout(() => {
      if (peerConnections.get(peerId) === pc && pc.connectionState !== 'connected') {
        reiniciarIce(peerId, 'instavel');
      }
    }, 5000);
    return;
  }

  if (estado === 'failed') {
    info.caiu = true;
    definirAviso(peerId, 'conexao', 'A conexão caiu — reconectando...');
    reiniciarIce(peerId, 'falhou');
  }
}

// Reinício de ICE: procura um caminho de rede novo sem refazer a chamada. Só
// quem fez a oferta original reinicia — os dois ao mesmo tempo mandariam
// ofertas cruzadas —, e o outro lado pede por mensagem.
async function reiniciarIce(peerId, motivo) {
  const pc = peerConnections.get(peerId);
  const info = infoDosPares.get(peerId);
  if (!pc || !info || pc.signalingState === 'closed' || pc.connectionState === 'connected') return;
  if (info.reiniciando) return;

  if (info.tentativas >= MAX_TENTATIVAS_ICE) {
    if (!info.desistiu) {
      info.desistiu = true;
      registrarEvento('conexao_falhou', 'erro', {
        motivo,
        tentativas: info.tentativas,
        estado: pc.connectionState,
        ice: pc.iceConnectionState,
        candidatos_locais: info.candidatosLocais,
        candidatos_remotos: info.candidatosRemotos,
        turn: turnDisponivel,
        erros_turn: info.errosTurn
      });
      if (!definirAviso(peerId, 'conexao', `Não foi possível conectar com ${rotuloDe(peerId)}. Peça para a pessoa recarregar a página.`)) {
        showStatus(`Não foi possível conectar com ${rotuloDe(peerId)}.`, 'error');
      }
    }
    return;
  }

  info.tentativas++;
  registrarEvento('reiniciando_conexao', 'aviso', { motivo, tentativa: info.tentativas });

  if (!info.ofertante) {
    sendMessage({ type: 'pedir-reinicio', target: peerId });
  } else {
    info.reiniciando = true;
    try {
      const oferta = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(oferta);
      sendMessage({ type: 'offer', offer: pc.localDescription, target: peerId });
    } catch (erro) {
      registrarEvento('reinicio_falhou', 'aviso', { mensagem: String(erro.message).slice(0, 300) });
    } finally {
      info.reiniciando = false;
    }
  }

  // Espera crescente: a rede que caiu às vezes só volta depois de alguns
  // segundos, e insistir rápido demais só gasta tentativa.
  clearTimeout(info.relogioQueda);
  info.relogioQueda = setTimeout(() => {
    if (peerConnections.get(peerId) === pc && pc.connectionState !== 'connected') {
      reiniciarIce(peerId, 'sem_sucesso');
    }
  }, Math.min(5000 * info.tentativas, 20000));
}

// Por onde a mídia passa: direto na rede local (host), pelo endereço público
// (srflx) ou pelo TURN (relay). É o que diz se faltou TURN quando não conecta.
async function descreverRota(pc) {
  try {
    const stats = await pc.getStats();
    let par = null;
    stats.forEach(r => {
      if (r.type === 'transport' && r.selectedCandidatePairId) par = stats.get(r.selectedCandidatePairId);
    });
    if (!par) {
      // Firefox não tem selectedCandidatePairId; marca o par escolhido nele.
      stats.forEach(r => {
        if (!par && r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) par = r;
      });
    }
    if (!par) return {};
    const local = stats.get(par.localCandidateId) || {};
    const remoto = stats.get(par.remoteCandidateId) || {};
    return {
      local: local.candidateType || null,
      remoto: remoto.candidateType || null,
      protocolo: local.protocol || null,
      relay: local.candidateType === 'relay' || remoto.candidateType === 'relay',
      rtt_ms: typeof par.currentRoundTripTime === 'number' ? Math.round(par.currentRoundTripTime * 1000) : null
    };
  } catch (e) {
    return {};
  }
}

async function startCallTo(peerId) {
  const pc = createPeerConnection(peerId, true);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendMessage({ type: 'offer', offer: pc.localDescription, target: peerId });
}

async function handleOffer(data) {
  const peerId = data.from;
  let pc = peerConnections.get(peerId);
  const info = infoDosPares.get(peerId);

  // Oferta de quem já tem conexão com este lado é reinício de ICE (a rede
  // mudou): reaproveita a conexão em vez de derrubar o vídeo e recomeçar.
  const renegociacao = pc && info && !info.ofertante && pc.signalingState !== 'closed';
  if (!renegociacao) {
    pc = createPeerConnection(peerId, false);
    showStatus('Chamada recebida', 'info');
  }

  await pc.setRemoteDescription(data.offer);
  await aplicarCandidatosPendentes(peerId, pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendMessage({ type: 'answer', answer: pc.localDescription, target: peerId });
}

async function handleAnswer(data) {
  const pc = peerConnections.get(data.from);
  // Resposta de uma oferta que já foi substituída por outra: aplicar daria
  // InvalidStateError e não mudaria nada.
  if (!pc || pc.signalingState !== 'have-local-offer') return;
  await pc.setRemoteDescription(data.answer);
  await aplicarCandidatosPendentes(data.from, pc);
}

async function handleIceCandidate(data) {
  const peerId = data.from;
  const pc = peerConnections.get(peerId);
  const info = infoDosPares.get(peerId);

  if (!pc || !info) {
    const lista = candidatosAntecipados.get(peerId) || [];
    lista.push(data.candidate);
    candidatosAntecipados.set(peerId, lista.slice(-50));
    return;
  }

  contarCandidato(info.candidatosRemotos, data.candidate);
  if (!pc.remoteDescription) {
    info.pendentes.push(data.candidate);
    return;
  }
  try {
    await pc.addIceCandidate(data.candidate);
  } catch (e) {
    // Candidato de uma rodada anterior de ICE: não serve mais.
  }
}

async function aplicarCandidatosPendentes(peerId, pc) {
  const info = infoDosPares.get(peerId);
  if (!info) return;
  for (const candidato of info.pendentes.splice(0)) {
    try { await pc.addIceCandidate(candidato); } catch (e) {}
  }
}

function aplicarEstadoDaMidia(peerId) {
  const estado = estadoMidiaDosPares.get(peerId);
  const info = infoDosPares.get(peerId);
  const cameraDesligada = !!estado && estado.camera === false;
  if (info) info.cameraDesligadaPeloPar = cameraDesligada;
  definirAviso(peerId, 'camera', cameraDesligada ? `${peerRotulos.get(peerId) || 'O participante'} desligou a câmera.` : null);
}

function anunciarEstadoDaMidia() {
  if (!currentRoom) return;
  sendMessage({ type: 'estado-midia', camera: !isVideoMuted, microfone: !isAudioMuted });
}

// Confere, de tempos em tempos, se o vídeo de cada participante está chegando.
// A conexão pode estar "conectada" e os quadros pararem (câmera do outro lado
// travada, decodificador com problema, rede só deixando passar áudio).
function iniciarMonitor() {
  pararMonitor();
  relogioMonitor = setInterval(monitorarChamada, 4000);
}

function pararMonitor() {
  if (relogioMonitor) clearInterval(relogioMonitor);
  relogioMonitor = null;
}

async function monitorarChamada() {
  if (!currentRoom && !salaParaVoltar) return;

  // Conta desde que ficou sozinho, não desde que entrou: quem perde o outro
  // lado depois de 8 minutos de chamada não está sozinho há 8 minutos.
  if (peerConnections.size > 0) {
    sozinhoDesde = null;
  } else if (!sozinhoDesde) {
    sozinhoDesde = Date.now();
  } else if (!avisouSozinho && Date.now() - sozinhoDesde > 90000) {
    avisouSozinho = true;
    registrarEvento('sozinho_na_sala', 'aviso', { segundos: Math.round((Date.now() - sozinhoDesde) / 1000) });
  }

  const amostrar = Date.now() - ultimaAmostraDeQualidade >= INTERVALO_AMOSTRA_QUALIDADE_MS;
  const amostras = [];

  for (const [peerId, pc] of peerConnections) {
    const info = infoDosPares.get(peerId);
    if (!info || pc.connectionState !== 'connected') continue;

    let medidas;
    try {
      medidas = await lerEstatisticas(pc);
    } catch (e) {
      continue;
    }

    const anterior = info.amostra;
    info.amostra = medidas;
    if (amostrar) amostras.push({ par: papelDe(peerId), ...resumirMedidas(medidas, anterior) });
    if (!anterior) continue;

    vigiarEnvio(peerId, pc, info, medidas, anterior);

    const quadros = medidas.recebido.quadros;
    const bytes = medidas.recebido.bytes;
    const enviados = medidas.enviado.quadros;
    if (quadros === null) continue;

    const parado = quadros === anterior.recebido.quadros && !info.cameraDesligadaPeloPar;
    if (parado) {
      info.checagensSemQuadro++;
      if (info.checagensSemQuadro === 2 && !info.videoParado) {
        info.videoParado = true;
        info.videoParadoDesde = Date.now();
        definirAviso(peerId, 'video', `O vídeo de ${rotuloDe(peerId)} não está chegando.`);
        const rota = await descreverRota(pc);
        // bytes chegando sem quadro decodificado é problema de decodificação
        // deste lado; nada chegando é o outro lado que não envia (ou a rede).
        registrarEvento('video_remoto_parado', 'aviso', {
          bytes_chegando: bytes > anterior.recebido.bytes,
          enviando_daqui: enviados > anterior.enviado.quadros,
          ...rota
        });
      }
    } else {
      if (info.videoParado) {
        registrarEvento('video_remoto_voltou', 'info', {
          segundos_parado: Math.round((Date.now() - info.videoParadoDesde) / 1000)
        });
        definirAviso(peerId, 'video', null);
      }
      info.videoParado = false;
      info.checagensSemQuadro = 0;
    }
  }

  if (amostrar && amostras.length) {
    ultimaAmostraDeQualidade = Date.now();
    registrarEvento('qualidade_da_chamada', 'info', {
      pares: amostras,
      cpu: pressaoDaCpu,
      pior_cpu: piorPressaoDaCpu,
      aba: document.visibilityState,
      gravando: isRecording
    });
    piorPressaoDaCpu = pressaoDaCpu;
  }
}

function papelDe(peerId) {
  return (peerRotulos.get(peerId) || 'participante').toLowerCase();
}

// O que sai e o que chega de vídeo nesta conexão, e o que a câmera entrega.
async function lerEstatisticas(pc) {
  const stats = await pc.getStats();
  const medidas = {
    em: Date.now(),
    recebido: { quadros: null, bytes: 0, fps: null, largura: null, altura: null },
    enviado: { quadros: 0, bytes: 0, fps: null, largura: null, altura: null, limitacao: null, codificador: null, pela_placa: null },
    camera: { fps: null, largura: null, altura: null }
  };
  stats.forEach(r => {
    const tipo = r.kind || r.mediaType;
    if (tipo !== 'video') return;
    if (r.type === 'inbound-rtp') {
      medidas.recebido.quadros = (medidas.recebido.quadros || 0) + (r.framesDecoded || 0);
      medidas.recebido.bytes += r.bytesReceived || 0;
      medidas.recebido.fps = r.framesPerSecond ?? medidas.recebido.fps;
      medidas.recebido.largura = r.frameWidth ?? medidas.recebido.largura;
      medidas.recebido.altura = r.frameHeight ?? medidas.recebido.altura;
    } else if (r.type === 'outbound-rtp') {
      medidas.enviado.quadros += r.framesEncoded || 0;
      medidas.enviado.bytes += r.bytesSent || 0;
      medidas.enviado.fps = r.framesPerSecond ?? medidas.enviado.fps;
      medidas.enviado.largura = r.frameWidth ?? medidas.enviado.largura;
      medidas.enviado.altura = r.frameHeight ?? medidas.enviado.altura;
      // "cpu": o navegador reduziu o vídeo porque o computador não dá conta;
      // "bandwidth": porque a rede não dá conta.
      medidas.enviado.limitacao = r.qualityLimitationReason ?? medidas.enviado.limitacao;
      medidas.enviado.codificador = r.encoderImplementation ?? medidas.enviado.codificador;
      if (typeof r.powerEfficientEncoder === 'boolean') medidas.enviado.pela_placa = r.powerEfficientEncoder;
    } else if (r.type === 'media-source') {
      medidas.camera.fps = r.framesPerSecond ?? medidas.camera.fps;
      medidas.camera.largura = r.width ?? medidas.camera.largura;
      medidas.camera.altura = r.height ?? medidas.camera.altura;
    }
  });
  return medidas;
}

function resumirMedidas(medidas, anterior) {
  const segundos = anterior ? (medidas.em - anterior.em) / 1000 : 0;
  const kbps = (agora, antes) => (segundos > 0 ? Math.round(((agora - antes) * 8) / segundos / 1000) : null);
  const { quadros, bytes, ...envio } = medidas.enviado;
  return {
    envio: { ...envio, kbps: anterior ? kbps(bytes, anterior.enviado.bytes) : null },
    recebimento: {
      fps: medidas.recebido.fps,
      largura: medidas.recebido.largura,
      altura: medidas.recebido.altura,
      kbps: anterior ? kbps(medidas.recebido.bytes, anterior.recebido.bytes) : null
    },
    camera: medidas.camera
  };
}

// O lado que para de enviar é o único que sabe por quê. Antes só o outro
// lado registrava "o vídeo não está chegando", sem dizer se faltou câmera,
// processador ou rede.
function vigiarEnvio(peerId, pc, info, medidas, anterior) {
  const video = localStream && localStream.getVideoTracks()[0];
  const parado = !isVideoMuted && !!video && video.readyState === 'live' && medidas.enviado.quadros === anterior.enviado.quadros;

  if (parado) {
    info.checagensSemEnviar = (info.checagensSemEnviar || 0) + 1;
    if (info.checagensSemEnviar === 2 && !info.envioParado) {
      info.envioParado = true;
      info.envioParadoDesde = Date.now();
      descreverRota(pc).then(rota => registrarEvento('video_local_parado', 'aviso', {
        par: papelDe(peerId),
        bytes_saindo: medidas.enviado.bytes > anterior.enviado.bytes,
        limitacao: medidas.enviado.limitacao,
        codificador: medidas.enviado.codificador,
        pela_placa: medidas.enviado.pela_placa,
        camera: { ...medidas.camera, sem_imagem: video.muted },
        cpu: pressaoDaCpu,
        aba: document.visibilityState,
        gravando: isRecording,
        ...rota
      }));
    }
    return;
  }

  if (info.envioParado) {
    registrarEvento('video_local_voltou', 'info', {
      par: papelDe(peerId),
      segundos_parado: Math.round((Date.now() - info.envioParadoDesde) / 1000),
      limitacao: medidas.enviado.limitacao,
      cpu: pressaoDaCpu
    });
  }
  info.envioParado = false;
  info.checagensSemEnviar = 0;
}

function observarPressaoDaCpu() {
  if (typeof PressureObserver === 'undefined') return;
  try {
    const observador = new PressureObserver((registros) => {
      const ultimo = registros[registros.length - 1];
      if (!ultimo) return;
      pressaoDaCpu = ultimo.state;
      if (ORDEM_DA_PRESSAO.indexOf(pressaoDaCpu) > ORDEM_DA_PRESSAO.indexOf(piorPressaoDaCpu)) {
        piorPressaoDaCpu = pressaoDaCpu;
      }
    });
    // Num iframe de outro domínio só funciona se a página que embute liberar
    // "compute-pressure"; sem isso a promessa é recusada e seguimos sem.
    observador.observe('cpu', { sampleInterval: 2000 }).catch(() => {});
  } catch (e) {
    // Navegador sem suporte: as amostras saem com cpu nula.
  }
}

function handlePeerLeft(peerId) {
  if (peerTiles.has(peerId)) {
    adicionarEventoChat((peerRotulos.get(peerId) || 'Participante') + ' saiu da chamada');
  }
  const rotulo = peerRotulos.get(peerId) || 'O participante';
  peerRotulos.delete(peerId);
  estadoMidiaDosPares.delete(peerId);
  candidatosAntecipados.delete(peerId);
  desligarAudioDaGravacao(peerId);
  removeTile(peerId);
  fecharPar(peerId);
  showStatus('Um participante saiu', 'info');

  // Sobrou sozinho na sala: encerra de verdade em vez de deixar a chamada
  // pendurada. Passa pelo hangup() para que a gravação seja finalizada e
  // enviada antes de avisar a página que embute o GoCall — quem grava é o
  // intérprete, então sair pela porta dos fundos custaria o vídeo.
  if (isEmbedMode && window.parent !== window && peerConnections.size === 0 && (currentRoom || salaParaVoltar)) {
    esperarAntesDeEncerrar(rotulo);
  }
}

function esperarAntesDeEncerrar(rotulo) {
  if (relogioSozinho) return;
  showStatus(`${rotulo} saiu da chamada. Aguardando a volta...`, 'info');
  relogioSozinho = setTimeout(() => {
    relogioSozinho = null;
    if (peerConnections.size === 0) hangup('peer_disconnected');
  }, ESPERA_PELA_VOLTA_MS);
}

function cancelarEsperaSozinho() {
  if (relogioSozinho) clearTimeout(relogioSozinho);
  relogioSozinho = null;
}

function toggleAudio() {
  if (!localStream) return;
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks()[0].enabled = !isAudioMuted;
  muteBtn.classList.toggle('off', isAudioMuted);
  atualizarBotaoAlternavel(muteBtn, {
    icone: isAudioMuted ? '🔇' : '🎤',
    rotulo: isAudioMuted ? 'Ligar o microfone' : 'Desligar o microfone',
    ativo: isAudioMuted,
  });
  showStatus(isAudioMuted ? 'Microfone desligado' : 'Microfone ligado', 'info');
  anunciarEstadoDaMidia();
}

function toggleVideo() {
  if (!localStream) return;
  isVideoMuted = !isVideoMuted;
  localStream.getVideoTracks()[0].enabled = !isVideoMuted;
  videoBtn.classList.toggle('off', isVideoMuted);
  atualizarBotaoAlternavel(videoBtn, {
    icone: isVideoMuted ? '🚫' : '📹',
    rotulo: isVideoMuted ? 'Ligar a câmera' : 'Desligar a câmera',
    ativo: isVideoMuted,
  });
  // Para quem se comunica em sinais, desligar a câmera encerra a conversa —
  // o aviso precisa ser explícito.
  showStatus(isVideoMuted ? 'Câmera desligada — o intérprete não vê seus sinais' : 'Câmera ligada', 'info');
  anunciarEstadoDaMidia();
}

// ── Gravação ────────────────────────────────────────────────────────────

// Sem um gesto na página o navegador pode deixar o AudioContext suspenso, e o
// resume() fica pendurado em vez de falhar — a gravação nem começava. Espera
// um pouco e segue: o vídeo é o que mais importa, e o áudio entra no
// primeiro toque (ver liberarSom).
async function retomarAudio(contexto) {
  if (contexto.state === 'running') return;
  await Promise.race([
    contexto.resume().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]);
  if (contexto.state !== 'running') registrarEvento('gravacao_audio_suspenso', 'aviso', {});
}

// O áudio de quem entra depois do início da gravação também precisa entrar
// na mistura. Antes só valiam os participantes presentes no startRecording —
// e o intérprete, que entra primeiro, começa a gravar sozinho.
function ligarAudioNaGravacao(peerId, stream) {
  if (!recordingAudioContext || !destinoDeAudioDaGravacao) return;
  if (!stream || !stream.getAudioTracks().length) return;
  desligarAudioDaGravacao(peerId);
  try {
    const fonte = recordingAudioContext.createMediaStreamSource(stream);
    fonte.connect(destinoDeAudioDaGravacao);
    fontesDeAudioDaGravacao.set(peerId, fonte);
  } catch (e) {
    registrarEvento('gravacao_sem_audio_do_par', 'aviso', { mensagem: String(e.message).slice(0, 200) });
  }
}

function desligarAudioDaGravacao(peerId) {
  const fonte = fontesDeAudioDaGravacao.get(peerId);
  if (!fonte) return;
  try { fonte.disconnect(); } catch (e) {}
  fontesDeAudioDaGravacao.delete(peerId);
}

function desenharQuadroDaGravacao() {
  if (!isRecording || !recordingContext) return;

  recordingContext.fillStyle = '#1a1a2e';
  recordingContext.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
  const tiles = Array.from(peerTiles.values());
  const totalTiles = tiles.length;
  let desenhouVideo = false;

  if (totalTiles > 0) {
    let cols, rows;
    if (totalTiles === 1) { cols = 1; rows = 1; }
    else if (totalTiles === 2) { cols = 2; rows = 1; }
    else if (totalTiles <= 4) { cols = 2; rows = 2; }
    else { cols = 3; rows = 2; }
    const tileWidth = recordingCanvas.width / cols;
    const tileHeight = recordingCanvas.height / rows;
    tiles.forEach((tile, index) => {
      const video = tile.querySelector('video');
      if (video && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = col * tileWidth;
        const y = row * tileHeight;

        try {
          desenharVideoEncaixado(recordingContext, video, x, y, tileWidth, tileHeight);
          desenhouVideo = true;
          const label = tile.querySelector('.tile-label');
          if (label) {
            recordingContext.fillStyle = 'rgba(0, 0, 0, 0.7)';
            recordingContext.fillRect(x + 10, y + tileHeight - 40, 150, 30);
            recordingContext.fillStyle = '#ffffff';
            recordingContext.font = '18px Arial';
            recordingContext.fillText(label.textContent, x + 20, y + tileHeight - 18);
          }
        } catch (e) {
        }
      }
    });
  }
  const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  recordingContext.fillStyle = 'rgba(220, 53, 69, 0.8)';
  recordingContext.fillRect(10, 10, 100, 40);
  recordingContext.fillStyle = '#ffffff';
  recordingContext.font = 'bold 20px Arial';
  recordingContext.fillText(`⏺ ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`, 20, 35);

  if (estatisticasDaGravacao) {
    estatisticasDaGravacao.quadros_desenhados++;
    if (desenhouVideo) estatisticasDaGravacao.quadros_com_video++;
  }
}

// Avisa enquanto ainda grava, sem esperar o arquivo: dez segundos sem nenhum
// quadro de vídeo desenhado é gravação que vai sair só com áudio.
function iniciarVigiaDaGravacao() {
  pararVigiaDaGravacao();
  let ultimoComVideo = -1;
  let semVideoDesde = null;
  let avisado = false;

  relogioVigiaGravacao = setInterval(() => {
    if (!isRecording || !estatisticasDaGravacao) return;
    const comVideo = estatisticasDaGravacao.quadros_com_video;

    if (comVideo === ultimoComVideo) {
      semVideoDesde = semVideoDesde || Date.now();
      if (!avisado && Date.now() - semVideoDesde >= 10000) {
        avisado = true;
        registrarEvento('gravacao_sem_video', 'aviso', {
          aba_oculta: document.hidden,
          quadros_desenhados: estatisticasDaGravacao.quadros_desenhados,
          participantes: peerTiles.size
        });
      }
    } else {
      if (avisado) {
        registrarEvento('gravacao_video_voltou', 'info', {
          segundos_sem_video: Math.round((Date.now() - semVideoDesde) / 1000)
        });
      }
      semVideoDesde = null;
      avisado = false;
    }
    ultimoComVideo = comVideo;
  }, 5000);
}

function pararVigiaDaGravacao() {
  if (relogioVigiaGravacao) clearInterval(relogioVigiaGravacao);
  relogioVigiaGravacao = null;
}

function finalizarEstatisticasDaGravacao() {
  const e = estatisticasDaGravacao;
  if (!e) return;
  if (e.oculta_desde) e.ms_oculta += Date.now() - e.oculta_desde;
  delete e.oculta_desde;
  e.duracao_ms = Date.now() - recordingStartTime;
}

function pararRecursosDaGravacao() {
  if (pararRelogioDeQuadros) {
    pararRelogioDeQuadros();
    pararRelogioDeQuadros = null;
  }
  pararVigiaDaGravacao();
  for (const peerId of Array.from(fontesDeAudioDaGravacao.keys())) desligarAudioDaGravacao(peerId);
  destinoDeAudioDaGravacao = null;
  if (recordingAudioContext) {
    recordingAudioContext.close().catch(() => {});
    recordingAudioContext = null;
  }
}

async function startRecording() {
  // Já gravando: acontece quando a conexão com o servidor cai e volta, e o
  // enterRoom passa de novo por aqui. A gravação em curso segue a mesma.
  if (isRecording || mediaRecorder) return;

  if (!localStream) {
    showStatus('Não há stream para gravar', 'error');
    return;
  }

  if (roomIsRecording) {
    showStatus('Outra pessoa já está gravando a reunião', 'error');
    return;
  }

  try {
    recordedChunks = [];
    salaDaGravacao = currentRoom;
    gravacaoId = novoIdDeGravacao();
    proximoPedaco = 0;
    pedacosParaEnviar.length = 0;
    envioDaGravacaoRecusado = false;
    gravacaoFinalizada = false;
    envioAtrasado = false;
    ultimoErroDoEnvio = null;
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = GRAVACAO_LARGURA;
    recordingCanvas.height = GRAVACAO_ALTURA;
    recordingContext = recordingCanvas.getContext('2d', { willReadFrequently: true });
    recordingAudioContext = new AudioContext();
    await retomarAudio(recordingAudioContext);

    // Encerraram enquanto o áudio era liberado: não começa uma gravação que
    // ninguém vai parar.
    if (encerrando || !currentRoom) {
      pararRecursosDaGravacao();
      return;
    }

    destinoDeAudioDaGravacao = recordingAudioContext.createMediaStreamDestination();
    ligarAudioNaGravacao(TILE_LOCAL, localStream);
    for (const [peerId, tile] of peerTiles) {
      if (peerId === TILE_LOCAL) continue;
      const video = tile.querySelector('video');
      if (video && video.srcObject) ligarAudioNaGravacao(peerId, video.srcObject);
    }

    estatisticasDaGravacao = {
      quadros_desenhados: 0,
      quadros_com_video: 0,
      ms_oculta: 0,
      vezes_oculta: 0,
      oculta_desde: document.hidden ? Date.now() : null,
      tipo_mime: null,
      relogio: 'worker'
    };

    recordingStartTime = Date.now();
    isRecording = true;
    roomIsRecording = true;
    desenharQuadroDaGravacao();
    pararRelogioDeQuadros = criarRelogioDeQuadros(GRAVACAO_FPS, desenharQuadroDaGravacao, () => {
      if (estatisticasDaGravacao) estatisticasDaGravacao.relogio = 'setInterval';
    });

    const canvasStream = recordingCanvas.captureStream(GRAVACAO_FPS);
    const videoTrack = canvasStream.getVideoTracks()[0];
    const audioTracks = destinoDeAudioDaGravacao.stream.getAudioTracks();
    const recordStream = new MediaStream([videoTrack, ...audioTracks]);
    const formato = escolherFormatoDeGravacao();

    // Antes isto rodava dentro de um setTimeout, fora do try: um formato não
    // suportado estourava sem ninguém ver, e a chamada seguia sem gravação.
    const recorder = new MediaRecorder(recordStream, {
      ...(formato ? { mimeType: formato } : {}),
      videoBitsPerSecond: GRAVACAO_BITS_VIDEO,
      audioBitsPerSecond: GRAVACAO_BITS_AUDIO
    });
    mediaRecorder = recorder;
    estatisticasDaGravacao.tipo_mime = recorder.mimeType || formato || null;

    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      // Fora do iLibras o arquivo ainda é baixado no fim, então guarda tudo;
      // dentro dele, cada pedaço vai embora assim que o servidor confirma.
      if (!isEmbedMode) recordedChunks.push(event.data);
      guardarPedacoDaGravacao(event.data);
    };

    recorder.onerror = (event) => {
      const erro = event.error || {};
      registrarEvento('gravacao_erro', 'erro', {
        erro: erro.name || null,
        mensagem: String(erro.message || '').slice(0, 300),
        tipo_mime: recorder.mimeType
      });
    };

    recorder.onstop = async () => {
      finalizarEstatisticasDaGravacao();
      pararRecursosDaGravacao();
      sendMessage({ type: 'recording-stopped', recorderId: myId });
      roomIsRecording = false;
      const mimeType = recorder.mimeType || 'video/mp4';
      showStatus('Gravação finalizada. Enviando o final do vídeo, não feche esta janela...', 'info');
      await concluirEnvioDaGravacao(mimeType);
      recordingCanvas = null;
      recordingContext = null;
      mediaRecorder = null;
    };

    recorder.start(GRAVACAO_PEDACO_MS);
    sendMessage({ type: 'recording-started', recorderId: myId });
    registrarEvento('gravacao_iniciada', 'info', { tipo_mime: estatisticasDaGravacao.tipo_mime });
    iniciarVigiaDaGravacao();

    showStatus('Gravando todos os participantes...', 'success');
  } catch (error) {
    registrarEvento('gravacao_nao_iniciou', 'erro', {
      erro: error && error.name,
      mensagem: String((error && error.message) || '').slice(0, 300)
    });
    showStatus('Erro ao iniciar gravação: ' + error.message, 'error');
    isRecording = false;
    roomIsRecording = false;
    mediaRecorder = null;
    estatisticasDaGravacao = null;
    pararRecursosDaGravacao();
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording && mediaRecorder.state !== 'inactive') {
    isRecording = false;
    mediaRecorder.stop();
    return;
  }

  // Sem MediaRecorder ativo (não chegou a nascer, ou parou sozinho por erro)
  // não há upload a esperar — e o hangup não pode ficar preso esperando um,
  // senão o intérprete fica travado na tela do atendimento.
  isRecording = false;
  pararRecursosDaGravacao();
  // O gravador que parou sozinho já mandou o que tinha; se o fim do envio
  // ainda está em curso, é ele quem responde quando terminar.
  if (recordingUploadResolve && !isUploadingRecording) {
    recordingUploadResolve(lastRecordingResult);
    recordingUploadResolve = null;
  }
}

function novoIdDeGravacao() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function esperarMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Vão junto de cada pedaço: se a aba fechar no meio, o servidor fecha a
// gravação sem o aviso final e ainda sabe o que o navegador viu até ali.
function estatisticasParaEnvio() {
  const e = estatisticasDaGravacao;
  if (!e) return '{}';
  const copia = { ...e, duracao_ms: e.duracao_ms || (Date.now() - recordingStartTime) };
  delete copia.oculta_desde;
  return JSON.stringify(copia);
}

function guardarPedacoDaGravacao(blob) {
  if (envioDaGravacaoRecusado) return;
  pedacosParaEnviar.push({
    id: gravacaoId,
    sala: salaDaGravacao || currentRoom,
    seq: proximoPedaco++,
    blob,
    estatisticas: estatisticasParaEnvio()
  });
  vigiarAtrasoDoEnvio();
  enviarPedacosDaGravacao();
}

function bytesPendentesDaGravacao() {
  return pedacosParaEnviar.reduce((soma, pedaco) => soma + pedaco.blob.size, 0);
}

// Seis pedaços na fila são 30 segundos de atraso: internet lenta ou caída do
// lado do intérprete. Fica registrado uma vez, e de novo quando zera.
function vigiarAtrasoDoEnvio() {
  const pendentes = pedacosParaEnviar.length;
  if (!envioAtrasado && pendentes >= 6) {
    envioAtrasado = true;
    registrarEvento('gravacao_envio_atrasado', 'aviso', {
      pendentes,
      bytes_pendentes: bytesPendentesDaGravacao(),
      erro: ultimoErroDoEnvio
    });
  } else if (envioAtrasado && pendentes <= 1) {
    envioAtrasado = false;
    registrarEvento('gravacao_envio_em_dia', 'info', {});
  }
}

// Depois do "Encerrar" o iLibras mostra quanto falta e só desiste de esperar
// se o envio parar de andar.
function avisarProgressoDoEnvio() {
  if (!encerrando || window.parent === window) return;
  window.parent.postMessage({
    type: 'webrtc-gravacao-progresso',
    pendentes: pedacosParaEnviar.length,
    bytes_pendentes: bytesPendentesDaGravacao()
  }, '*');
}

async function enviarPedacoDaGravacao(pedaco) {
  const formulario = new FormData();
  // Campos antes do arquivo: o multer só conhece os que vieram antes dele.
  formulario.append('id', pedaco.id);
  formulario.append('sala', pedaco.sala);
  formulario.append('papel', papelNaChamada);
  formulario.append('seq', String(pedaco.seq));
  formulario.append('tipo_mime', pedaco.blob.type || '');
  formulario.append('estatisticas', pedaco.estatisticas);
  formulario.append('pedaco', pedaco.blob, `${pedaco.seq}.parte`);

  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 120000);
  try {
    const resposta = await fetch('/api/gravacao/pedaco', { method: 'POST', body: formulario, signal: controle.signal });
    if (resposta.ok) return { ok: true };
    // Recusa do nginx chega em HTML, não JSON.
    const corpo = await resposta.json().catch(() => ({}));
    // 4xx não melhora repetindo (gravação já fechada, grande demais). 5xx e o
    // 502 do nginx durante um reinício do servidor, sim.
    const definitivo = resposta.status >= 400 && resposta.status < 500 && ![408, 429].includes(resposta.status);
    return { ok: false, definitivo, erro: `HTTP ${resposta.status}${corpo.error ? ': ' + corpo.error : ''}` };
  } catch (erro) {
    return { ok: false, definitivo: false, erro: erro.name === 'AbortError' ? 'tempo_esgotado' : erro.message };
  } finally {
    clearTimeout(limite);
  }
}

// Um pedaço por vez e em ordem: o servidor só aceita o começo de uma gravação
// pelo pedaço 0, que traz o cabeçalho do vídeo.
async function enviarPedacosDaGravacao() {
  if (enviandoPedacos) return;
  enviandoPedacos = true;
  let falhasSeguidas = 0;

  try {
    while (pedacosParaEnviar.length && !envioDaGravacaoRecusado) {
      const resultado = await enviarPedacoDaGravacao(pedacosParaEnviar[0]);

      if (resultado.ok) {
        pedacosParaEnviar.shift();
        falhasSeguidas = 0;
        avisarProgressoDoEnvio();
      } else if (resultado.definitivo) {
        envioDaGravacaoRecusado = true;
        ultimoErroDoEnvio = String(resultado.erro).slice(0, 300);
        registrarEvento('gravacao_envio_falhou', 'erro', {
          erro: ultimoErroDoEnvio,
          seq: pedacosParaEnviar[0].seq,
          pedacos_perdidos: pedacosParaEnviar.length,
          tipo_mime: pedacosParaEnviar[0].blob.type || null
        });
        pedacosParaEnviar.length = 0;
      } else {
        // O pedaço só existe aqui: espera e tenta de novo, sem desistir,
        // enquanto a página estiver aberta.
        ultimoErroDoEnvio = String(resultado.erro).slice(0, 300);
        falhasSeguidas++;
        vigiarAtrasoDoEnvio();
        await esperarMs(Math.min(30000, 2000 * 2 ** Math.min(falhasSeguidas - 1, 4)));
      }
      vigiarAtrasoDoEnvio();
    }
  } finally {
    enviandoPedacos = false;
  }

  if (!pedacosParaEnviar.length && aoEsvaziarFilaDePedacos) {
    const avisar = aoEsvaziarFilaDePedacos;
    aoEsvaziarFilaDePedacos = null;
    avisar();
  }
}

function baixarGravacao(blob, mimeType) {
  const extension = mimeType && mimeType.includes('webm') ? 'webm' : 'mp4';
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `recording_${salaDaGravacao || currentRoom}_${Date.now()}.${extension}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

// Depois do stop: espera só o que ainda está na fila (normalmente o último
// pedaço) e avisa o servidor que acabou. O servidor monta o vídeo e segue com
// a conversão e o S3 sem ninguém esperando.
async function concluirEnvioDaGravacao(mimeType) {
  isUploadingRecording = true;
  const id = gravacaoId;
  const total = proximoPedaco;

  try {
    if (pedacosParaEnviar.length || enviandoPedacos) {
      avisarProgressoDoEnvio();
      await new Promise((resolve) => {
        aoEsvaziarFilaDePedacos = resolve;
        enviarPedacosDaGravacao();
      });
    }

    const enviada = !envioDaGravacaoRecusado && total > 0;
    if (enviada) {
      let avisada = false;
      for (let tentativa = 1; tentativa <= 3 && !avisada; tentativa++) {
        try {
          const resposta = await fetch('/api/gravacao/finalizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, total, estatisticas: estatisticasDaGravacao || {} })
          });
          avisada = resposta.ok;
        } catch (e) {}
        if (!avisada && tentativa < 3) await esperarMs(2000 * tentativa);
      }
      // Sem esse aviso o servidor fecha a gravação sozinho depois de alguns
      // minutos sem pedaço novo: o vídeo sai do mesmo jeito, só mais tarde.
    }
    gravacaoFinalizada = true;

    if (enviada) {
      showStatus('Gravação recebida. Processamento continua em segundo plano.', 'success');
      if (!isEmbedMode && recordedChunks.length) baixarGravacao(new Blob(recordedChunks, { type: mimeType }), mimeType);
      lastRecordingResult = { url: null, key: null, enviada: true };
    } else {
      showStatus('Erro ao enviar gravação: ' + (ultimoErroDoEnvio || 'nada foi gravado'), 'error');
      lastRecordingResult = null;
    }

    if (recordingUploadResolve) {
      recordingUploadResolve(lastRecordingResult);
      recordingUploadResolve = null;
    }
  } finally {
    isUploadingRecording = false;
    recordedChunks = [];
  }
}

// A página está indo embora com a gravação aberta (aba fechada, F5, tela do
// atendimento desmontada): o que já chegou ao servidor vira o vídeo agora,
// em vez de esperar a inatividade. O sendBeacon é o único envio que
// sobrevive à saída; vai como texto para não depender de preflight.
function fecharGravacaoAoSair() {
  if (!gravacaoId || gravacaoFinalizada || proximoPedaco === 0 || !navigator.sendBeacon) return;
  gravacaoFinalizada = true;
  try {
    navigator.sendBeacon('/api/gravacao/finalizar', new Blob([JSON.stringify({
      id: gravacaoId,
      motivo: 'pagina_fechada',
      estatisticas: JSON.parse(estatisticasParaEnvio())
    })], { type: 'text/plain' }));
  } catch (e) {}
}

document.addEventListener('visibilitychange', () => {
  if (currentRoom) registrarEvento(document.hidden ? 'aba_oculta' : 'aba_visivel', 'info', { gravando: isRecording });

  const e = estatisticasDaGravacao;
  if (!e || !isRecording) return;
  if (document.hidden) {
    e.oculta_desde = Date.now();
    e.vezes_oculta++;
  } else if (e.oculta_desde) {
    e.ms_oculta += Date.now() - e.oculta_desde;
    e.oculta_desde = null;
  }
});

// Ordens da página que embute o GoCall. O botão de encerrar saiu daqui e
// virou "Encerrar Atendimento" no iLibras_v2: é de lá que o pedido chega,
// e é por isso que a gravação passa a ser finalizada em todo encerramento.
// Só aceita do próprio pai — qualquer outra janela é ignorada.
window.addEventListener('message', (evento) => {
  if (!isEmbedMode || window.parent === window) return;
  if (evento.source !== window.parent) return;
  const tipo = evento.data && evento.data.type;

  if (tipo === 'ilibras-encerrar-chamada') {
    salaEncerrada = true;
    hangup('encerrado_pelo_interprete', { encerrarSala: true });
  } else if (tipo === 'ilibras-sair-da-chamada') {
    // "Remover Intérprete": o iLibras desmontava a chamada sem avisar e a
    // gravação até ali se perdia. Agora ela é finalizada e enviada, e a
    // sala continua aberta para o próximo intérprete.
    salaEncerrada = true;
    hangup('interprete_removido');
  }
});

window.addEventListener('pagehide', () => {
  paginaSaindo = true;
  fecharGravacaoAoSair();
});

window.addEventListener('beforeunload', (e) => {
  if (!isUploadingRecording) return;
  e.preventDefault();
  e.returnValue = '';
});

if (isEmbedMode) {
  document.body.style.background = 'transparent';
  if (lobbyEl) lobbyEl.style.display = 'none';
}

async function hangup(motivo = 'manual', { encerrarSala = false } = {}) {
  if (encerrando) return;
  encerrando = true;
  cancelarEsperaSozinho();
  pararMonitor();

  // Derruba a sala ANTES de esperar a gravação. O upload é do intérprete e
  // pode levar minutos; o surdo e o suporte não podem seguir numa chamada
  // que já foi encerrada só porque o vídeo ainda está subindo.
  if (encerrarSala && currentRoom) {
    sendMessage({ type: 'end-call' });
  }
  registrarEvento('saiu', 'info', { motivo, gravando: isRecording });

  let recordingResult = null;
  const gravou = isRecording || gravacaoId !== null;

  if (isRecording) {
    showStatus('Enviando gravação, não feche esta janela...', 'info');
    recordingResult = await new Promise((resolve) => {
      recordingUploadResolve = resolve;
      stopRecording();
    });
  } else {
    recordingResult = lastRecordingResult;
  }

  pararRecursosDaGravacao();
  isRecording = false;
  roomIsRecording = false;
  lastRecordingResult = null;

  isAudioMuted = false;
  isVideoMuted = false;
  muteBtn.classList.remove('off');
  atualizarBotaoAlternavel(muteBtn, { icone: '🎤', rotulo: 'Desligar o microfone', ativo: false });
  videoBtn.classList.remove('off');
  atualizarBotaoAlternavel(videoBtn, { icone: '📹', rotulo: 'Desligar a câmera', ativo: false });

  for (const peerId of Array.from(peerConnections.keys())) fecharPar(peerId);
  candidatosAntecipados.clear();
  estadoMidiaDosPares.clear();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  videosGrid.innerHTML = '';
  peerTiles.clear();
  updateGridCount();
  sendMessage({ type: 'leave-room' });
  currentRoom = null;
  salaParaVoltar = null;
  roomEl.classList.add('hidden');

  // Avisa a página que embute o GoCall mesmo fora do modo embed: é por este
  // aviso que a tela do surdo troca a chamada pela avaliação na hora, em vez
  // de esperar o intérprete terminar de preencher o feedback do outro lado.
  if (window.parent !== window) {
    window.parent.postMessage({
      type: 'webrtc-hangup',
      reason: motivo,
      recording_url: recordingResult ? recordingResult.url : null,
      recording_key: recordingResult ? recordingResult.key : null,
      // Só faz sentido para quem gravava: diz ao iLibras se o vídeo chegou
      // ao servidor, para ele não afirmar que sim quando não chegou.
      gravacao_enviada: gravou ? Boolean(recordingResult && recordingResult.enviada) : null
    }, '*');
  }

  // No embed quem cuida da tela é o pai; fora dele o GoCall ainda precisa
  // mostrar alguma coisa a quem ficou.
  if (isEmbedMode && window.parent !== window) {
    encerrando = false;
    return;
  }

  if (salaEncerrada) {
    mostrarTelaEncerrada();
  } else {
    lobbyEl.classList.remove('hidden');
    showLobbyStatus('Você saiu da sala', 'info');
  }
  encerrando = false;
}

function mostrarTelaEncerrada(texto) {
  // Em modo embed quem dá a notícia é a página do iLibras: ela troca o iframe
  // pelo pedido de feedback (intérprete) ou devolve para a fila (suporte).
  if (isEmbedMode) return;
  if (texto && encerradaTexto) encerradaTexto.textContent = texto;
  roomEl.classList.add('hidden');
  lobbyEl.classList.add('hidden');
  if (encerradaEl) encerradaEl.classList.remove('hidden');
}

function showStatus(message, type) {
  statusElement.textContent = message;
  statusElement.style.background =
    type === 'success' ? '#d4edda' :
    type === 'error'   ? '#f8d7da' : '#d1ecf1';
  statusElement.style.color =
    type === 'success' ? '#155724' :
    type === 'error'   ? '#721c24' : '#0c5460';
}

function showLobbyStatus(message, type) {
  lobbyStatus.textContent = message;
  lobbyStatus.style.background =
    type === 'success' ? '#d4edda' :
    type === 'error'   ? '#f8d7da' : '#d1ecf1';
  lobbyStatus.style.color =
    type === 'success' ? '#155724' :
    type === 'error'   ? '#721c24' : '#0c5460';
}

joinBtn.disabled = true;
showLobbyStatus('Conectando ao servidor...', 'info');

joinBtn.addEventListener('click', joinRoom);
roomIdInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !joinBtn.disabled) joinRoom(); });
muteBtn.addEventListener('click', toggleAudio);
videoBtn.addEventListener('click', toggleVideo);
chatBtn.addEventListener('click', alternarChat);
chatFecharBtn.addEventListener('click', fecharChat);
chatForm.addEventListener('submit', enviarMensagemChat);
document.addEventListener('pointerdown', liberarSom);
document.addEventListener('keydown', liberarSom);

observarPressaoDaCpu();
connectWebSocket();
