/**
 * 데이터 출처 탐침  ·  임시 진단용
 *
 * 경로: /api/probe
 *
 * Cloudflare 쪽에서 어떤 시세 출처가 열려 있는지 확인만 한다.
 * 읽기만 하고 아무것도 저장하지 않는다. 확인이 끝나면 이 파일은 지운다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TARGETS = [
  {
    id: 'naver_upjong_html',
    url: 'https://finance.naver.com/sise/sise_group.naver?type=upjong',
    headers: { referer: 'https://finance.naver.com/' },
  },
  {
    id: 'naver_poll_stock',
    url: 'https://polling.finance.naver.com/api/realtime/domestic/stock/005930',
    headers: { referer: 'https://finance.naver.com/' },
  },
  {
    id: 'naver_m_index',
    url: 'https://m.stock.naver.com/api/index/KOSPI/basic',
    headers: { referer: 'https://m.stock.naver.com/' },
  },
  {
    id: 'naver_m_stock',
    url: 'https://m.stock.naver.com/api/stock/005930/basic',
    headers: { referer: 'https://m.stock.naver.com/' },
  },
  {
    id: 'daum_sectors',
    url: 'https://finance.daum.net/api/sectors?page=1&perPage=100&fieldName=changeRate&order=desc',
    headers: { referer: 'https://finance.daum.net/domestic/sectors', 'x-requested-with': 'XMLHttpRequest' },
  },
  {
    id: 'krx_dbms',
    url: 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd',
    method: 'POST',
    headers: {
      referer: 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020506',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'bld=dbms/MDC/STAT/standard/MDCSTAT00601&locale=ko_KR&idxIndMidclssCd=02&trdDd=20260922&share=1&money=1&csvxls_isNo=false',
  },
];

async function probe(t) {
  const started = Date.now();
  try {
    const r = await fetch(t.url, {
      method: t.method || 'GET',
      headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', ...(t.headers || {}) },
      body: t.body,
      redirect: 'manual',
    });
    const text = await r.text();
    return {
      id: t.id,
      status: r.status,
      ms: Date.now() - started,
      type: r.headers.get('content-type'),
      location: r.headers.get('location'),
      bytes: text.length,
      head: text.slice(0, 220).replace(/\s+/g, ' '),
    };
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
