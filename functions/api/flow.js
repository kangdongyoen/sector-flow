/**
 * 업종별 수급  ·  Cloudflare Pages Function
 *
 *   /api/flow            마지막으로 다 받은 날 (또는 오늘 받는 중인 것)
 *   /api/flow?day=2026-10-07
 *
 * 예약 실행기가 마감 뒤 네이버 '투자자별 매매동향'을 업종마다 시가총액 큰 종목 4~8개씩 받아 합친 것(worker/flow.js).
 * 금액은 순매수 수량 × 종가라서 추정치다. 응답의 note 에 그 말을 넣어 두고 화면이 그대로 보여 준다.
 */

import { rankFlow } from '../../worker/flow.js';

const H = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
const J = (o, status = 200, cc = 'public, max-age=120') => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'cache-control': cc }, H) });

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('day') || '').slice(0, 10);
  const kv = context.env && context.env.FLOW;
  if (!kv) return J({ error: '저장소 없음' }, 500, 'no-store');

  const cache = caches.default;
  const key = new Request(`${url.origin}/api/flow?day=${q}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null;
  let flow = day ? await kv.get('flow:' + day, 'json') : null;
  let partial = false;
  if (!day) {
    // 오늘 받는 중이면 그것을, 아니면 마지막으로 다 받은 날
    const cur = await kv.get('flow:' + today, 'json');
    if (cur && cur.done >= Math.max(40, cur.need * 0.6)) {
      flow = cur;
      day = today;
      partial = !cur.complete;
    } else {
      day = await kv.get('flow:latest');
      flow = day ? await kv.get('flow:' + day, 'json') : null;
    }
  }
  if (!flow) return J({ day: null, items: null, note: '아직 받은 수급이 없습니다. 평일 마감 뒤 16시부터 쌓입니다.' }, 200, 'no-store');

  const sectors = {};
  for (const [no, s] of Object.entries(flow.sectors || {})) {
    const m = (flow.meta && flow.meta[no]) || {};
    sectors[no] = { name: m.name || '', f: s.f, i: s.i, p: s.p, n: s.n, k: m.k || s.n, cov: m.cov || null, top: s.top };
  }
  const body = {
    day,
    partial,
    done: flow.done,
    need: flow.need,
    at: flow.at || null,
    f: rankFlow(flow, 'f', 8),
    i: rankFlow(flow, 'i', 8),
    p: rankFlow(flow, 'p', 8),
    sectors,
    note: '업종마다 시가총액 큰 종목 4~8개(시총 70% 안팎)를 합친 값입니다. 금액은 순매수 수량 × 종가라 추정치입니다. 네이버 증권 투자자별 매매동향.',
  };
  const res = J(body, 200, partial ? 'public, max-age=60' : 'public, max-age=300');
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
