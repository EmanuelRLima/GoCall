import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { readFile, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpeg from 'fluent-ffmpeg';
import { montarServidoresIce, temTurn } from './ice.js';
import {
  analisarMidia, avaliarGravacao, comecaComCodigoDeInicio, conferirDecodificacao, converterGravacao,
  h264ComCodigoDeInicio, resumirSaidaDoFfprobe
} from './midia.js';
import { criarTelemetria, normalizarEventoDoCliente } from './telemetria.js';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const executar = promisify(execFile);

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

// ── Vídeo que tem quadros mas não abre ──────────────────────────────────

test('erro de decodificação vira video_ilegivel; um ou dois são tolerados', () => {
  const analise = { duracao: 20, video: { pacotes: 300 }, audio: { pacotes: 900 } };
  assert.deepEqual(avaliarGravacao(analise, null, { quadros: 300, erros: 12 }).problemas, ['video_ilegivel']);
  assert.equal(avaliarGravacao(analise, null, { quadros: 300, erros: 2 }).ok, true);
  assert.equal(avaliarGravacao(analise, null, null).ok, true);
});

test('reconhece código de início no dump do primeiro pacote', () => {
  assert.equal(comecaComCodigoDeInicio('\n00000000: 0000 0001 6742 c02a 8c8d 403c 0113 f2c0  ....gB.*..@<....\n'), true);
  assert.equal(comecaComCodigoDeInicio('\n00000000: 0000 3bb1 65b8 0427 118a 0002 0331 c000  ..;.e..\'.....1..\n'), false);
  // Prefixo de tamanho que por acaso começa com 000001 não é código de início.
  assert.equal(comecaComCodigoDeInicio('00000000: 0000 012c 6588 8400  ...,e...'), false);
  assert.equal(comecaComCodigoDeInicio(undefined), false);
});

// Reproduz o que o Chrome 126 grava: troca o prefixo de tamanho de cada NAL
// pelo código de início, sem mexer em mais nada do MP4.
async function trocarPrefixosPorCodigoDeInicio(entrada, saida) {
  const { stdout } = await executar(ffprobeInstaller.path, [
    '-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'packet=pos,size', '-of', 'json', entrada
  ]);
  const bytes = await readFile(entrada);
  for (const pacote of JSON.parse(stdout).packets) {
    let i = Number(pacote.pos);
    const fim = i + Number(pacote.size);
    while (i + 4 <= fim) {
      const tamanho = bytes.readUInt32BE(i);
      bytes.writeUInt32BE(1, i);
      i += 4 + tamanho;
    }
  }
  await writeFile(saida, bytes);
}

const H264_COM_OPUS = [
  { fonte: 'testsrc=size=320x180:rate=30', opcoes: ['-f', 'lavfi'] },
  { fonte: 'sine=frequency=440:sample_rate=48000', opcoes: ['-f', 'lavfi'] }
];
const OPCOES_H264_COM_OPUS = [
  '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-g', '30', '-x264-params', 'repeat-headers=1',
  '-c:a', 'libopus', '-strict', '-2', '-f', 'mp4'
];

test('MP4 do Chrome 126 (H.264 com código de início) é consertado sem recodificar', async () => {
  const bom = path.join(tmpdir(), `${randomUUID()}.mp4`);
  const quebrado = path.join(tmpdir(), `${randomUUID()}.mp4`);
  const saida = path.join(tmpdir(), `${randomUUID()}.mp4`);
  try {
    await gerar(H264_COM_OPUS, bom, OPCOES_H264_COM_OPUS);
    await trocarPrefixosPorCodigoDeInicio(bom, quebrado);

    // O defeito: os pacotes estão todos lá, mas o decodificador não lê.
    const antes = await analisarMidia(quebrado);
    assert.ok(antes.video.pacotes >= 85, `pacotes: ${antes.video.pacotes}`);
    assert.equal(await h264ComCodigoDeInicio(quebrado), true);
    const decodificacaoAntes = await conferirDecodificacao(quebrado);
    assert.deepEqual(avaliarGravacao(antes, 3, decodificacaoAntes).problemas, ['video_ilegivel']);

    const conversao = await converterGravacao(quebrado, saida);
    assert.equal(conversao.reempacotada, true);
    assert.equal(conversao.recodificada, false);

    const depois = await analisarMidia(saida);
    const decodificacaoDepois = await conferirDecodificacao(saida);
    assert.equal(decodificacaoDepois.erros, 0);
    assert.equal(decodificacaoDepois.quadros, antes.video.pacotes);
    assert.equal(depois.video.codec, 'h264');
    assert.equal(depois.audio.codec, 'aac');
    assert.equal(avaliarGravacao(depois, 3, decodificacaoDepois).ok, true);
    assert.equal(await h264ComCodigoDeInicio(saida), false);
  } finally {
    for (const arquivo of [bom, quebrado, saida, `${saida}.ts`]) await unlink(arquivo).catch(() => {});
  }
});

test('MP4 saudável passa direto, sem conserto', async () => {
  const bom = path.join(tmpdir(), `${randomUUID()}.mp4`);
  const saida = path.join(tmpdir(), `${randomUUID()}.mp4`);
  try {
    await gerar(H264_COM_OPUS, bom, OPCOES_H264_COM_OPUS);
    assert.equal(await h264ComCodigoDeInicio(bom), false);
    assert.deepEqual(await converterGravacao(bom, saida), { reempacotada: false, recodificada: false });
    assert.equal((await conferirDecodificacao(saida)).erros, 0);
  } finally {
    for (const arquivo of [bom, saida]) await unlink(arquivo).catch(() => {});
  }
});

test('VP8 (que o MP4 não aceita) é recodificado em vez de perder a gravação', async () => {
  const webm = path.join(tmpdir(), `${randomUUID()}.webm`);
  const saida = path.join(tmpdir(), `${randomUUID()}.mp4`);
  try {
    await gerar(H264_COM_OPUS, webm, ['-t', '3', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus']);
    const conversao = await converterGravacao(webm, saida);
    assert.equal(conversao.recodificada, true);
    const analise = await analisarMidia(saida);
    const decodificacao = await conferirDecodificacao(saida);
    assert.equal(analise.video.codec, 'h264');
    assert.equal(decodificacao.erros, 0);
    assert.ok(decodificacao.quadros >= 85 && decodificacao.quadros <= 95, `quadros: ${decodificacao.quadros}`);
  } finally {
    for (const arquivo of [webm, saida]) await unlink(arquivo).catch(() => {});
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
