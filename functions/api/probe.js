/**
 * 데이터 출처 탐침 2차  ·  임시 진단용
 *
 * 경로: /api/probe
 *
 * 네이버 업종(섹터) 데이터가 어느 주소에 있는지 찾는다.
 * 읽기만 하고 아무것도 저장하지 않는다. 확인이 끝나면 이 파일은 지운다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TARGETS = [
  { id: 'page_industry', url: 'https://stock.naver.com/market/stock/kr/industry', scan: true },
  { id: 'api_industry_list', url: 'https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100' },
  { id: 'api_industry_bare', url: 'https://m.stock.naver.com/api/industry' },
  { id: 'api_stock_industry', url: 'https://api.stock.naver.com/industry' },
  { id: 'api_stock_industry_list', url: 'https://api.stock.naver.com/industry/list' },
  { id: 'api_market_industry', url: 'https://api.stock.naver.com/market/stock/kr/industry' },
  { id: 'legacy_upjong', url: 'https://finance.naver.com/sise/sise_group.nhn?type=upjong' },
];

async function probe(t) {
  const started = Date.now();
  try {
    const r = await fetch(t.url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'ko-KR,ko;q=0.9',
        accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
        referer: 'https://stock.naver.com/',
      },
      redirect: 'follow',
    });
    const text = await r.text();
    const res = {
      id: t.id,
      status: r.status,
      ms: Date.now() - started,
      type: r.headers.get('content-type'),
      bytes: text.length,
      head: text.slice(0, 260).replace(/\s+/g, ' '),
    };
    if (t.scan) {
      // 페이지 안에 박혀 있는 api 주소와 업종 이름 후보를 뽑아 본다.
      const urls = [...new Set((text.match(/https?:\/\/[a-z0-9.\-]*naver\.com\/[^"'\s<>\\]{3,90}/gi) || []))];
      res.api_urls = urls.filter((u) => /api|json/i.test(u)).slice(0, 25);
      res.paths = [...new Set((text.match(/"\/api\/[^"]{3,70}"/g) || []))].slice(0, 25);
      res.has_next_data = text.includes('__NEXT_DATA__');
      res.sample_kr = (text.match(/[가-힣]{2,10}(?=")/g) || []).slice(0, 30);
    }
    return res;
  } catch (e) {
    return { id: t.id, error: String(e).slice(0, 160), ms: Date.now() - started };
  }
}

export async function onRequestGet() {
  const out = await Promise.all(TARGETS.map(probe));
  return new Response(JSON.stringify(out, null, 1), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
