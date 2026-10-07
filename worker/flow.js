/**
 * 업종별 수급 · 외국인 · 기관 · 개인이 오늘 어느 업종을 사고팔았나  (lucent-sector-cron 안에서 돈다)
 *
 * 네이버는 종목마다 '투자자별 순매수 수량'을 날짜별로 준다. 업종 단위로는 주지 않는다.
 * 그래서 업종마다 시가총액 큰 종목 몇 개(시총 70% 를 덮을 때까지, 4~8개)를 받아 합친다.
 *   금액 = 순매수 수량 × 그날 종가.  평균 체결가가 아니라 종가라서 '추정'이다. 화면에 그렇게 적는다.
 *
 * 하루 376개 안팎의 종목을 받아야 한다. 무료 요금제는 한 번 돌 때 바깥 요청 50개까지라
 * 마감 뒤 10분마다 조금씩(fetchFlow 의 budget 만큼) 받아 나간다. 17시 반쯤 다 찬다.
 *
 * 저장소(KV)
 *   flow:members   업종 → 받을 종목 목록. 7일마다 refreshMembers 가 새로 짠다
 *   flow:날짜      그날 결과. { day, done, need, sectors: { 업종번호: { f, i, p, n, top: [...] } } }  (f 외국인 · i 기관 · p 개인, 억원)
 *   flow:latest    마지막으로 다 받은 날짜
 */

const NAVER = 'https://m.stock.naver.com';
const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  referer: NAVER + '/',
  accept: 'application/json',
};

let F = (u, i) => fetch(u, i);
export const setFetch = (f) => {
  F = f;
};

/** 네이버 업종 '기타'는 ETF · ETN 꾸러미(인버스 · 레버리지 · 해외지수)라 업종이 아니다. 수급에서 뺀다 */
export const skipSector = (name) => name === '기타';

const num = (v) => {
  const n = parseFloat(String(v === null || v === undefined ? '' : v).replace(/[,+%]/g, ''));
  return isFinite(n) ? n : 0;
};

async function getJSON(url) {
  const r = await F(url, { headers: H });
  if (!r.ok) throw new Error(r.status + ' ' + url.replace(NAVER, '').slice(0, 40));
  return r.json();
}

/* ── 종목 목록 ── */

/** 업종 하나의 구성 종목 전부(시총 순). 100개씩 끊어서 온다 */
async function readMembers(no, budget) {
  const all = [];
  for (let page = 1; page <= 3 && budget.n > 0; page++) {
    budget.n--;
    const j = await getJSON(`${NAVER}/api/stocks/industry/${no}?page=${page}&pageSize=100`);
    const got = j.stocks || [];
    all.push(...got);
    if (got.length < 100 || all.length >= (Number(j.totalCount) || 0)) break;
  }
  return all
    .map((s) => ({ code: s.itemCode, name: s.stockName, cap: num(s.marketValue) }))
    .filter((s) => s.code && s.name)
    .sort((a, b) => b.cap - a.cap);
}

/** 시총 70% 를 덮을 때까지, 적어도 4개 많아야 8개 */
export function pickTop(rows) {
  const cap = rows.reduce((a, x) => a + x.cap, 0);
  const top = [];
  let acc = 0;
  for (const x of rows) {
    top.push(x);
    acc += x.cap;
    if (top.length >= 4 && (acc >= 0.7 * cap || top.length >= 8)) break;
  }
  return { top, cap, cov: cap ? Math.round((acc / cap) * 100) : 0 };
}

/**
 * 업종 목록을 조금씩 새로 짠다. sectors 는 /api/live 의 업종 배열([{no, name}]).
 * 한 번에 budget 만큼만 받고, 다 돌면 at 을 찍는다. 7일이 지나야 다시 시작한다.
 */
export async function refreshMembers(env, sectors, budget) {
  const cur = (await env.FLOW.get('flow:members', 'json')) || { sectors: {} };
  const fresh = cur.at && Date.now() - Date.parse(cur.at) < 7 * 86400 * 1000;
  if (fresh && !cur.building) return { skipped: true };
  const b = cur.building || { done: [] };
  let n = 0;
  for (const s of sectors) {
    if (budget.n < 3) break;
    if (b.done.includes(s.no)) continue;
    if (skipSector(s.name)) {
      b.done.push(s.no);
      continue;
    }
    try {
      const rows = await readMembers(s.no, budget);
      const { top, cap, cov } = pickTop(rows);
      cur.sectors[s.no] = { name: s.name, total: rows.length, cap, cov, top };
      b.done.push(s.no);
      n++;
    } catch (e) {
      b.err = String(e.message || e).slice(0, 80);
    }
  }
  const finished = sectors.every((s) => b.done.includes(s.no));
  if (finished) {
    cur.at = new Date().toISOString();
    delete cur.building;
  } else cur.building = b;
  await env.FLOW.put('flow:members', JSON.stringify(cur));
  return { got: n, left: sectors.length - b.done.length, finished };
}

/* ── 그날 수급 받기 ── */

/**
 * day(YYYY-MM-DD)의 수급을 budget 만큼 더 받는다. 종목마다 네이버 '투자자별 매매동향' 한 번.
 * 그 종목의 맨 앞 줄 날짜가 day 가 아니면(아직 안 나왔으면) 건너뛰고 다음 차례에 다시 본다.
 * opts.giveUp 이 켜진 뒤(17:30 지나서) 세 번(30분) 봐도 안 나오는 종목은 거래정지 같은 것이라 치고 빼고 간다.
 * 그래야 그날 결과가 '다 받음'이 된다. 그 전에는 네이버가 아직 그날 것을 안 내놨을 수 있어 세지 않는다.
 */
const GIVE_UP = 3;
export async function fetchFlow(env, day, budget, opts = {}) {
  const mem = await env.FLOW.get('flow:members', 'json');
  if (!mem || !mem.sectors || !Object.keys(mem.sectors).length) return { why: '종목 목록 없음' };
  const key = 'flow:' + day;
  const cur = (await env.FLOW.get(key, 'json')) || { day, done: 0, need: 0, got: {}, miss: {}, sectors: {} };
  cur.miss = cur.miss || {};
  const bz = day.replace(/-/g, '');
  const all = [];
  for (const no of Object.keys(mem.sectors)) {
    if (skipSector(mem.sectors[no].name)) continue;
    for (const s of mem.sectors[no].top) all.push({ no, s });
  }
  cur.need = all.length;
  let n = 0, miss = 0, err = 0;
  for (const { no, s } of all) {
    if (budget.n < 1) break;
    if (cur.got[s.code] || (cur.miss[s.code] || 0) >= GIVE_UP) continue;
    budget.n--;
    try {
      const j = await getJSON(`${NAVER}/api/stock/${s.code}/trend?page=1&pageSize=1`);
      const row = Array.isArray(j) ? j[0] : null;
      if (!row || String(row.bizdate) !== bz) {
        miss++;
        if (opts.giveUp) cur.miss[s.code] = (cur.miss[s.code] || 0) + 1;
        continue;
      }
      const px = num(row.closePrice);
      // 억원. 수량 × 종가
      const f = (num(row.foreignerPureBuyQuant) * px) / 1e8;
      const i = (num(row.organPureBuyQuant) * px) / 1e8;
      const p = (num(row.individualPureBuyQuant) * px) / 1e8;
      cur.got[s.code] = 1;
      const sec = cur.sectors[no] || (cur.sectors[no] = { f: 0, i: 0, p: 0, n: 0, top: [] });
      sec.f = Math.round((sec.f + f) * 10) / 10;
      sec.i = Math.round((sec.i + i) * 10) / 10;
      sec.p = Math.round((sec.p + p) * 10) / 10;
      sec.n++;
      sec.top.push({ code: s.code, name: s.name, f: Math.round(f * 10) / 10, i: Math.round(i * 10) / 10 });
      n++;
    } catch (e) {
      err++;
    }
  }
  cur.done = Object.keys(cur.got).length;
  cur.at = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  // 종목 목록이 바뀌었을 때 쓰라고 업종 이름 · 덮는 비율도 같이 둔다
  cur.meta = Object.fromEntries(Object.entries(mem.sectors).map(([no, m]) => [no, { name: m.name, cov: m.cov, k: m.top.length }]));
  const gone = Object.values(cur.miss).filter((c) => c >= GIVE_UP).length;
  const complete = cur.done + gone >= cur.need;
  cur.complete = complete;
  await env.FLOW.put(key, JSON.stringify(cur), { expirationTtl: 45 * 86400 });
  if (complete) await env.FLOW.put('flow:latest', day);
  return { got: n, done: cur.done, need: cur.need, miss, gone, err, complete };
}

/** 어느 날의 결과. 없으면 null */
export const readFlow = (env, day) => env.FLOW.get('flow:' + day, 'json');

/** 상위 · 하위 업종 n개씩. who: 'f' | 'i' | 'p' */
export function rankFlow(flow, who, n = 5) {
  const rows = Object.entries(flow.sectors || {})
    .map(([no, s]) => ({ no: Number(no), name: (flow.meta && flow.meta[no] && flow.meta[no].name) || '', v: s[who] }))
    .filter((r) => !skipSector(r.name));
  rows.sort((a, b) => b.v - a.v);
  return { top: rows.filter((r) => r.v > 0).slice(0, n), bottom: rows.filter((r) => r.v < 0).slice(-n).reverse() };
}

const eok = (v) => (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-US') + '억';

/** 알림 한 줄. '외국인 돈: 반도체 +1,230억 · 화장품 +310억' */
export function flowLine(flow, who, label) {
  const r = rankFlow(flow, who, 2);
  if (!r.top.length) return null;
  return `${label} 돈 ${r.top.map((x) => `${x.name} ${eok(x.v)}`).join(' · ')}`;
}
