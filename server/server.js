import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream, unlink } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

const MAX_ROOM_SIZE = 5;

const clients = new Map();

const rooms = new Map();

const clientRoom = new Map();

wss.on('connection', (ws) => {
  const clientId = generateId();
  clients.set(clientId, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });


  ws.send(JSON.stringify({
    type: 'init',
    id: clientId
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'join-room': {
          const roomId = data.room;
          const prevRoomId = clientRoom.get(clientId);
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
            return;
          }

          const existingMembers = Array.from(room);
          room.add(clientId);
          clientRoom.set(clientId, roomId);

          ws.send(JSON.stringify({
            type: 'room-joined',
            room: roomId,
            peers: existingMembers
          }));

          for (const peerId of existingMembers) {
            const peerWs = clients.get(peerId);
            if (peerWs) {
              peerWs.send(JSON.stringify({
                type: 'peer-joined',
                peerId: clientId,
                room: roomId
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

        case 'leave-room': {
          const leaveRoomId = clientRoom.get(clientId);
          if (leaveRoomId && rooms.has(leaveRoomId)) {
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

  ws.on('close', () => {
    const roomId = clientRoom.get(clientId);

    if (roomId && rooms.has(roomId)) {
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

app.post('/api/upload-recording', upload.single('recording'), async (req, res) => {
  const inputPath  = path.join(tmpdir(), `${randomUUID()}.webm`);
  const outputPath = path.join(tmpdir(), `${randomUUID()}.mp4`);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Grava o buffer em disco para o FFmpeg processar
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(inputPath);
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.end(req.file.buffer);
    });

    // Transcodifica WebM (Opus) → MP4 (AAC) usando FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const { roomId, timestamp } = req.body;
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

    res.json({
      success: true,
      url: s3Url,
      key: fileName
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to upload recording',
      message: error.message
    });
  } finally {
    // Limpa arquivos temporários
    for (const p of [inputPath, outputPath]) {
      unlink(p, () => {});
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Access on local network: http://YOUR_IP:${PORT}`);
});