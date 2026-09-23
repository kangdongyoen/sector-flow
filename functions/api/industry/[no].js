/**
 * 업종 구성 종목  ·  Cloudflare Pages Function
 *
 * 경로: /api/industry/305
 *
 * 상세 화면의 '종목' 탭에서만 부른다. 목록을 보여줄 뿐 추천하지 않는다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const numOf = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

export async function onRequestGet(context) {
  const no = String(context.params.no || '').replace(/\D/g, '');
  if (!no) return new Response(JSON.stringify({ error: 'bad no' }), { status: 400 });

  const cache = caches.default;
  const url = new URL(context.request.url);
  const key = new Request(`${url.origin}/api/industry/${no}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  let stocks = [];
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stocks/industry/${no}`, {
      headers: {
        'user-agent': UA,
        'accept-language': 'ko-KR,ko;q=0.9',
        accept: 'application/json,*/*;q=0.8',
        referer: 'https://m.stock.naver.com/',
      },
    });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const j = await r.json();
    stocks = (j.stocks || []).map((s) => ({
      code: s.itemCode,
      name: s.stockName,
      price: numOf(s.closePrice),
      chg: numOf(s.fluctuationsRatio),
      cap: numOf(s.marketValue),
    }));
    // 하루 가격제한폭(±30%) 밖이면 상장 첫날이나 거래 재개 종목이다. 업종 계산에서 뺀다.
    for (const s of stocks) if (s.chg !== null && Math.abs(s.chg) > 30) s.out = true;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 120) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  stocks.sort((a, b) => (b.chg ?? -99) - (a.chg ?? -99));

  const res = new Response(JSON.stringify({ no: Number(no), stocks }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=30',
      'access-control-allow-origin': '*',
    },
  });
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
