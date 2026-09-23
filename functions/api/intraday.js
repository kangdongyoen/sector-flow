/**
 * 업종 하루 흐름  ·  Cloudflare Pages Function
 *
 * 경로: /api/intraday?name=항공사
 *
 * 예약 실행기(worker/cron.js)가 장중 10분마다 저장소에 찍어 둔 업종 등락률을
 * 한 업종만 골라 시간 순서대로 돌려준다. 상세 화면의 '오늘 흐름' 선이 이걸 그린다.
 * 오늘 기록이 아직 없으면(개장 전 · 휴장일) 가장 최근 거래일 것을 준다.
 */

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const name = (url.searchParams.get('name') || '').trim();
  const kv = context.env && context.env.FLOW;
  if (!name || !kv) return json({ error: name ? 'no_store' : 'no_name' }, 400);

  const k = new Date(Date.now() + 9 * 3600 * 1000);
  let day = null, intra = null;
  for (let i = 0; i < 6 && !intra; i++) {
    day = k.toISOString().slice(0, 10);
    intra = await kv.get('intra:' + day, 'json');
    k.setUTCDate(k.getUTCDate() - 1);
  }
  if (!intra || !Array.isArray(intra.snaps)) return json({ name, day: null, points: [] });

  const points = [];
  for (const sn of intra.snaps) {
    const v = sn.s ? sn.s[name] : undefined;
    if (typeof v === 'number') points.push({ t: sn.t, v });
  }
  return json({ name, day, points }, 200, 60);
}

function json(o, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(o), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  });
}
