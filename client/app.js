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
let recordingAnimationFrame = null;
let recordingAudioContext = null;
let roomIsRecording = false;
let lastRecordingResult = null;
let recordingUploadResolve = null;
let isUploadingRecording = false;

const peerConnections = new Map();

const peerTiles = new Map();

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

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
const recordBtn   = document.getElementById('recordBtn');
const hangupBtn   = document.getElementById('hangupBtn');
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


// Mesmo de-para que o servidor aplica ao 'papel' recebido no join-room. Aqui
// serve só para o próprio tile, que é desenhado antes do servidor responder.
function rotuloDoPapel(papel) {
  const mapa = { interprete: 'Intérprete', suporte: 'Suporte', surdo: 'Surdo' };
  return mapa[String(papel || '').toLowerCase()] || '';
}

function abrirChat() {
  chatAberto = true;
  chatEl.classList.remove('hidden');
  chatNaoLidas = 0;
  atualizarBadge();
  chatMensagens.scrollTop = chatMensagens.scrollHeight;
}

function fecharChat() {
  chatAberto = false;
  chatEl.classList.add('hidden');
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
  if (!texto || !currentRoom) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
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
  video.autoplay = true;
  video.playsinline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  if (isLocal) video.muted = true;
  if (isLocal) video.setAttribute('muted', '');

  const lbl = document.createElement('span');
  lbl.className = 'tile-label';
  lbl.textContent = label;

  tile.appendChild(avatar);
  tile.appendChild(video);
  tile.appendChild(lbl);

  videosGrid.appendChild(tile);
  updateGridCount();

  if (stream) {
    video.srcObject = stream;
    tile.classList.add('has-video');
    video.play().catch(() => {});
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
  video.srcObject = stream;
  tile.classList.add('has-video');
  video.play().catch(() => {});
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    showLobbyStatus('Conectado ao servidor', 'success');
    joinBtn.disabled = false;
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'init':
          myId = data.id;
          myIdElement.textContent = myId;
          // Auto-join quando o parâmetro ?room= está na URL (integração iLibras)
          const autoRoom = new URLSearchParams(window.location.search).get('room');
          if (autoRoom) {
            roomIdInput.value = autoRoom;
            joinRoom();
          }
          break;


        case 'room-joined':
          for (const [id, rotulo] of Object.entries(data.rotulos || {})) peerRotulos.set(id, rotulo);
          await enterRoom(data.room, data.peers.filter(id => id !== myId));
          break;

        case 'room-full':
          showLobbyStatus('Sala lotada (máximo 5 participantes)', 'error');
          currentRoom = null;
          break;

        case 'peer-joined':
          if (data.rotulo) peerRotulos.set(data.peerId, data.rotulo);
          showStatus(`Novo participante entrando...`, 'info');
          adicionarEventoChat((data.rotulo || 'Participante') + ' entrou na chamada');
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

        case 'chat':
          receberMensagemChat(data);
          break;

        case 'recording-started':
          if (data.recorderId !== myId) {
            roomIsRecording = true;
            recordBtn.disabled = true;
            recordBtn.style.opacity = '0.5';
            showStatus((peerRotulos.get(data.recorderId) || 'Outro participante') + ' está gravando...', 'info');
          }
          break;

        case 'recording-stopped':
          if (data.recorderId !== myId) {
            roomIsRecording = false;
            recordBtn.disabled = false;
            recordBtn.style.opacity = '1';
            showStatus('Gravação finalizada', 'info');
          }
          break;
      }
    } catch (error) {
    }
  };

  ws.onerror = (error) => {
    showLobbyStatus('Falha na conexão WebSocket', 'error');
    joinBtn.disabled = true;
  };

  ws.onclose = () => {
    showLobbyStatus('Desconectado do servidor. Reconectando...', 'error');
    joinBtn.disabled = true;

    if (currentRoom) {
      for (const [, pc] of peerConnections) pc.close();
      peerConnections.clear();
      peerTiles.clear();
      videosGrid.innerHTML = '';
      updateGridCount();
      currentRoom = null;
      isAudioMuted = false;
      isVideoMuted = false;
      muteBtn.classList.remove('off');
      muteBtn.textContent = '🎤';
      videoBtn.classList.remove('off');
      videoBtn.textContent = '📹';
      roomEl.classList.add('hidden');
      lobbyEl.classList.remove('hidden');
    }

    setTimeout(() => {
      connectWebSocket();
    }, 3000);
  };
}

async function joinRoom() {
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
    localStream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS, audio: true });
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
      return;
    }
  }

  await abrirAnguloMaximo(localStream);

  lobbyEl.classList.add('hidden');
  roomEl.classList.remove('hidden');
  videosGrid.innerHTML = '';
  peerTiles.clear();
  peerRotulos.clear();
  updateGridCount();
  const rotuloProprio = rotuloDoPapel(papelNaChamada);
  const localTile = createTile(myId, rotuloProprio ? 'Você (' + rotuloProprio + ')' : 'Você', localStream, true);
  peerTiles.set(myId, localTile);

  currentRoom = room;
  limparChat();
  sendMessage({ type: 'join-room', room, papel: papelNaChamada });
  showLobbyStatus('Entrando na sala...', 'info');
}

async function enterRoom(room, peers) {
  try {
    roomLabel.textContent = `Sala: ${room}`;
    showStatus(`${peers.length + 1} participante(s)`, 'success');
    for (const peerId of peers) {
      await startCallTo(peerId);
    }
    if (isInterpreter) {
      setTimeout(() => startRecording(), 1000);
    }
  } catch (error) {
    showLobbyStatus('Erro ao entrar na sala: ' + error.message, 'error');
  }
}

function createPeerConnection(peerId) {
  const existing = peerConnections.get(peerId);
  if (existing) {
    existing.close();
    peerConnections.delete(peerId);
  }

  const pc = new RTCPeerConnection(configuration);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    let tile = peerTiles.get(peerId);
    if (!tile) {
      tile = createTile(peerId, peerRotulos.get(peerId) || 'Participante', null, false);
      peerTiles.set(peerId, tile);
    }
    setTileStream(tile, event.streams[0]);
    showStatus('Chamada conectada', 'success');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({ type: 'ice-candidate', candidate: event.candidate, target: peerId });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      handlePeerLeft(peerId);
    }
  };

  peerConnections.set(peerId, pc);
  return pc;
}

async function startCallTo(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendMessage({ type: 'offer', offer, target: peerId });
}

async function handleOffer(data) {
  const peerId = data.from;
  const pc = createPeerConnection(peerId);
  await pc.setRemoteDescription(data.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendMessage({ type: 'answer', answer, target: peerId });
  showStatus('Chamada recebida', 'info');
}

async function handleAnswer(data) {
  const pc = peerConnections.get(data.from);
  if (pc) await pc.setRemoteDescription(data.answer);
}

async function handleIceCandidate(data) {
  const pc = peerConnections.get(data.from);
  if (pc) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (e) {

    }
  }
}

function handlePeerLeft(peerId) {
  if (peerTiles.has(peerId)) {
    adicionarEventoChat((peerRotulos.get(peerId) || 'Participante') + ' saiu da chamada');
  }
  peerRotulos.delete(peerId);
  removeTile(peerId);
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  showStatus('Um participante saiu', 'info');

  // Sobrou sozinho na sala: encerra de verdade em vez de deixar a chamada
  // pendurada. Passa pelo hangup() para que a gravação seja finalizada e
  // enviada antes de avisar a página que embute o GoCall — quem grava é o
  // intérprete, então sair pela porta dos fundos custaria o vídeo.
  if (isEmbedMode && window.parent !== window && peerConnections.size === 0) {
    hangup('peer_disconnected');
  }
}

function sendMessage(msg) {
  ws.send(JSON.stringify(msg));
}

function toggleAudio() {
  if (!localStream) return;
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks()[0].enabled = !isAudioMuted;
  muteBtn.classList.toggle('off', isAudioMuted);
  muteBtn.textContent = isAudioMuted ? '🔇' : '🎤';
}

function toggleVideo() {
  if (!localStream) return;
  isVideoMuted = !isVideoMuted;
  localStream.getVideoTracks()[0].enabled = !isVideoMuted;
  videoBtn.classList.toggle('off', isVideoMuted);
  videoBtn.textContent = isVideoMuted ? '🚫' : '📹';
}

function toggleRecording() {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
}

async function startRecording() {
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
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = 1920;
    recordingCanvas.height = 1080;
    recordingContext = recordingCanvas.getContext('2d', { willReadFrequently: true });
    recordingAudioContext = new AudioContext();
    await recordingAudioContext.resume();
    const mixedAudioDestination = recordingAudioContext.createMediaStreamDestination();
    const localAudioSource = recordingAudioContext.createMediaStreamSource(localStream);
    localAudioSource.connect(mixedAudioDestination);
    for (const [peerId, tile] of peerTiles) {
      if (peerId !== myId) {
        const video = tile.querySelector('video');
        if (video && video.srcObject) {
          try {
            const peerAudioSource = recordingAudioContext.createMediaStreamSource(video.srcObject);
            peerAudioSource.connect(mixedAudioDestination);
          } catch (e) {
          }
        }
      }
    }
    function drawVideosToCanvas() {
      if (!isRecording) return;
      recordingContext.fillStyle = '#1a1a2e';
      recordingContext.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
      const tiles = Array.from(peerTiles.values());
      const totalTiles = tiles.length;
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
          if (video && video.readyState >= video.HAVE_CURRENT_DATA && !video.paused) {
            const col = index % cols;
            const row = Math.floor(index / cols);
            const x = col * tileWidth;
            const y = row * tileHeight;
            
            try {
              // Encaixa o quadro na célula preservando a proporção. O
              // drawImage esticado deformava o vídeo (uma célula de 960x1080
              // recebendo um 16:9), e sinal deformado é sinal ilegível na
              // gravação, que é o registro do atendimento.
              const larguraFonte = video.videoWidth || 16;
              const alturaFonte  = video.videoHeight || 9;
              const escala = Math.min(tileWidth / larguraFonte, tileHeight / alturaFonte);
              const larguraDestino = larguraFonte * escala;
              const alturaDestino  = alturaFonte * escala;
              const xDestino = x + (tileWidth - larguraDestino) / 2;
              const yDestino = y + (tileHeight - alturaDestino) / 2;

              recordingContext.drawImage(video, xDestino, yDestino, larguraDestino, alturaDestino);
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
      recordingAnimationFrame = requestAnimationFrame(drawVideosToCanvas);
    }
    
    setTimeout(() => {
      drawVideosToCanvas();
      const canvasStream = recordingCanvas.captureStream(30);
      const videoTrack = canvasStream.getVideoTracks()[0];
      const audioTracks = mixedAudioDestination.stream.getAudioTracks();
      const recordStream = new MediaStream([videoTrack, ...audioTracks]);
      let mimeType = 'video/mp4';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/mp4;codecs=h264,aac';
      }
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm;codecs=vp9,opus';
      }
      mediaRecorder = new MediaRecorder(recordStream, {
        mimeType: mimeType,
        videoBitsPerSecond: 2500000,
        audioBitsPerSecond: 128000
      });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (recordingAnimationFrame) {
          cancelAnimationFrame(recordingAnimationFrame);
          recordingAnimationFrame = null;
        }
        if (recordingAudioContext) {
          recordingAudioContext.close();
          recordingAudioContext = null;
        }
        sendMessage({ type: 'recording-stopped', recorderId: myId });
        roomIsRecording = false;
        const mimeType = mediaRecorder.mimeType || 'video/mp4';
      const blob = new Blob(recordedChunks, { type: mimeType });
        const duration = Date.now() - recordingStartTime;
        showStatus(`Gravação finalizada (${Math.round(duration/1000)}s). Enviando vídeo, não feche esta janela...`, 'info');
        await uploadRecording(blob);
        recordingCanvas = null;
        recordingContext = null;
      };

      mediaRecorder.start(1000);
    }, 500);
    recordingStartTime = Date.now();
    isRecording = true;
    roomIsRecording = true;
    sendMessage({ type: 'recording-started', recorderId: myId });
    
    recordBtn.classList.add('recording');
    recordBtn.textContent = '⏹️';
    showStatus('Gravando todos os participantes...', 'success');
  } catch (error) {
    
    showStatus('Erro ao iniciar gravação: ' + error.message, 'error');
    if (recordingAnimationFrame) cancelAnimationFrame(recordingAnimationFrame);
    if (recordingAudioContext) recordingAudioContext.close();
    roomIsRecording = false;
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    isRecording = false;
    mediaRecorder.stop();
    recordBtn.classList.remove('recording');
    recordBtn.textContent = '⏺️';
  }
}

async function uploadRecording(blob) {
  isUploadingRecording = true;
  try {
    const formData = new FormData();
    const extension = mediaRecorder && mediaRecorder.mimeType && mediaRecorder.mimeType.includes('webm') ? 'webm' : 'mp4';
    formData.append('recording', blob, `recording_${Date.now()}.${extension}`);
    formData.append('roomId', currentRoom);
    formData.append('timestamp', Date.now());

    const response = await fetch('/api/upload-recording', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (response.ok) {
      // O servidor já respondeu ao receber o arquivo bruto — o processamento
      // (transcodificação + envio ao S3) continua em segundo plano no servidor
      // e o vídeo é anexado ao atendimento automaticamente quando terminar.
      lastRecordingResult = { url: result.url ?? null, key: result.key ?? null };
      showStatus('Gravação recebida. Processamento continua em segundo plano.', 'success');

      if (!isEmbedMode) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `recording_${currentRoom}_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }

      if (recordingUploadResolve) {
        recordingUploadResolve(lastRecordingResult);
        recordingUploadResolve = null;
      }
      return lastRecordingResult;
    } else {
      showStatus('Erro ao enviar gravação: ' + result.error, 'error');
      if (recordingUploadResolve) {
        recordingUploadResolve(null);
        recordingUploadResolve = null;
      }
      return null;
    }
  } catch (error) {
    showStatus('Erro ao enviar gravação: ' + error.message, 'error');
    if (recordingUploadResolve) {
      recordingUploadResolve(null);
      recordingUploadResolve = null;
    }
    return null;
  } finally {
    isUploadingRecording = false;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (!isUploadingRecording) return;
  e.preventDefault();
  e.returnValue = '';
});

const isEmbedMode = new URLSearchParams(window.location.search).get('mode') === 'embed';
const isInterpreter = new URLSearchParams(window.location.search).get('role') === 'interprete';
// O papel vira o rótulo que os outros veem. Sem role na URL o servidor devolve
// 'Participante', que ainda diz mais do que um pedaço do id.
const papelNaChamada = new URLSearchParams(window.location.search).get('role') || '';

if (isEmbedMode) {
  document.body.style.background = 'transparent';
  if (lobbyEl) lobbyEl.style.display = 'none';
  if (recordBtn) recordBtn.style.display = 'none';
}

async function hangup(motivo = 'manual') {
  let recordingResult = null;

  if (isRecording) {
    showStatus('Enviando gravação, não feche esta janela...', 'info');
    recordingResult = await new Promise((resolve) => {
      recordingUploadResolve = resolve;
      stopRecording();
    });
  } else {
    recordingResult = lastRecordingResult;
  }

  if (recordingAnimationFrame) {
    cancelAnimationFrame(recordingAnimationFrame);
    recordingAnimationFrame = null;
  }
  if (recordingAudioContext) {
    recordingAudioContext.close().catch(() => {});
    recordingAudioContext = null;
  }
  isRecording = false;
  roomIsRecording = false;
  lastRecordingResult = null;
  recordBtn.disabled = false;
  recordBtn.style.opacity = '1';
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '⏺️';

  isAudioMuted = false;
  isVideoMuted = false;
  muteBtn.classList.remove('off');
  muteBtn.textContent = '🎤';
  videoBtn.classList.remove('off');
  videoBtn.textContent = '📹';

  for (const [, pc] of peerConnections) pc.close();
  peerConnections.clear();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  videosGrid.innerHTML = '';
  peerTiles.clear();
  updateGridCount();
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMessage({ type: 'leave-room' });
  }
  currentRoom = null;
  roomEl.classList.add('hidden');

  if (isEmbedMode && window.parent !== window) {
    window.parent.postMessage({
      type: 'webrtc-hangup',
      reason: motivo,
      recording_url: recordingResult ? recordingResult.url : null,
      recording_key: recordingResult ? recordingResult.key : null
    }, '*');
    return;
  }

  lobbyEl.classList.remove('hidden');
  showLobbyStatus('Você saiu da sala', 'info');
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
recordBtn.addEventListener('click', toggleRecording);
// Envolvido numa arrow de propósito: passar hangup direto faria o objeto de
// evento do clique chegar como motivo.
hangupBtn.addEventListener('click', () => hangup('manual'));
chatBtn.addEventListener('click', alternarChat);
chatFecharBtn.addEventListener('click', fecharChat);
chatForm.addEventListener('submit', enviarMensagemChat);

connectWebSocket();