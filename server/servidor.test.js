import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { montarServidoresIce, temTurn } from './ice.js';
import { analisarMidia, avaliarGravacao, resumirSaidaDoFfprobe } from './midia.js';
import { criarTelemetria, normalizarEventoDoCliente } from './telemetria.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ── ICE ────────────────────────────────────────────────────────────────

test('sem TURN_URLS, entrega só o STUN', () => {
  const servidores = montarServidoresIce({});
  assert.equal(servidores.length, 1);
  assert.ok(servidores[0].urls.every(u => u.startsWith('stun:')));
  assert.equal(temTurn(servidores), false);
});

test('com TURN_SECRET, gera a credencial temporária do coturn', () => {
  const agora = Date.UTC(2026, 9, 21, 12, 0, 0);
  const servidores = montarServidoresIce({
    TURN_URLS: 'turn:turn.exemplo:3478?transport=udp, turns:turn.exemplo:5349',
    TURN_SECRET: 'segredo',
    TURN_TTL_SEGUNDOS: '3600'
  }, agora);

  const turn = servidores[1];
  assert.deepEqual(turn.urls, ['turn:turn.exemplo:3478?transport=udp', 'turns:turn.exemplo:5349']);
  assert.equal(turn.username, `${agora / 1000 + 3600}:gocall`);
  assert.equal(turn.credential, createHmac('sha1', 'segredo').update(turn.username).digest('base64'));
  assert.equal(temTurn(servidores), true);
});

test('sem segredo, usa a credencial fixa do provedor', () => {
  const servidores = montarServidoresIce({
    TURN_URLS: 'turn:relay.exemplo:443?transport=tcp',
    TURN_USERNAME: 'usuario',
    TURN_CREDENTIAL: 'senha'
  });
  assert.deepEqual(servidores[1], { urls: ['turn:relay.exemplo:443?transport=tcp'], username: 'usuario', credential: 'senha' });
});

test('TURN_URLS sem credencial nenhuma não entra na lista', () => {
  const servidores = montarServidoresIce({ TURN_URLS: 'turn:relay.exemplo:3478' });
  assert.equal(temTurn(servidores), false);
});

// ── Avaliação da gravação ──────────────────────────────────────────────

test('gravação sem faixa de vídeo é problema', () => {
  const avaliacao = avaliarGravacao({ duracao: 60, video: null, audio: { codec: 'aac', pacotes: 2800 } });
  assert.equal(avaliacao.ok, false);
  assert.deepEqual(avaliacao.problemas, ['sem_faixa_de_video']);
});

test('vídeo com menos de 1 quadro por segundo é tratado como parado', () => {
  const avaliacao = avaliarGravacao({ duracao: 300, video: { pacotes: 40 }, audio: { pacotes: 14000 } });
  assert.deepEqual(avaliacao.problemas, ['video_quase_parado']);
  assert.equal(avaliacao.quadros_por_segundo, 0.1);
});

test('sem duração no contêiner, usa a que o navegador mediu', () => {
  const avaliacao = avaliarGravacao({ duracao: null, video: { pacotes: 300 }, audio: { pacotes: 500 } }, 10);
  assert.equal(avaliacao.ok, true);
  assert.equal(avaliacao.quadros_por_segundo, 30);
});

test('resume a saída do ffprobe sem depender de campos opcionais', () => {
  const resumo = resumirSaidaDoFfprobe({
    format: { duration: '12.5', size: '1000', format_name: 'mov,mp4' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, nb_read_packets: '375' },
      { codec_type: 'audio', codec_name: 'aac', nb_read_packets: '540' }
    ]
  });
  assert.deepEqual(resumo, {
    duracao: 12.5, bytes: 1000, formato: 'mov,mp4',
    video: { codec: 'h264', largura: 1920, altura: 1080, pacotes: 375 },
    audio: { codec: 'aac', pacotes: 540 }
  });
});

// Arquivos de verdade, gerados pelo mesmo ffmpeg que o servidor usa: é o que
// garante que o ffprobe encontrado pelo pacote lê o que a chamada produz.
function gerar(argumentosDeEntrada, saida, opcoes) {
  return new Promise((resolve, reject) => {
    const comando = ffmpeg();
    for (const entrada of argumentosDeEntrada) comando.input(entrada.fonte).inputOptions(entrada.opcoes);
    comando.outputOptions(opcoes).output(saida).on('end', resolve).on('error', reject).run();
  });
}

test('ffprobe enxerga vídeo e áudio de um arquivo real', async () => {
  const arquivo = path.join(tmpdir(), `${randomUUID()}.webm`);
  try {
    await gerar([
      { fonte: 'testsrc=size=320x180:rate=30', opcoes: ['-f', 'lavfi'] },
      { fonte: 'sine=frequency=440', opcoes: ['-f', 'lavfi'] }
    ], arquivo, ['-t', '2', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus']);

    const analise = await analisarMidia(arquivo);
    assert.equal(analise.video.codec, 'vp8');
    assert.ok(analise.video.pacotes >= 55, `pacotes de vídeo: ${analise.video.pacotes}`);
    assert.equal(analise.audio.codec, 'opus');
    assert.equal(avaliarGravacao(analise, 2).ok, true);
  } finally {
    await unlink(arquivo).catch(() => {});
  }
});

test('ffprobe denuncia arquivo só com áudio', async () => {
  const arquivo = path.join(tmpdir(), `${randomUUID()}.webm`);
  try {
    await gerar([{ fonte: 'sine=frequency=440', opcoes: ['-f', 'lavfi'] }], arquivo, ['-t', '2', '-c:a', 'libopus']);
    const analise = await analisarMidia(arquivo);
    assert.deepEqual(avaliarGravacao(analise, 2).problemas, ['sem_faixa_de_video']);
  } finally {
    await unlink(arquivo).catch(() => {});
  }
});

// ── Eventos ────────────────────────────────────────────────────────────

test('evento do navegador só passa com tipo em formato fixo', () => {
  assert.equal(normalizarEventoDoCliente({ tipo: 'DROP TABLE' }), null);
  assert.equal(normalizarEventoDoCliente({ tipo: '' }), null);
  assert.equal(normalizarEventoDoCliente('texto'), null);
  assert.equal(normalizarEventoDoCliente({ tipo: 'a'.repeat(61) }), null);
});

test('evento do navegador: nível fora da lista vira info, dados grandes são cortados, hora absurda vira agora', () => {
  const agora = Date.now();
  const evento = normalizarEventoDoCliente({
    tipo: 'video_remoto_parado',
    nivel: 'critico',
    dados: { texto: 'x'.repeat(5000) },
    em: 0
  }, agora);
  assert.deepEqual(evento, { tipo: 'video_remoto_parado', nivel: 'info', dados: { truncado: true }, em: agora });
});

function respostaFalsa(status, corpo = '') {
  return { status, ok: status >= 200 && status < 300, text: async () => corpo };
}

function telemetriaDeTeste(respostas) {
  const chamadas = [];
  const log = { log: () => {}, error: () => {} };
  const fetchImpl = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body), token: opcoes.headers['X-Webhook-Token'] });
    return respostaFalsa(respostas.shift() ?? 200);
  };
  const telemetria = criarTelemetria({ url: 'https://ilibras.exemplo/', token: 'tk', fetchImpl, log, intervaloMs: 60000 });
  return { telemetria, chamadas };
}

test('eventos vão em lote, com token, para o endpoint do iLibras', async () => {
  const { telemetria, chamadas } = telemetriaDeTeste([200]);
  telemetria.registrar({ sala: 's1', tipo: 'entrou_na_sala', nivel: 'info', dados: {} });
  telemetria.registrar({ sala: 's1', tipo: 'saiu_da_sala', nivel: 'info', dados: {} });
  await telemetria.enviar();
  telemetria.parar();

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://ilibras.exemplo/api/webhooks/gocall/eventos');
  assert.equal(chamadas[0].token, 'tk');
  assert.deepEqual(chamadas[0].corpo.eventos.map(e => e.tipo), ['entrou_na_sala', 'saiu_da_sala']);
  assert.equal(telemetria.pendentes(), 0);
});

test('falha 5xx devolve o lote para a fila; 4xx descarta', async () => {
  const { telemetria, chamadas } = telemetriaDeTeste([503, 422]);
  telemetria.registrar({ sala: 's1', tipo: 'conexao_falhou', nivel: 'aviso', dados: {} });
  await telemetria.enviar();
  assert.equal(telemetria.pendentes(), 1);

  await telemetria.enviar();
  assert.equal(telemetria.pendentes(), 0);
  assert.equal(chamadas.length, 2);
  telemetria.parar();
});

test('sem URL do iLibras, só registra no log', async () => {
  const linhas = [];
  const telemetria = criarTelemetria({ url: '', log: { log: (l) => linhas.push(l), error: () => {} } });
  telemetria.registrar({ sala: 's1', tipo: 'entrou_na_sala', nivel: 'info', dados: {} });
  telemetria.parar();
  assert.equal(telemetria.pendentes(), 0);
  assert.match(linhas[0], /^\[evento\] \{"sala":"s1"/);
});
