import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, unlink } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { montarServidoresIce, temTurn } from './ice.js';
import { analisarMidia, avaliarGravacao, conferirDecodificacao, converterGravacao } from './midia.js';
import { criarTelemetria, normalizarEventoDoCliente } from './telemetria.js';
import { criarGravacoesEmPedacos, idDeGravacaoValido } from './pedacos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const telemetria = criarTelemetria({
  url: process.env.ILIBRAS_WEBHOOK_URL,
  token: process.env.ILIBRAS_WEBHOOK_TOKEN,
});

if (!temTurn(montarServidoresIce())) {
  console.warn('Sem TURN configurado (TURN_URLS): quem estiver atrás de NAT restrito não vai conseguir trocar vídeo.');
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Sobrescreve o CSP restritivo que o ngrok injeta, permitindo fontes, imagens e mídia
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "media-src * blob: data:; " +
    "img-src * data: blob:; " +
    "font-src * data:; " +
    "connect-src * wss: ws:;"
  );
  next();
});

app.use(express.static(path.join(__dirname, '../client'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.json());

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Em disco, não na memória: a 2,5 Mbps a chamada passa de 500 MB por volta
// dos 25 minutos, e o arquivo inteiro num Buffer do Node era o teto. O nginx
// na frente tem o próprio limite (client_max_body_size) — os dois precisam
// andar juntos.
const GRAVACAO_MAX_MB = Number(process.env.GRAVACAO_MAX_MB) > 0 ? Number(process.env.GRAVACAO_MAX_MB) : 1500;

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (req, file, cb) => cb(null, `${randomUUID()}.gravacao`)
  }),
  limits: {
    fileSize: GRAVACAO_MAX_MB * 1024 * 1024
  }
});

// Pedaços da gravação, mandados durante a chamada (ver pedacos.js). Ficam fora
// do /tmp porque precisam sobreviver a um reinício do servidor no meio da
// chamada. Cinco segundos a 1,6 Mbps dão 1 MB; o limite é folga para
// navegador que grave com taxa maior.
const GRAVACAO_PASTA = process.env.GRAVACAO_DIR || path.join(__dirname, '..', 'gravacoes');
const GRAVACAO_INATIVIDADE_MIN = Number(process.env.GRAVACAO_INATIVIDADE_MIN) > 0 ? Number(process.env.GRAVACAO_INATIVIDADE_MIN) : 10;
const PEDACO_MAX_MB = 50;

const gravacoes = criarGravacoesEmPedacos({
  pasta: GRAVACAO_PASTA,
  inatividadeMs: GRAVACAO_INATIVIDADE_MIN * 60 * 1000,
  maxBytes: GRAVACAO_MAX_MB * 1024 * 1024,
  aoFinalizar: async (gravacao) => {
    telemetria.registrar({
      sala: gravacao.sala, origem: 'servidor', papel: gravacao.papel, tipo: 'gravacao_recebida',
      nivel: gravacao.quantos_faltando ? 'aviso' : 'info',
      dados: {
        bytes: gravacao.bytes,
        pedacos: gravacao.pedacos,
        faltando: gravacao.faltando,
        quantos_faltando: gravacao.quantos_faltando,
        fechada_por: gravacao.motivo,
        cliente: gravacao.estatisticas,
      },
      em: Date.now()
    });
    const saida = path.join(tmpdir(), `${randomUUID()}.mp4`);
    return processarGravacao(gravacao.caminho, saida, gravacao.sala, gravacao.inicio, gravacao.estatisticas, gravacao.papel);
  }
});

const uploadPedaco = multer({
  storage: multer.diskStorage({
    destination: gravacoes.pastaTemporaria,
    filename: (req, file, cb) => cb(null, `${randomUUID()}.parte`)
  }),
  limits: {
    fileSize: PEDACO_MAX_MB * 1024 * 1024
  }
});

// Teste de equipamento: 10 segundos não passam de alguns MB. O limite baixo
// é o que impede a rota pública de virar depósito de arquivo.
const uploadDiagnostico = multer({
  storage: multer.diskStorage({
    destination: tmpdir(),
    filename: (req, file, cb) => cb(null, `${randomUUID()}.diagnostico`)
  }),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

const MAX_ROOM_SIZE = 5;

const clients = new Map();

const rooms = new Map();

const clientRoom = new Map();

// Quem é quem na sala. O rótulo vem do papel que a página informa ao entrar
// (intérprete, suporte, surdo) — é o que aparece no tile e no chat, no lugar
// do id sorteado, que não diz nada para quem está do outro lado.
const clientRotulo = new Map();

const ROTULOS = {
  interprete: 'Intérprete',
  suporte:    'Suporte',
  surdo:      'Surdo',
};

const CHAT_MAX_CARACTERES = 2000;
// A página do surdo é pública, então o WebSocket aceita conexão de qualquer um.
// Uma janela simples evita que um cliente sozinho inunde a sala.
const CHAT_JANELA_MS = 5000;
const CHAT_MAX_NA_JANELA = 12;
const chatHistorico = new Map();

function rotuloDe(papel) {
  return ROTULOS[String(papel || '').toLowerCase()] || 'Participante';
}

function podeMandarChat(clientId) {
  const agora = Date.now();
  const recentes = (chatHistorico.get(clientId) || []).filter(t => agora - t < CHAT_JANELA_MS);
  if (recentes.length >= CHAT_MAX_NA_JANELA) {
    chatHistorico.set(clientId, recentes);
    return false;
  }
  recentes.push(agora);
  chatHistorico.set(clientId, recentes);
  return true;
}

// Mesma lógica do chat, com teto próprio: uma chamada normal manda poucos
// eventos por minuto, e um laço no navegador não pode inundar o iLibras.
const TELEMETRIA_JANELA_MS = 60000;
const TELEMETRIA_MAX_NA_JANELA = 60;
const telemetriaHistorico = new Map();

function quantosEventosAceitar(clientId, quantidade) {
  const agora = Date.now();
  const recentes = (telemetriaHistorico.get(clientId) || []).filter(t => agora - t < TELEMETRIA_JANELA_MS);
  const aceitos = Math.max(0, Math.min(quantidade, TELEMETRIA_MAX_NA_JANELA - recentes.length));
  for (let i = 0; i < aceitos; i++) recentes.push(agora);
  telemetriaHistorico.set(clientId, recentes);
  return aceitos;
}

// O papel cru ('interprete', 'surdo', 'suporte') e não o rótulo: é o que o
// iLibras usa para saber de que lado da chamada veio o problema.
const clientPapel = new Map();

function eventoDoServidor(clientId, tipo, nivel, dados = {}, sala = null) {
  telemetria.registrar({
    sala: sala || clientRoom.get(clientId) || null,
    origem: 'servidor',
    papel: clientPapel.get(clientId) || null,
    cliente: clientId,
    tipo,
    nivel,
    dados,
    em: Date.now(),
  });
}

wss.on('connection', (ws) => {
  const clientId = generateId();
  clients.set(clientId, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // A lista vai junto com o id: o cliente entra na sala logo em seguida e
  // precisa dela antes de abrir a primeira RTCPeerConnection.
  const iceServers = montarServidoresIce();
  ws.send(JSON.stringify({
    type: 'init',
    id: clientId,
    iceServers,
    turn: temTurn(iceServers)
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join-room': {
          const roomId = data.room;
          const prevRoomId = clientRoom.get(clientId);
          // Pedido repetido da mesma conexão (dois cliques em "Entrar" enquanto
          // o navegador pedia a câmera): tratar como troca de sala avisava
          // saída e entrada ao outro lado, que renegociava duas vezes e levava
          // 20 s para conectar.
          if (prevRoomId === roomId && rooms.has(roomId) && rooms.get(roomId).has(clientId)) {
            eventoDoServidor(clientId, 'entrada_repetida', 'info', {});
            break;
          }
          if (prevRoomId && rooms.has(prevRoomId)) {
            const prevRoom = rooms.get(prevRoomId);
            prevRoom.delete(clientId);
            for (const peerId of prevRoom) {
              const peerWs = clients.get(peerId);
              if (peerWs) {
                peerWs.send(JSON.stringify({ type: 'peer-left', peerId: clientId, room: prevRoomId }));
              }
            }
            if (prevRoom.size === 0) rooms.delete(prevRoomId);
            clientRoom.delete(clientId);
          }

          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }

          const room = rooms.get(roomId);

          if (room.size >= MAX_ROOM_SIZE) {
            ws.send(JSON.stringify({ type: 'room-full', room: roomId }));
            eventoDoServidor(clientId, 'sala_lotada', 'aviso', { participantes: room.size }, roomId);
            return;
          }

          const existingMembers = Array.from(room);
          room.add(clientId);
          clientRoom.set(clientId, roomId);
          clientRotulo.set(clientId, rotuloDe(data.papel));
          clientPapel.set(clientId, String(data.papel || '').toLowerCase().slice(0, 30) || null);

          eventoDoServidor(clientId, 'entrou_na_sala', 'info', {
            participantes: room.size,
            ja_estavam: existingMembers.map(id => clientPapel.get(id) || 'participante'),
          });

          // peers continua sendo a lista de ids; os rótulos vão à parte para
          // não quebrar quem já consome esse formato.
          const rotulos = {};
          for (const peerId of existingMembers) rotulos[peerId] = clientRotulo.get(peerId) || 'Participante';

          ws.send(JSON.stringify({
            type: 'room-joined',
            room: roomId,
            peers: existingMembers,
            rotulos
          }));

          for (const peerId of existingMembers) {
            const peerWs = clients.get(peerId);
            if (peerWs) {
              peerWs.send(JSON.stringify({
                type: 'peer-joined',
                peerId: clientId,
                room: roomId,
                rotulo: clientRotulo.get(clientId)
              }));
            }
          }
          break;
        }

        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          if (data.target && clients.has(data.target)) {
            clients.get(data.target).send(JSON.stringify({
              ...data,
              from: clientId
            }));
          }
          break;
        }

        // Encerrar a chamada vale para a sala inteira: quem conduz o
        // atendimento apertou "Encerrar" no iLibras_v2, e os outros não podem
        // continuar numa chamada que já acabou. Só avisa — cada cliente sai
        // pelo próprio hangup, que é onde a gravação é finalizada.
        case 'end-call': {
          const salaId = clientRoom.get(clientId);
          if (!salaId || !rooms.has(salaId)) break;

          eventoDoServidor(clientId, 'sala_encerrada', 'info', { participantes: rooms.get(salaId).size });

          for (const peerId of rooms.get(salaId)) {
            if (peerId === clientId) continue;
            const peerWs = clients.get(peerId);
            if (peerWs) {
              peerWs.send(JSON.stringify({
                type: 'room-closed',
                room: salaId,
                por: clientRotulo.get(clientId) || 'Participante'
              }));
            }
          }
          break;
        }

        case 'leave-room': {
          const leaveRoomId = clientRoom.get(clientId);
          if (leaveRoomId && rooms.has(leaveRoomId)) {
            eventoDoServidor(clientId, 'saiu_da_sala', 'info', { motivo: 'saida' });
            const room = rooms.get(leaveRoomId);
            room.delete(clientId);
            for (const peerId of room) {
              const peerWs = clients.get(peerId);
              if (peerWs) {
                peerWs.send(JSON.stringify({ type: 'peer-left', peerId: clientId, room: leaveRoomId }));
              }
            }
            if (room.size === 0) rooms.delete(leaveRoomId);
            clientRoom.delete(clientId);
          }
          break;
        }

        case 'chat': {
          const roomId = clientRoom.get(clientId);
          if (!roomId || !rooms.has(roomId)) break;

          const texto = String(data.texto ?? '').trim().slice(0, CHAT_MAX_CARACTERES);
          if (!texto) break;
          if (!podeMandarChat(clientId)) break;

          // Volta também para quem enviou: assim todo mundo renderiza a partir
          // da mesma fonte e a ordem das mensagens é a mesma em todas as telas.
          const mensagem = JSON.stringify({
            type: 'chat',
            de: clientId,
            rotulo: clientRotulo.get(clientId) || 'Participante',
            texto,
            em: Date.now()
          });

          for (const peerId of rooms.get(roomId)) {
            const peerWs = clients.get(peerId);
            if (peerWs) peerWs.send(mensagem);
          }
          break;
        }

        // O ping do protocolo (ws.ping) não chega ao JavaScript do navegador:
        // sem este eco o cliente não sabe que a conexão morreu e pode passar
        // minutos achando que está na sala.
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', t: data.t }));
          break;
        }

        case 'telemetria': {
          const brutos = Array.isArray(data.eventos) ? data.eventos.slice(0, 20) : [];
          const aceitos = quantosEventosAceitar(clientId, brutos.length);
          // Antes de entrar na sala (câmera recusada, por exemplo) o servidor
          // ainda não sabe a sala; aí vale a que a página leu da própria URL.
          const sala = clientRoom.get(clientId) || (typeof data.sala === 'string' ? data.sala : null);
          const papel = clientPapel.get(clientId) || (typeof data.papel === 'string' ? data.papel.toLowerCase() : null);

          for (const bruto of brutos.slice(0, aceitos)) {
            const evento = normalizarEventoDoCliente(bruto);
            if (!evento) continue;
            telemetria.registrar({ ...evento, sala, papel, cliente: clientId, origem: 'cliente' });
          }
          break;
        }

        // Câmera/microfone ligados ou não, anunciados por quem os desligou. É
        // o que deixa o outro lado dizer "desligou a câmera" em vez de mostrar
        // um quadro preto sem explicação.
        case 'estado-midia': {
          const roomId = clientRoom.get(clientId);
          if (!roomId || !rooms.has(roomId)) break;
          const aviso = JSON.stringify({
            type: 'estado-midia',
            from: clientId,
            camera: data.camera !== false,
            microfone: data.microfone !== false
          });
          for (const peerId of rooms.get(roomId)) {
            if (peerId === clientId) continue;
            const peerWs = clients.get(peerId);
            if (peerWs) peerWs.send(aviso);
          }
          break;
        }

        case 'recording-started':
        case 'recording-stopped': {
          const roomId = clientRoom.get(clientId);
          if (roomId && rooms.has(roomId)) {
            const room = rooms.get(roomId);
            for (const peerId of room) {
              if (peerId !== clientId) {
                const peerWs = clients.get(peerId);
                if (peerWs) {
                  peerWs.send(JSON.stringify({
                    type: data.type,
                    recorderId: clientId
                  }));
                }
              }
            }
          }
          break;
        }

        default:
          if (data.target && clients.has(data.target)) {
            clients.get(data.target).send(JSON.stringify({
              ...data,
              from: clientId
            }));
          }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', (codigo) => {
    const roomId = clientRoom.get(clientId);

    if (roomId && rooms.has(roomId)) {
      // Sair pelo fechamento da conexão (aba fechada, rede caída, heartbeat
      // vencido) é diferente de sair pelo leave-room — e é o caso que explica
      // "a outra pessoa sumiu".
      eventoDoServidor(clientId, 'saiu_da_sala', 'aviso', { motivo: 'conexao_fechada', codigo });
      const room = rooms.get(roomId);
      room.delete(clientId);

      for (const peerId of room) {
        const peerWs = clients.get(peerId);
        if (peerWs) {
          peerWs.send(JSON.stringify({
            type: 'peer-left',
            peerId: clientId,
            room: roomId
          }));
        }
      }

      if (room.size === 0) {
        rooms.delete(roomId);
      }
    }

    clientRoom.delete(clientId);
    clientRotulo.delete(clientId);
    clientPapel.delete(clientId);
    chatHistorico.delete(clientId);
    telemetriaHistorico.delete(clientId);
    clients.delete(clientId);
  });
});

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 5000);

// Notifica o iLibras_v2 (server-to-server) quando a gravação termina de processar,
// para o vídeo ser anexado ao atendimento sem depender da aba do atendente continuar aberta.
async function notificarWebhook(payload) {
  const url = process.env.ILIBRAS_WEBHOOK_URL;
  const token = process.env.ILIBRAS_WEBHOOK_TOKEN;
  if (!url) return;

  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/api/webhooks/gocall/gravacao`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Token': token || ''
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      console.error(`Webhook iLibras respondeu ${resp.status}:`, await resp.text());
    }
  } catch (error) {
    console.error('Falha ao notificar webhook iLibras:', error.message);
  }
}

// O navegador manda junto o que viu enquanto gravava (quadros desenhados,
// tempo com a aba escondida, formato escolhido). É texto de qualquer um, então
// só entra se for objeto e cabe no limite do evento.
function lerEstatisticasDoCliente(texto) {
  try {
    const valor = JSON.parse(String(texto || '{}'));
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return {};
    return JSON.stringify(valor).length > 3000 ? { truncado: true } : valor;
  } catch (e) {
    return {};
  }
}

// Mais de uma gravação na mesma sala acontece: F5 do intérprete no meio da
// chamada, "Remover Intérprete" e outro assume. O iLibras guarda um vídeo por
// atendimento e vale o último aviso, e a gravação que fecha por inatividade
// chega minutos depois — um trecho curto tomaria o lugar da chamada inteira.
// Fica vinculada a mais longa; as outras continuam no S3, com a chave no
// evento gravacao_salva.
const GRAVACAO_MAIS_LONGA_VALIDADE_MS = 24 * 60 * 60 * 1000;
const gravacaoMaisLongaPorSala = new Map();

function deveVincularGravacao(sala, duracaoS) {
  const agora = Date.now();
  for (const [chave, registro] of gravacaoMaisLongaPorSala) {
    if (agora - registro.em > GRAVACAO_MAIS_LONGA_VALIDADE_MS) gravacaoMaisLongaPorSala.delete(chave);
  }
  const anterior = gravacaoMaisLongaPorSala.get(sala);
  if (anterior && anterior.duracao > duracaoS) return false;
  gravacaoMaisLongaPorSala.set(sala, { duracao: duracaoS, em: agora });
  return true;
}

// Transcodifica e envia ao S3 em background — não bloqueia a resposta ao navegador.
// Devolve false quando o vídeo não chegou ao S3.
async function processarGravacao(inputPath, outputPath, roomId, timestamp, estatisticas = {}, papel = null) {
  const duracaoInformadaS = Number(estatisticas.duracao_ms) > 0 ? Number(estatisticas.duracao_ms) / 1000 : null;
  const evento = (tipo, nivel, dados) => telemetria.registrar({
    sala: roomId, origem: 'servidor', papel, tipo, nivel, dados, em: Date.now()
  });
  let duracaoS = duracaoInformadaS || 0;

  try {
    const conversao = await converterGravacao(inputPath, outputPath);
    if (conversao.reempacotada || conversao.recodificada) {
      // Gravou, mas o navegador entregou um vídeo que precisou de conserto.
      // Quase sempre é navegador desatualizado: vale avisar quem gravou.
      evento('gravacao_consertada', 'aviso', { ...conversao, cliente: estatisticas });
    }

    // Confere o arquivo que vai virar o registro do atendimento. Antes, uma
    // gravação sem vídeo só era descoberta quando alguém abria o atendimento
    // dias depois. A análise falhar não impede o envio: o arquivo ainda é o
    // melhor que se tem.
    try {
      const analise = await analisarMidia(outputPath);
      const decodificacao = await conferirDecodificacao(outputPath).catch(() => null);
      const avaliacao = avaliarGravacao(analise, duracaoInformadaS, decodificacao);
      if (avaliacao.duracao) duracaoS = avaliacao.duracao;
      evento(avaliacao.ok ? 'gravacao_analisada' : 'gravacao_com_problema', avaliacao.ok ? 'info' : 'erro', {
        ...avaliacao,
        video: analise.video,
        audio: analise.audio,
        bytes: analise.bytes,
        decodificacao,
        cliente: estatisticas,
      });
    } catch (erroAnalise) {
      evento('gravacao_sem_analise', 'aviso', { erro: erroAnalise.message, cliente: estatisticas });
    }

    const fileName = `${process.env.S3_RECORDINGS_FOLDER || 'webrtc-recordings/'}${roomId}_${timestamp}.mp4`;

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: fileName,
        Body: createReadStream(outputPath),
        ContentType: 'video/mp4'
      }
    });

    const result = await upload.done();

    const region = process.env.AWS_REGION || 'us-east-1';
    const bucket = process.env.AWS_S3_BUCKET;
    const s3Url = result.Location ||
      `https://${bucket}.s3.${region}.amazonaws.com/${fileName}`;

    const vinculada = deveVincularGravacao(roomId, duracaoS);
    evento('gravacao_salva', 'info', { video_key: fileName, duracao: duracaoS, vinculada });
    if (vinculada) {
      await notificarWebhook({ room: roomId, video_url: s3Url, video_key: fileName });
    }
    return true;
  } catch (error) {
    console.error(`Erro ao processar gravação da sala ${roomId}:`, error);
    evento('gravacao_falhou', 'erro', { erro: error.message, cliente: estatisticas });
    await notificarWebhook({ room: roomId, error: error.message });
    return false;
  } finally {
    for (const p of [inputPath, outputPath]) {
      unlink(p, () => {});
    }
  }
}

app.post('/api/upload-recording', upload.single('recording'), async (req, res) => {
  const outputPath = path.join(tmpdir(), `${randomUUID()}.mp4`);

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // O multer já gravou em disco — a partir daqui o arquivo está seguro no servidor.
  const { roomId, timestamp } = req.body;
  const estatisticas = lerEstatisticasDoCliente(req.body.estatisticas);
  const papel = typeof req.body.papel === 'string' ? req.body.papel.toLowerCase().slice(0, 30) : null;

  // A gravação é automática e só do intérprete. Um trecho gravado pelo surdo
  // (havia um botão de gravar na tela dele) chegava aqui e o webhook trocava
  // a gravação do atendimento por ele.
  if (papel && papel !== 'interprete') {
    unlink(req.file.path, () => {});
    telemetria.registrar({
      sala: roomId, origem: 'servidor', papel, tipo: 'gravacao_ignorada', nivel: 'aviso',
      dados: { motivo: 'papel', bytes: req.file.size }, em: Date.now()
    });
    return res.status(403).json({ error: 'Só o intérprete grava a chamada.' });
  }

  telemetria.registrar({
    sala: roomId, origem: 'servidor', papel, tipo: 'gravacao_recebida', nivel: 'info',
    dados: { bytes: req.file.size, cliente: estatisticas }, em: Date.now()
  });

  // Responde imediatamente: o atendente não precisa esperar o FFmpeg + upload ao S3.
  res.json({ success: true, status: 'processing', room: roomId });

  // Processamento pesado continua em background, independente da conexão do navegador.
  processarGravacao(req.file.path, outputPath, roomId, timestamp, estatisticas, papel);
});

// Envio antigo, o arquivo inteiro no fim da chamada. Continua de pé para a
// aba que abriu antes da troca e ainda roda o cliente velho.
//
// O novo: um pedaço a cada poucos segundos durante a chamada, e no fim o
// aviso de que acabou. A ordem dos campos importa — o multer só conhece os
// que vieram antes do arquivo.
app.post('/api/gravacao/pedaco', uploadPedaco.single('pedaco'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum pedaço enviado.' });
  }

  const papel = typeof req.body.papel === 'string' ? req.body.papel.toLowerCase().slice(0, 30) : null;
  const sala = typeof req.body.sala === 'string' ? req.body.sala.trim().slice(0, 120) : '';
  const seq = Number(req.body.seq);

  if (papel && papel !== 'interprete') {
    gravacoes.descartarArquivo(req.file.path);
    if (seq === 0) {
      telemetria.registrar({
        sala, origem: 'servidor', papel, tipo: 'gravacao_ignorada', nivel: 'aviso',
        dados: { motivo: 'papel', bytes: req.file.size }, em: Date.now()
      });
    }
    return res.status(403).json({ error: 'Só o intérprete grava a chamada.' });
  }

  try {
    const resultado = await gravacoes.receberPedaco({
      id: req.body.id,
      sala,
      papel,
      seq,
      arquivo: req.file.path,
      bytes: req.file.size,
      tipoMime: typeof req.body.tipo_mime === 'string' ? req.body.tipo_mime.slice(0, 100) : null,
      estatisticas: lerEstatisticasDoCliente(req.body.estatisticas),
    });
    res.json({ ok: true, ...resultado });
  } catch (erro) {
    gravacoes.descartarArquivo(req.file.path);
    if (erro.status) {
      if (erro.status === 413) {
        telemetria.registrar({
          sala, origem: 'servidor', papel, tipo: 'gravacao_recusada', nivel: 'erro',
          dados: { motivo: erro.codigo, limite_mb: GRAVACAO_MAX_MB }, em: Date.now()
        });
      }
      return res.status(erro.status).json({ error: erro.codigo });
    }
    console.error(`Falha ao guardar pedaço da gravação ${req.body.id}:`, erro);
    res.status(500).json({ error: 'falha_ao_guardar' });
  }
});

// O aviso da página fechando chega pelo sendBeacon, como texto.
app.post('/api/gravacao/finalizar', express.text({ type: 'text/plain', limit: '100kb' }), async (req, res) => {
  let corpo = req.body || {};
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = {}; }
  }
  if (!idDeGravacaoValido(corpo.id)) {
    return res.status(400).json({ error: 'id_invalido' });
  }

  try {
    const resultado = await gravacoes.finalizar(corpo.id, {
      total: Number.isInteger(corpo.total) ? corpo.total : null,
      estatisticas: lerEstatisticasDoCliente(JSON.stringify(corpo.estatisticas || {})),
      motivo: corpo.motivo === 'pagina_fechada' ? 'pagina_fechada' : 'cliente',
    });
    res.json(resultado);
  } catch (erro) {
    console.error(`Falha ao finalizar a gravação ${corpo.id}:`, erro);
    res.status(500).json({ error: 'falha_ao_finalizar' });
  }
});

// Limite simples por IP para a rota do teste de equipamento, que é pública.
const DIAGNOSTICO_JANELA_MS = 10 * 60 * 1000;
const DIAGNOSTICO_MAX_NA_JANELA = 10;
const diagnosticoPorIp = new Map();

function ipDe(req) {
  return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
}

function limitarDiagnostico(req, res, next) {
  const agora = Date.now();
  const ip = ipDe(req);
  const recentes = (diagnosticoPorIp.get(ip) || []).filter(t => agora - t < DIAGNOSTICO_JANELA_MS);
  if (recentes.length >= DIAGNOSTICO_MAX_NA_JANELA) {
    return res.status(429).json({ error: 'Muitos testes seguidos. Aguarde alguns minutos.' });
  }
  recentes.push(agora);
  diagnosticoPorIp.set(ip, recentes);
  next();
}

// Teste de equipamento: o navegador grava 10 segundos do mesmo jeito que grava
// a chamada e o servidor diz o que recebeu. Nada vai para o S3 e o arquivo é
// apagado na hora — o que interessa é saber se o vídeo chega com quadros.
app.post('/api/diagnostico/gravacao', limitarDiagnostico, uploadDiagnostico.single('gravacao'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const duracaoInformadaS = Number(req.body.duracao_ms) > 0 ? Number(req.body.duracao_ms) / 1000 : null;
  // Passa pela mesma conversão da chamada: o que se confere é o arquivo que
  // ficaria como registro, não o que o navegador mandou.
  const convertido = path.join(tmpdir(), `${randomUUID()}.mp4`);
  try {
    const conversao = await converterGravacao(req.file.path, convertido);
    const analise = await analisarMidia(convertido);
    const decodificacao = await conferirDecodificacao(convertido).catch(() => null);
    res.json({
      ...avaliarGravacao(analise, duracaoInformadaS, decodificacao),
      video: analise.video,
      audio: analise.audio,
      bytes: analise.bytes,
      formato: analise.formato,
      decodificacao,
      reempacotada: conversao.reempacotada,
      recodificada: conversao.recodificada,
    });
  } catch (erro) {
    res.status(422).json({ ok: false, problemas: ['arquivo_ilegivel'], erro: erro.message });
  } finally {
    unlink(req.file.path, () => {});
    unlink(convertido, () => {});
  }
});

// Arquivo acima do limite: o multer rejeita antes de chegar à rota. Sem este
// tratamento o Express devolvia uma página de erro em HTML e a gravação
// sumia sem deixar rastro de por quê.
app.use((erro, req, res, next) => {
  if (erro instanceof multer.MulterError) {
    if (req.path === '/api/upload-recording') {
      telemetria.registrar({
        sala: req.body && req.body.roomId, origem: 'servidor', tipo: 'gravacao_recusada', nivel: 'erro',
        dados: { motivo: erro.code, limite_mb: GRAVACAO_MAX_MB }, em: Date.now()
      });
    } else if (req.path === '/api/gravacao/pedaco') {
      telemetria.registrar({
        sala: req.body && req.body.sala, origem: 'servidor', tipo: 'gravacao_recusada', nivel: 'erro',
        dados: { motivo: erro.code, limite_mb_pedaco: PEDACO_MAX_MB, seq: req.body && req.body.seq }, em: Date.now()
      });
    }
    return res.status(erro.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: erro.message, code: erro.code });
  }
  next(erro);
});

// Gravações que estavam em curso quando o servidor caiu continuam de onde
// pararam; as que ficaram sem pedaço novo por muito tempo (aba fechada sem
// aviso, computador travado) são fechadas com o que chegou.
await gravacoes.recuperar();
setInterval(() => {
  gravacoes.varrer().catch(erro => console.error('Falha ao fechar gravações paradas:', erro));
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Access on local network: http://YOUR_IP:${PORT}`);
});