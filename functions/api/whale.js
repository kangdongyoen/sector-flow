/**
 * 큰손 움직임  ·  Cloudflare Pages Function
 *
 * 경로
 *   /api/whale          눈여겨볼 공시만 (홈 '큰손 움직임')
 *   /api/whale?no=278   그 업종 종목의 공시 전부 (상세 화면 '이 업종 큰손')
 *
 * 목록은 예약 실행기(lucent-sector-cron)가 10분마다 DART 에서 모아 저장소(KV)에 넣는다.
 * 여기서는 읽어서 걸러 주기만 한다. 숫자는 공시 원문 그대로다.
 *
 * '눈여겨볼' 기준 (hi)
 *   5%   매수 · 매도 · 시간외 · 공개매수 · 증자처럼 돈이 오간 변동이면서
 *        0.5%p 이상 바뀌었거나, 새로 5%를 넘었거나, 5% 아래로 내려간 것
 *   임원  장내 · 시간외 매매 합계 1억원 이상
 */

const H = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const no = Number((url.searchParams.get('no') || '').replace(/\D/g, '')) || 0;
  const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 20, 1), 60);

  const cache = caches.default;
  const key = new Request(`${url.origin}/api/whale?no=${no}&n=${n}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const kv = context.env && context.env.FLOW;
  if (!kv) {
    return new Response(JSON.stringify({ error: '저장소 없음', items: [] }), {
      status: 500,
      headers: Object.assign({ 'cache-control': 'no-store' }, H),
    });
  }
  const [cur, at] = await Promise.all([kv.get('whale:v1', 'json'), kv.get('whale:at', 'json')]);
  const all = (cur && cur.items) || [];
  // 업종 화면은 그 업종 공시 전부. 다만 0.1%p 도 안 되는 지분 변동은 뺀다(대주주 가족 소량 매매가 줄을 채운다)
  const worth = (x) => x.k === 'in' || x.hi || /신규/.test(x.kind || '') || Math.abs(x.d || 0) >= 0.1;
  const pick = no ? all.filter((x) => x.no === no && worth(x)) : all.filter((x) => x.hi);
  const oldest = all.length ? all[all.length - 1].day : null;

  const body = {
    updated: (cur && cur.updated) || null,
    checked: (at && at.at) || (cur && cur.updated) || null,
    since: oldest,
    total: pick.length,
    items: pick.slice(0, n),
  };
  const res = new Response(JSON.stringify(body), {
    headers: Object.assign({ 'cache-control': 'public, max-age=120' }, H),
  });
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
