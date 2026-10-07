/**
 * 휴대폰 알림 구독  ·  Cloudflare Pages Function
 *
 *   GET    /api/push              웹 푸시 공개키 { key }
 *   POST   /api/push  { sub, prefs, watch }   구독하기 · 받을 종류와 관심 업종 바꾸기. 처음이면 '켜졌습니다' 알림을 보낸다
 *   POST   /api/push  { sub, test: true }     이 기기로 시험 알림 (30초에 한 번)
 *   DELETE /api/push  { endpoint }            구독 끊기
 *
 * 구독 정보는 저장소(KV) 'sub:…' 에 기기마다 하나씩 둔다. 보내기는 예약 실행기가 한다(worker/push.js).
 * prefs  am 개장 전 · pm 마감 · wh 큰손 요약 · hot 아주 큰 큰손 공시 · wa 관심 업종 소식
 * watch  관심 업종 이름 목록(최대 20개). watch_no 는 같은 순서의 네이버 업종번호. 화면의 관심 목록이 바뀔 때마다 같이 온다
 */

import { loadVapid, sendPush, subKey } from '../../worker/webpush.js';

const KINDS = ['am', 'pm', 'wh', 'hot', 'wa'];
const cleanWatch = (w) => (Array.isArray(w) ? w.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 20) : []);
const cleanNos = (w) => (Array.isArray(w) ? w.map(Number).filter((x) => x > 0 && x < 10000).slice(0, 20) : []);
const J = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/** 브라우저 푸시 서버 주소만 받는다(구글 FCM · 애플 · 모질라 · 마이크로소프트 등) */
function okEndpoint(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(push|fcm|notify)/i.test(x.hostname) && u.length < 1000;
  } catch (e) {
    return false;
  }
}

const cleanPrefs = (p) => Object.fromEntries(KINDS.map((k) => [k, !(p && p[k] === false)]));

const WELCOME = {
  title: '알림이 켜졌습니다',
  body: '평일 08:37 개장 전 · 15:40 마감 · 18:30 큰손 요약이 이렇게 옵니다. 아주 큰 큰손 공시는 들어오는 즉시 울립니다.',
  url: '/',
  tag: 'welcome',
};

export async function onRequestGet({ env }) {
  const v = await loadVapid(env);
  return v ? J({ key: v.pub }) : J({ error: '알림 키가 아직 없습니다' }, 503);
}

export async function onRequestPost({ request, env }) {
  let b;
  try {
    b = await request.json();
  } catch (e) {
    return J({ error: '요청이 이상합니다' }, 400);
  }
  const sub = (b && b.sub) || {};
  if (!sub.endpoint || !okEndpoint(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return J({ error: '구독 정보가 이상합니다' }, 400);
  }
  const vapid = await loadVapid(env);
  if (!vapid) return J({ error: '알림 키가 아직 없습니다' }, 503);
  const key = await subKey(sub.endpoint);
  const cur = await env.FLOW.get(key, 'json');

  if (b.test) {
    if (!cur) return J({ error: '이 기기는 구독돼 있지 않습니다' }, 404);
    if (cur.tested && Date.now() - cur.tested < 30000) return J({ error: '30초 뒤에 다시 눌러 주세요' }, 429);
    cur.tested = Date.now();
    await env.FLOW.put(key, JSON.stringify(cur));
    const st = await sendPush(vapid, cur, {
      title: '시험 알림',
      body: '알림이 잘 옵니다. 평일 08:37 · 15:40 · 18:30, 아주 큰 큰손 공시는 바로 옵니다.',
      url: '/',
      tag: 'test',
    });
    if (st === 404 || st === 410) await env.FLOW.delete(key);
    return J({ ok: st >= 200 && st < 300, status: st });
  }

  const rec = {
    endpoint: sub.endpoint,
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
    prefs: cleanPrefs(b.prefs),
    watch: 'watch' in b ? cleanWatch(b.watch) : (cur && cur.watch) || [],
    watch_no: 'watch' in b ? cleanNos(b.watch_no) : (cur && cur.watch_no) || [],
    at: (cur && cur.at) || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '),
  };
  await env.FLOW.put(key, JSON.stringify(rec));
  if (cur) return J({ ok: true, isNew: false });
  const st = await sendPush(vapid, rec, WELCOME);
  if (st === 404 || st === 410) {
    await env.FLOW.delete(key);
    return J({ ok: false, error: '푸시 서버가 이 구독을 거절했습니다', status: st }, 502);
  }
  return J({ ok: st >= 200 && st < 300, isNew: true, status: st });
}

export async function onRequestDelete({ request, env }) {
  let b = {};
  try {
    b = await request.json();
  } catch (e) {}
  if (!b.endpoint) return J({ error: '구독 주소가 없습니다' }, 400);
  await env.FLOW.delete(await subKey(b.endpoint));
  return J({ ok: true });
}
