/**
 * 데이터 출처 탐침 3차  ·  임시 진단용
 *
 * 경로: /api/probe
 *
 * 업종 목록 전체와, 업종 상세(구성 종목) 주소 후보를 확인한다.
 * 확인이 끝나면 이 파일은 지운다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const H = {
  'user-agent': UA,
  'accept-language': 'ko-KR,ko;q=0.9',
  accept: 'application/json,*/*;q=0.8',
  referer: 'https://m.stock.naver.com/',
};

async function get(url) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  return { status: r.status, type: r.headers.get('content-type'), bytes: t.length, text: t };
}

export async function onRequestGet() {
  const out = {};

  // 1. 업종 목록 전체
  try {
    const r = await get('https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=200');
    out.list_status = r.status;
    out.list_bytes = r.bytes;
    const j = JSON.parse(r.text);
    const g = j.groups || [];
    out.group_count = g.length;
    out.group_keys = g.length ? Object.keys(g[0]) : [];
    out.groups_top = g.slice(0, 8);
    out.groups_bottom = g.slice(-4);
    out.sum_stocks = g.reduce((s, x) => s + (x.totalCount || 0), 0);
    out.first_no = g.length ? g[0].no : null;
  } catch (e) {
    out.list_error = String(e).slice(0, 160);
  }

  // 2. 업종 상세(구성 종목) 주소 후보
  const no = out.first_no || 305;
  const cands = [
    `https://m.stock.naver.com/api/stocks/industry/${no}`,
    `https://m.stock.naver.com/api/stocks/industry/${no}/stocks?page=1&pageSize=20`,
    `https://m.stock.naver.com/api/stocks/industry/${no}?page=1&pageSize=20`,
    `https://m.stock.naver.com/api/industry/${no}/basic`,
  ];
  out.detail = [];
  for (const u of cands) {
    try {
      const r = await get(u);
      out.detail.push({ u: u.replace('https://m.stock.naver.com', ''), status: r.status, bytes: r.bytes, head: r.text.slice(0, 200).replace(/\s+/g, ' ') });
    } catch (e) {
      out.detail.push({ u, error: String(e).slice(0, 120) });
    }
  }

  // 3. 코스피 · 코스닥 실시간
  out.index = [];
  for (const code of ['KOSPI', 'KOSDAQ']) {
    try {
      const r = await get(`https://m.stock.naver.com/api/index/${code}/basic`);
      const j = JSON.parse(r.text);
      out.index.push({ code, closePrice: j.closePrice, fluctuationsRatio: j.fluctuationsRatio, compareToPreviousPrice: j.compareToPreviousPrice?.text, localTradedAt: j.localTradedAt });
    } catch (e) {
      out.index.push({ code, error: String(e).slice(0, 120) });
    }
  }

  return new Response(JSON.stringify(out, null, 1), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
