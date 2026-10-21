import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import path from 'path';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { criarGravacoesEmPedacos, idDeGravacaoValido, seqsFaltando } from './pedacos.js';

const silencioso = { error: () => {} };

async function montar(opcoes = {}) {
  const pasta = await mkdtemp(path.join(tmpdir(), 'gocall-pedacos-'));
  const finalizadas = [];
  let relogio = 1_000_000;
  const gravacoes = criarGravacoesEmPedacos({
    pasta,
    inatividadeMs: 60_000,
    agora: () => relogio,
    log: silencioso,
    aoFinalizar: async (gravacao) => {
      finalizadas.push({ ...gravacao, conteudo: await readFile(gravacao.caminho, 'utf8') });
      return opcoes.resultado ?? true;
    },
    ...opcoes.criar,
  });
  await gravacoes.recuperar();
  const avancar = (ms) => { relogio += ms; };
  const limpar = () => rm(pasta, { recursive: true, force: true });
  return { pasta, gravacoes, finalizadas, avancar, limpar };
}

// Simula o multer: o arquivo chega na pasta temporária e o módulo o move.
async function pedaco(gravacoes, id, seq, conteudo, extra = {}) {
  const arquivo = path.join(gravacoes.pastaTemporaria, `${randomUUID()}.parte`);
  await writeFile(arquivo, conteudo);
  return gravacoes.receberPedaco({
    id, sala: 'sala-teste', papel: 'interprete', seq, arquivo, bytes: Buffer.byteLength(conteudo), ...extra,
  });
}

const esperarProcessamento = () => new Promise(resolve => setTimeout(resolve, 50));

test('pedaços viram um arquivo só, na ordem, e a pasta some depois de processar', async () => {
  const { pasta, gravacoes, finalizadas, limpar } = await montar();
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA');
    await pedaco(gravacoes, id, 2, 'CCC');
    await pedaco(gravacoes, id, 1, 'BBB');

    assert.deepEqual(await gravacoes.finalizar(id, { total: 3 }), { status: 'processando', pedacos: 3 });
    await esperarProcessamento();

    assert.equal(finalizadas.length, 1);
    assert.equal(finalizadas[0].conteudo, 'AAABBBCCC');
    assert.equal(finalizadas[0].sala, 'sala-teste');
    assert.equal(finalizadas[0].motivo, 'cliente');
    assert.equal(finalizadas[0].quantos_faltando, 0);
    assert.equal(finalizadas[0].bytes, 9);
    assert.deepEqual((await readdir(pasta)).filter(n => !n.startsWith('.')), []);
  } finally {
    await limpar();
  }
});

test('o mesmo pedaço enviado duas vezes substitui, não soma', async () => {
  const { gravacoes, finalizadas, limpar } = await montar();
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA');
    await pedaco(gravacoes, id, 1, 'BB');
    const repetido = await pedaco(gravacoes, id, 1, 'BBB');
    assert.deepEqual(repetido, { recebidos: 2, bytes: 6 });

    await gravacoes.finalizar(id);
    await esperarProcessamento();
    assert.equal(finalizadas[0].conteudo, 'AAABBB');
  } finally {
    await limpar();
  }
});

test('sem o pedaço 0 não começa gravação, e gravação fechada não aceita mais pedaço', async () => {
  const { gravacoes, limpar } = await montar();
  try {
    const id = randomUUID();
    await assert.rejects(pedaco(gravacoes, id, 3, 'x'), { status: 409 });

    await pedaco(gravacoes, id, 0, 'AAA');
    await gravacoes.finalizar(id);
    await assert.rejects(pedaco(gravacoes, id, 1, 'BBB'), { status: 409 });
    await esperarProcessamento();
    await assert.rejects(pedaco(gravacoes, id, 0, 'AAA'), { status: 409 });
    assert.deepEqual(await gravacoes.finalizar(id), { status: 'ja_finalizada' });
  } finally {
    await limpar();
  }
});

test('entrada inválida é recusada antes de tocar no disco', async () => {
  const { gravacoes, limpar } = await montar();
  try {
    await assert.rejects(pedaco(gravacoes, '../../etc', 0, 'x'), { status: 400 });
    await assert.rejects(pedaco(gravacoes, randomUUID(), -1, 'x'), { status: 400 });
    await assert.rejects(pedaco(gravacoes, randomUUID(), 0, 'x', { sala: '' }), { status: 400 });
    assert.equal(idDeGravacaoValido('abc'), false);
    assert.equal(idDeGravacaoValido(randomUUID()), true);
    assert.deepEqual(await gravacoes.finalizar(randomUUID()), { status: 'desconhecida' });
  } finally {
    await limpar();
  }
});

test('passar do tamanho máximo é recusado com 413', async () => {
  const { gravacoes, limpar } = await montar({ criar: { maxBytes: 5 } });
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA');
    await assert.rejects(pedaco(gravacoes, id, 1, 'BBB'), { status: 413 });
  } finally {
    await limpar();
  }
});

test('aba que fechou sem avisar: a gravação fecha sozinha com o que chegou', async () => {
  const { gravacoes, finalizadas, avancar, limpar } = await montar();
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA', { estatisticas: { duracao_ms: 5000 } });
    await pedaco(gravacoes, id, 1, 'BBB', { estatisticas: { duracao_ms: 10000 } });

    avancar(30_000);
    await gravacoes.varrer();
    assert.equal(finalizadas.length, 0, 'ainda dentro do prazo');

    avancar(31_000);
    await gravacoes.varrer();
    await esperarProcessamento();
    assert.equal(finalizadas.length, 1);
    assert.equal(finalizadas[0].motivo, 'inatividade');
    assert.equal(finalizadas[0].conteudo, 'AAABBB');
    assert.deepEqual(finalizadas[0].estatisticas, { duracao_ms: 10000 });
  } finally {
    await limpar();
  }
});

test('pedaço que não chegou aparece como faltando', async () => {
  const { gravacoes, finalizadas, limpar } = await montar();
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA');
    await pedaco(gravacoes, id, 2, 'CCC');
    await gravacoes.finalizar(id, { total: 5 });
    await esperarProcessamento();
    assert.deepEqual(finalizadas[0].faltando, [1, 3, 4]);
    assert.equal(finalizadas[0].quantos_faltando, 3);
    assert.deepEqual(seqsFaltando({ 0: 1, 1: 1 }), []);
  } finally {
    await limpar();
  }
});

test('falha ao processar mantém os pedaços em disco', async () => {
  const { pasta, gravacoes, limpar } = await montar({ resultado: false });
  try {
    const id = randomUUID();
    await pedaco(gravacoes, id, 0, 'AAA');
    await gravacoes.finalizar(id);
    await esperarProcessamento();

    const meta = JSON.parse(await readFile(path.join(pasta, id, 'meta.json'), 'utf8'));
    assert.ok(meta.falhou_em);
    assert.ok((await stat(path.join(pasta, id, '000000.parte'))).size > 0);
  } finally {
    await limpar();
  }
});

test('reinício no meio: a gravação aberta continua e a já fechada é processada', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'gocall-pedacos-'));
  try {
    const antes = criarGravacoesEmPedacos({ pasta, log: silencioso, aoFinalizar: () => new Promise(() => {}) });
    await antes.recuperar();
    const aberta = randomUUID();
    const fechada = randomUUID();
    await pedaco(antes, aberta, 0, 'AAA');
    await pedaco(antes, fechada, 0, 'XXX');
    // Fechada, mas o processo "morre" antes de terminar de processar.
    await antes.finalizar(fechada);

    const finalizadas = [];
    const depois = criarGravacoesEmPedacos({
      pasta,
      log: silencioso,
      aoFinalizar: async (g) => { finalizadas.push({ id: g.id, conteudo: await readFile(g.caminho, 'utf8') }); return true; },
    });
    await depois.recuperar();
    await esperarProcessamento();

    assert.deepEqual(finalizadas, [{ id: fechada, conteudo: 'XXX' }]);
    assert.deepEqual(depois.abertas(), [aberta]);

    await pedaco(depois, aberta, 1, 'BBB');
    await depois.finalizar(aberta);
    await esperarProcessamento();
    assert.deepEqual(finalizadas[1], { id: aberta, conteudo: 'AAABBB' });
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});
