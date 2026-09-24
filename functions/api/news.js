/**
 * 경제 헤드라인  ·  Cloudflare Pages Function
 *
 * 경로
 *   /api/news                     네이버 증권 '주요 뉴스' 제목 (홈 '오늘 체크' 칸)
 *   /api/news?no=305&name=반도체   그 업종과 이름이 겹치는 제목 (상세 화면 '관련 헤드라인')
 *
 * 제목 · 언론사 · 시각 · 원문 주소만 돌려준다. 기사 본문과 요약은 옮기지 않는다.
 * 업종 제목은 '참고'다. 업종이 오르고 내린 이유로 쓰지 않는다.
 *
 * 업종 제목 고르는 법
 *   1. 업종 구성 종목 중 시가총액 큰 3개의 종목 뉴스
 *   2. 네이버 증권 실시간 속보 · 주요 뉴스
 *   이 둘을 모은 뒤, 제목에 업종 이름이나 시가총액 상위 종목 이름이 들어간 것만 남긴다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = {
  'user-agent': UA,
  'accept-language': 'ko-KR,ko;q=0.9',
  accept: 'application/json,*/*;q=0.8',
  referer: 'https://m.stock.naver.com/',
};
const BASE = 'https://m.stock.naver.com';

/** 업종 이름을 쪼갰을 때 너무 흔해서 아무 제목에나 걸리는 말 */
const STOP = new Set(['부품', '장비', '제품', '서비스', '기타', '용품', '소재', '기기', '관련', '산업', '업종', '기업']);

const numOf = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

const clean = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** 네이버 시각 '202609240913' 또는 '20260924091307' → '2026-09-24T09:13' (한국시간) */
const when = (dt) => {
  const s = String(dt || '');
  if (s.length < 12) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}`;
};

const item = (it) => ({
  t: clean(it.titleFull || it.title),
  src: clean(it.officeName),
  at: when(it.datetime),
  url: it.mobileNewsUrl || `https://n.news.naver.com/mnews/article/${it.officeId}/${it.articleId}`,
  id: `${it.officeId}/${it.articleId}`,
});

async function getJSON(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(r.status + ' ' + url.slice(BASE.length, BASE.length + 40));
  return r.json();
}

/** 네이버 증권 뉴스 묶음. mainnews 주요 뉴스 · flashnews 실시간 속보 */
async function category(cat, size) {
  const j = await getJSON(`${BASE}/front-api/news/category?category=${cat}&pageSize=${size}&page=1`);
  return (Array.isArray(j.result) ? j.result : []).map(item).filter((x) => x.t);
}

/** 종목 뉴스. 비슷한 기사는 묶여서 오므로 묶음마다 맨 앞 하나만 쓴다. */
async function stockNews(code, size) {
  const j = await getJSON(`${BASE}/api/news/stock/${code}?pageSize=${size}&page=1`);
  const out = [];
  for (const c of Array.isArray(j) ? j : []) {
    const it = c && c.items && c.items[0];
    if (it) out.push(item(it));
  }
  return out.filter((x) => x.t);
}

/** 제목이 거의 같은 기사(언론사만 다른 것)는 하나만 남긴다 */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const k1 = x.id;
    const k2 = x.t.replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, 16);
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1);
    seen.add(k2);
    out.push(x);
  }
  return out;
}

/** 종목 이름에서 제목에 실제로 쓰이는 꼴을 뽑는다. SK하이닉스 → SK하이닉스 · 하이닉스 */
function nameTokens(n) {
  const out = new Set();
  const base = n.replace(/우B?$/, '').trim();
  if (base.length >= 2) out.add(base);
  const m = base.match(/^[A-Za-z&]+(.+)$/);
  if (m && m[1].length >= 3 && !STOP.has(m[1])) out.add(m[1]);
  return [...out];
}

function sectorTokens(name) {
  return String(name || '')
    .split(/와|및|·|,|\/|\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !STOP.has(x));
}

async function headlines() {
  const items = dedupe(await category('mainnews', 20)).slice(0, 10);
  return { source: '네이버 증권 주요 뉴스', items };
}

async function sectorHeadlines(no, name) {
  const j = await getJSON(`${BASE}/api/stocks/industry/${no}`);
  const stocks = (j.stocks || [])
    .map((s) => ({ code: s.itemCode, name: s.stockName, cap: numOf(s.marketValue) || 0 }))
    .filter((s) => s.code && s.name)
    .sort((a, b) => b.cap - a.cap);

  const big = stocks.slice(0, 6);
  const tokens = [];
  for (const s of big) for (const t of nameTokens(s.name)) tokens.push({ t, tag: s.name });
  for (const t of sectorTokens(name)) tokens.push({ t, tag: null });

  const pools = await Promise.allSettled([
    ...big.slice(0, 3).map((s) => stockNews(s.code, 8)),
    category('flashnews', 50),
    category('mainnews', 20),
  ]);
  const pool = [];
  for (const p of pools) if (p.status === 'fulfilled') pool.push(...p.value);

  // 나흘 넘은 제목은 뺀다
  const k = new Date(Date.now() + 9 * 3600 * 1000 - 4 * 86400 * 1000).toISOString().slice(0, 16);
  const hits = [];
  for (const x of pool) {
    if (x.at && x.at < k) continue;
    const m = tokens.find((tk) => x.t.includes(tk.t));
    if (m) hits.push(Object.assign({}, x, { tag: m.tag || m.t }));
  }
  hits.sort((a, b) => (a.at < b.at ? 1 : -1));
  return { no: Number(no), name, source: '네이버 증권', items: dedupe(hits).slice(0, 4) };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const no = (url.searchParams.get('no') || '').replace(/\D/g, '');
  const name = (url.searchParams.get('name') || '').trim().slice(0, 40);

  const cache = caches.default;
  const key = new Request(`${url.origin}/api/news${no ? '?no=' + no : ''}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  let body;
  try {
    body = no ? await sectorHeadlines(no, name) : await headlines();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 120), items: [] }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  body.updated = k.toISOString().slice(0, 16);

  const maxAge = no ? 1200 : 600;
  const res = new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'access-control-allow-origin': '*',
    },
  });
  // 빈 결과는 짧게만 기억한다. 잠깐 막혔던 것일 수 있다.
  if (body.items.length) context.waitUntil(cache.put(key, res.clone()));
  return res;
}
