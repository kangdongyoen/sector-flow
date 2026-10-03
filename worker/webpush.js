/**
 * 웹 푸시 보내기  ·  예약 실행기(cron.js)와 사이트 함수(functions/api/push.js)가 같이 쓴다
 *
 * 휴대폰 브라우저가 '알림 받기'를 누르면 구독 정보(주소 · 공개키 · 인증값)를 준다.
 * 그 주소(구글 FCM · 애플 · 모질라 푸시 서버)로 암호화한 글을 보내면 휴대폰이 울린다.
 *   암호화   RFC 8291 (aes128gcm)
 *   신원 증명 RFC 8292 (VAPID, ES256 서명)
 * 따로 깔 앱도 계정도 필요 없다. 외부 라이브러리 없이 Web Crypto 만 쓴다.
 *
 * VAPID 키는 저장소(KV) 'vapid' 키에 둔다. 공개 저장소(GitHub)에는 비밀 키를 적지 않는다.
 *   vapid = { "pub": 공개키(base64url, 65바이트), "jwk": 비밀키 JWK, "sub": "https://…" }
 */

const te = new TextEncoder();

export function b64uEnc(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDec(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** RFC 8291. 받는 쪽 공개키(p256dh) · 인증값(auth)으로 한 덩어리(record)짜리 암호문을 만든다 */
export async function encrypt(p256dh, auth, plaintext) {
  const ua = b64uDec(p256dh);
  const authSecret = b64uDec(auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 마지막(이자 유일한) 덩어리 표시 0x02 를 붙인다
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 덩어리 크기 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

let cached = null;

/** 저장소에서 VAPID 키를 꺼내 서명 키로 만든다. 한 번 만들면 재사용 */
export async function loadVapid(env) {
  if (cached) return cached;
  const v = await env.FLOW.get('vapid', 'json');
  if (!v || !v.pub || !v.jwk) return null;
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cached = { pub: v.pub, key, sub: v.sub || 'https://lucent-sector.pages.dev' };
  return cached;
}

/** RFC 8292. 푸시 서버에 '우리가 보낸 것'임을 증명하는 서명 */
export async function vapidHeader(vapid, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64uEnc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEnc(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.sub })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapid.key, te.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64uEnc(sig)}, k=${vapid.pub}`;
}

/**
 * 구독 하나에 글 하나. 푸시 서버의 응답 코드를 돌려준다.
 *   201 · 200  받음
 *   404 · 410  구독이 끝남(앱 삭제, 알림 끔). 지워야 한다
 * msg = { title, body, url, tag, hot }
 */
export async function sendPush(vapid, sub, msg, opt = {}) {
  const payload = te.encode(JSON.stringify(msg).slice(0, 3000));
  const body = await encrypt(sub.keys.p256dh, sub.keys.auth, payload);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidHeader(vapid, sub.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opt.ttl || 12 * 3600),
      urgency: opt.urgency || (msg.hot ? 'high' : 'normal'),
    },
    body,
  });
  return r.status;
}

/** 저장소 키 이름. 구독 주소를 해시해서 쓴다 */
export async function subKey(endpoint) {
  const h = await crypto.subtle.digest('SHA-256', te.encode(endpoint));
  return 'sub:' + [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
