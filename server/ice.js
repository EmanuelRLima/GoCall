import { createHmac } from 'crypto';

// Só STUN resolve quando pelo menos um dos lados tem um caminho direto até o
// outro. Rede de empresa, 4G com CGNAT e Wi-Fi de hospital costumam não ter:
// o par de candidatos nunca fecha, o tile aparece (o ontrack chega com a
// descrição remota, antes de qualquer pacote) e fica preto. O TURN é o
// servidor que repassa a mídia quando o caminho direto não existe.
const STUN_PADRAO = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

// 24h: a credencial vale para a alocação inteira, e o coturn confere a
// validade também na renovação. Mais curta, uma chamada longa perderia o
// relay no meio.
const VALIDADE_PADRAO_S = 24 * 60 * 60;

function listaDoEnv(valor) {
  return String(valor || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Monta a lista de iceServers a partir do ambiente.
 *
 *  - TURN_URLS: separados por vírgula (turn:host:3478?transport=udp,turns:host:5349...).
 *  - TURN_SECRET: segredo compartilhado do coturn (use-auth-secret). Gera a
 *    credencial temporária da "TURN REST API": usuário = validade:rótulo,
 *    senha = base64(HMAC-SHA1(segredo, usuário)). Nada fixo vai ao navegador.
 *  - TURN_USERNAME / TURN_CREDENTIAL: credencial fixa, para provedor que
 *    entrega usuário e senha prontos. Vale só se não houver TURN_SECRET.
 */
export function montarServidoresIce(env = process.env, agoraMs = Date.now()) {
  const stun = listaDoEnv(env.STUN_URLS);
  const servidores = [{ urls: stun.length ? stun : STUN_PADRAO }];

  const urlsTurn = listaDoEnv(env.TURN_URLS);
  if (!urlsTurn.length) return servidores;

  if (env.TURN_SECRET) {
    const validade = Number(env.TURN_TTL_SEGUNDOS) > 0 ? Number(env.TURN_TTL_SEGUNDOS) : VALIDADE_PADRAO_S;
    const expiraEm = Math.floor(agoraMs / 1000) + validade;
    const username = `${expiraEm}:gocall`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    servidores.push({ urls: urlsTurn, username, credential });
  } else if (env.TURN_USERNAME) {
    servidores.push({ urls: urlsTurn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL || '' });
  }

  return servidores;
}

export function temTurn(servidores) {
  return servidores.some(s => [].concat(s.urls).some(u => /^turns?:/.test(u)));
}
