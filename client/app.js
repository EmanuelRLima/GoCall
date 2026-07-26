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
          await enterRoom(data.room, data.peers.filter(id => id !== myId));
          break;

        case 'room-full':
          showLobbyStatus('Sala lotada (máximo 5 participantes)', 'error');
          currentRoom = null;
          break;

        case 'peer-joined':
          showStatus(`Novo participante entrando...`, 'info');
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

        case 'recording-started':
          if (data.recorderId !== myId) {
            roomIsRecording = true;
            recordBtn.disabled = true;
            recordBtn.style.opacity = '0.5';
            showStatus(`${data.recorderId.substring(0, 6)} está gravando...`, 'info');
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
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (error) {
    showLobbyStatus('Falha ao acessar câmera/microfone', 'error');
    return;
  }

  lobbyEl.classList.add('hidden');
  roomEl.classList.remove('hidden');
  videosGrid.innerHTML = '';
  peerTiles.clear();
  updateGridCount();
  const localTile = createTile(myId, 'Você', localStream, true);
  peerTiles.set(myId, localTile);

  currentRoom = room;
  sendMessage({ type: 'join-room', room });
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
      tile = createTile(peerId, peerId.substring(0, 6), null, false);
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
  removeTile(peerId);
  const pc = peerConnections.get(peerId);
  if (pc) { pc.close(); peerConnections.delete(peerId); }
  showStatus('Um participante saiu', 'info');

  if (isEmbedMode && !isInterpreter && window.parent !== window && peerConnections.size === 0) {
    window.parent.postMessage({ type: 'webrtc-hangup', recording_url: null, reason: 'peer_disconnected' }, '*');
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
              recordingContext.drawImage(video, x, y, tileWidth, tileHeight);
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

if (isEmbedMode) {
  document.body.style.background = 'transparent';
  if (lobbyEl) lobbyEl.style.display = 'none';
  if (recordBtn) recordBtn.style.display = 'none';
}

async function hangup() {
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
hangupBtn.addEventListener('click', hangup);

connectWebSocket();