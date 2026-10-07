/**
 * 휴대폰 알림 · 웹 푸시로 구독자 전원에게 보내기
 *
 * 구독은 사이트의 '알림 받기' 버튼이 만든다(functions/api/push.js). 저장소(KV) 'sub:…' 키 하나가 기기 하나다.
 *   sub:… = { endpoint, keys: { p256dh, auth }, prefs: { am, pm, wh, hot, wa }, watch: [업종 이름], watch_no: [업종번호], at }
 * prefs 에서 끈 종류는 그 기기에 보내지 않는다.
 *   am   개장 전 요약 08:37      pm   마감 요약 15:40
 *   wh   큰손 공시 요약 18:30    hot  아주 큰 큰손 공시, 들어오는 즉시
 *   wa   관심 업종 소식. 그 기기가 관심으로 둔 업종이 마감 상위에 들거나 큰손 공시가 났을 때
 * 푸시 서버가 404 · 410 을 주면 구독이 끝난 것이라 지운다.
 *
 * 한 기기에 한 번 보낼 때마다 바깥 요청이 하나 든다. 무료 요금제는 한 번 돌 때 50개까지라,
 * 구독자가 수십 명을 넘으면 나눠 보내는 방식으로 바꿔야 한다.
 */

import { loadVapid, sendPush } from './webpush.js';

export async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.FLOW.list({ prefix: 'sub:', cursor });
    for (const k of r.keys) {
      const v = await env.FLOW.get(k.name, 'json');
      if (v && v.endpoint && v.keys) out.push([k.name, v]);
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

/** kind 를 켜 둔 구독자에게만 보낸다. subs 를 넘기면 다시 읽지 않는다 */
export async function pushAll(env, kind, msg, subs) {
  const vapid = await loadVapid(env);
  if (!vapid) return { n: 0, sent: 0, gone: 0, fail: 0, why: 'VAPID 키 없음' };
  const list = (subs || (await listSubs(env))).filter(([, s]) => !s.prefs || s.prefs[kind] !== false);
  let sent = 0, gone = 0, fail = 0;
  for (const [key, s] of list) {
    try {
      const st = await sendPush(vapid, s, msg);
      if (st === 404 || st === 410) {
        gone++;
        await env.FLOW.delete(key);
      } else if (st >= 200 && st < 300) sent++;
      else fail++;
    } catch (e) {
      fail++;
    }
  }
  return { n: list.length, sent, gone, fail };
}

/** 기기마다 다른 글. make(sub) 가 null 을 주면 그 기기는 건너뛴다 */
export async function pushEach(env, kind, subs, make) {
  const vapid = await loadVapid(env);
  if (!vapid) return { n: 0, sent: 0, gone: 0, fail: 0, why: 'VAPID 키 없음' };
  let n = 0, sent = 0, gone = 0, fail = 0;
  for (const [key, s] of subs) {
    if (s.prefs && s.prefs[kind] === false) continue;
    const msg = make(s);
    if (!msg) continue;
    n++;
    try {
      const st = await sendPush(vapid, s, msg);
      if (st === 404 || st === 410) {
        gone++;
        await env.FLOW.delete(key);
      } else if (st >= 200 && st < 300) sent++;
      else fail++;
    } catch (e) {
      fail++;
    }
  }
  return { n, sent, gone, fail };
}

export const pushNote = (r) =>
  r.why ? '휴대폰 ' + r.why : r.n ? `휴대폰 ${r.sent}/${r.n}` + (r.gone ? ` · 끝난 구독 ${r.gone} 지움` : '') + (r.fail ? ` · 실패 ${r.fail}` : '') : '휴대폰 구독 없음';
