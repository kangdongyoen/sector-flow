/**
 * 실시간 섹터 흐름 API  ·  Cloudflare Pages Function
 *
 * 경로: /api/live
 *
 * 섹터(업종)는 네이버에서 1회 호출로 통째로 받는다. 지연 0.
 *   - 업종별 등락률, 구성 종목 수, 상승 · 하락 · 보합 개수가 한 번에 온다.
 *   - ETF로 업종을 근사하던 방식을 버렸다. 이제 업종 그 자체다.
 * 해외 지표는 야후에서 받는다. 24시간 도는 선물 · 환율 · 코인은
 *   야후가 직접 계산한 등락률(regularMarketChangePercent)을 그대로 쓴다.
 *
 * 출처를 갈아 끼울 때는 readSectors() 하나만 바꾸면 된다.
 * 화면과 판정 로직은 건드릴 필요가 없다.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAVER_H = {
  'user-agent': UA,
  'accept-language': 'ko-KR,ko;q=0.9',
  accept: 'application/json,*/*;q=0.8',
  referer: 'https://m.stock.naver.com/',
};

/** 종목 수가 이보다 적은 업종은 흐름으로 읽기 어렵다. */
const MIN_STOCKS = 3;

/** 국내 지수. 네이버. [코드, 이름] */
const KR_INDEX = [
  ['KOSPI', '코스피'],
  ['KOSDAQ', '코스닥'],
  ['KPI200', '코스피200'],
];

/** 해외 지표. [티커, 이름, 분류, 단위]
 *  us    미국 현물 지수. 한국 낮에는 어젯밤 마감치 그대로다.
 *  fut   미국 선물. 24시간 돈다. 한국 장중의 미국 분위기는 여기서 본다.
 *  asia  한국과 같은 시간에 열려 있는 아시아 시장. */
const GLOBALS = [
  ['^DJI', '다우', 'us', ''],
  ['^GSPC', 'S&P500', 'us', ''],
  ['^IXIC', '나스닥', 'us', ''],
  ['^SOX', '필라델피아 반도체', 'us', ''],
  ['NQ=F', '나스닥 선물', 'fut', ''],
  ['ES=F', 'S&P500 선물', 'fut', ''],
  ['^N225', '닛케이', 'asia', ''],
  ['000001.SS', '상하이종합', 'asia', ''],
  ['^HSI', '항셍', 'asia', ''],
  ['^TWII', '대만 가권', 'asia', ''],
  ['KRW=X', '원달러', 'fx', '원'],
  ['DX-Y.NYB', '달러인덱스', 'fx', ''],
  ['CL=F', '유가(WTI)', 'cmd', '$'],
  ['GC=F', '금', 'cmd', '$'],
  ['^TNX', '미국 10년 금리', 'rate', '%'],
  ['^VIX', '공포지수(VIX)', 'risk', ''],
  ['BTC-USD', '비트코인', 'crypto', '$'],
];

const r2 = (x) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100);
const numOf = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

/* ── 섹터: 네이버 업종 ── */

async function readSectors() {
  const r = await fetch('https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=100', {
    headers: NAVER_H,
  });
  if (!r.ok) throw new Error('industry ' + r.status);
  const j = await r.json();
  const groups = j.groups || [];

  const out = [];
  for (const g of groups) {
    const total = g.totalCount || 0;
    if (total < MIN_STOCKS) continue;
    const chg = numOf(g.changeRate);
    if (chg === null) continue;
    const rise = g.riseCount || 0;
    const fall = g.fallCount || 0;
    const steady = g.steadyCount || 0;
    // 참여율: 그 방향으로 실제로 몇 개가 움직였나. 0 ~ 1
    const part = total ? (chg >= 0 ? rise : fall) / total : 0;
    out.push({
      name: String(g.name || '').trim(),
      no: g.no,
      chg,
      total,
      rise,
      fall,
      steady,
      part: r2(part),
    });
  }
  return out;
}

/* ── 업종 숫자 검증 ──
   한국 주식은 하루에 ±30% 넘게 못 움직인다. 가격제한폭이다.
   그 밖의 숫자가 찍힌 종목은 상장 첫날이거나 거래가 재개된 종목이다.
   어제 가격이 없으니 '오늘 돈이 움직인 폭'이 아니다.
   그런데 네이버 업종 등락률은 이런 종목도 시가총액 비중대로 섞는다.
   그래서 공모주 하나가 업종 전체를 +140% 로 만드는 일이 생긴다.

   업종 숫자가 수상하면 구성 종목을 열어 보고, 제한폭 밖 종목만 빼고 다시 계산한다.
   수상한 기준: 업종이 통째로 8% 넘게 움직였거나,
   3% 넘게 움직였는데 같은 방향 종목이 절반도 안 될 때. */
const PRICE_LIMIT = 30;
const MAX_CHECK = 4;

/** 업종 구성 종목 전부. 네이버는 한 번에 20개(최대 100개)씩만 주므로 끝까지 넘겨 받는다. */
async function readMembers(no) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://m.stock.naver.com/api/stocks/industry/${no}?page=${page}&pageSize=100`, { headers: NAVER_H });
    if (!r.ok) throw new Error('members ' + r.status);
    const j = await r.json();
    const got = j.stocks || [];
    all.push(...got);
    if (got.length < 100 || all.length >= (Number(j.totalCount) || 0)) break;
  }
  return all.map((s) => ({
    name: s.stockName,
    chg: numOf(s.fluctuationsRatio),
    cap: numOf(s.marketValue),
  }));
}

function recompute(members) {
  const valid = members.filter((m) => m.chg !== null);
  const keep = valid.filter((m) => Math.abs(m.chg) <= PRICE_LIMIT);
  const out = valid.filter((m) => Math.abs(m.chg) > PRICE_LIMIT);
  if (!out.length || !keep.length) return null;

  // 어제 시가총액 비중으로 묶는다. 지수 계산과 같은 방식이다.
  // 어제 시총 = 오늘 시총 / (1 + 오늘 등락률)
  const byCap = keep.every((m) => m.cap && m.cap > 0);
  let chg;
  if (byCap) {
    let w = 0, t = 0;
    for (const m of keep) {
      const prev = m.cap / (1 + m.chg / 100);
      w += prev;
      t += prev * m.chg;
    }
    chg = t / w;
  } else {
    chg = keep.reduce((a, m) => a + m.chg, 0) / keep.length;
  }
  return { chg: r2(chg), keep, out, byCap };
}

async function verifySectors(sectors) {
  const suspect = sectors
    .filter((s) => Math.abs(s.chg) >= 8 || (Math.abs(s.chg) >= 3 && (s.part || 0) < 0.5))
    .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
    .slice(0, MAX_CHECK);

  await Promise.allSettled(suspect.map(async (s) => {
    const fix = recompute(await readMembers(s.no));
    if (!fix) return;
    const rise = fix.keep.filter((m) => m.chg > 0).length;
    const fall = fix.keep.filter((m) => m.chg < 0).length;
    s.naver_chg = s.chg;
    s.chg = fix.chg;
    s.total = fix.keep.length;
    s.rise = rise;
    s.fall = fall;
    s.steady = fix.keep.length - rise - fall;
    s.part = r2(s.total ? (s.chg >= 0 ? rise : fall) / s.total : 0);
    s.excluded = fix.out.map((m) => m.name);
  }));
}

/* ── 해외 지표: 야후 ── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 야후 한 종목. 한 번 튕기면 잠깐 쉬고 다시 시도한다.
 * 한꺼번에 열 개를 쏘면 야후가 일부를 거부하기 때문이다.
 */
async function yahoo(sym, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
        { headers: { 'user-agent': UA, accept: 'application/json' } }
      );
      if (!r.ok) throw new Error(sym + ' ' + r.status);
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (!m || m.regularMarketPrice === undefined) throw new Error(sym + ' empty');
      return { pct: m.regularMarketChangePercent ?? null, price: m.regularMarketPrice };
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(260 * (i + 1));
    }
  }
  throw last;
}

async function naverIndex(code, name) {
  const r = await fetch(`https://m.stock.naver.com/api/index/${code}/basic`, { headers: NAVER_H });
  if (!r.ok) throw new Error(code + ' ' + r.status);
  const j = await r.json();
  return {
    name,
    kind: 'kr',
    ticker: code,
    unit: '',
    last: numOf(j.closePrice),
    chg: numOf(j.fluctuationsRatio),
    // 마지막 체결 시각. 예약 실행기가 이걸 보고 어느 거래일 숫자인지 정한다.
    at: j.localTradedAt || null,
  };
}

/**
 * 마지막으로 성공한 해외 지표 값. Cloudflare 캐시에 따로 보관한다.
 * 야후가 한 번 튕겼다고 화면에서 지표가 사라지면 안 된다.
 * 30분까지는 직전 값을 쓰고, 몇 분 전 값인지 표시한다.
 */
const LKG_MAX_AGE = 30 * 60 * 1000;

async function readLKG(origin) {
  try {
    const r = await caches.default.match(new Request(`${origin}/__lkg/globals`));
    if (!r) return null;
    const j = await r.json();
    if (!j || !j.at || Date.now() - j.at > LKG_MAX_AGE) return null;
    return j;
  } catch (e) {
    return null;
  }
}

function saveLKG(ctx, origin, items) {
  const body = JSON.stringify({ at: Date.now(), items });
  const res = new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${LKG_MAX_AGE / 1000}` },
  });
  ctx.waitUntil(caches.default.put(new Request(`${origin}/__lkg/globals`), res));
}

async function readGlobals(ctx, origin) {
  const INDEX_KINDS = ['us', 'asia'];
  const jobs = [
    ...KR_INDEX.map(([code, name]) => naverIndex(code, name)),
    ...GLOBALS.map(async ([t, name, kind, unit], i) => {
      // 야후는 한꺼번에 많이 쏘면 일부를 거부한다. 5개씩 묶어 간격을 둔다.
      await sleep(Math.floor(i / 5) * 320 + (i % 5) * 60);
      const q = await yahoo(t);
      const v = q.price;
      return {
        name, kind, ticker: t, unit,
        last: INDEX_KINDS.includes(kind) ? r2(v) : Math.abs(v) >= 1000 ? Math.round(v) : r2(v),
        chg: r2(q.pct),
      };
    }),
  ];

  const settled = await Promise.allSettled(jobs);
  const fresh = [];
  const failed = [];
  const names = [...KR_INDEX.map((x) => x[1]), ...GLOBALS.map((g) => g[1])];
  settled.forEach((s, i) => {
    const name = names[i];
    if (s.status === 'fulfilled' && s.value.last !== null && s.value.last !== undefined) fresh.push(s.value);
    else failed.push(name);
  });

  if (fresh.length) saveLKG(ctx, origin, fresh);

  // 실패한 것만 직전 값으로 메운다
  const errs = [];
  if (failed.length) {
    const lkg = await readLKG(origin);
    const mins = lkg ? Math.max(1, Math.round((Date.now() - lkg.at) / 60000)) : 0;
    for (const name of failed) {
      const old = lkg && lkg.items.find((x) => x.name === name);
      if (old) fresh.push({ ...old, stale: mins });
      else errs.push(name);
    }
  }

  // 원래 순서대로 되돌린다
  fresh.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  return [fresh, errs];
}

/* ── 과거 기록 ──
   업종 단위로 바꾸면서 과거가 없어졌다.
   GitHub 가 마감마다 data/history.json 에 하루치를 쌓고, 여기서 그걸 읽어 붙인다.
   5거래일이 모이면 상세 화면에 캔들이 그려진다. */

async function readHistory(ctx, origin) {
  // 예약 실행기가 쌓는 저장소(KV)가 먼저다. 비어 있으면 GitHub 에 남은 파일을 본다.
  try {
    const kv = ctx && ctx.env && ctx.env.FLOW;
    if (kv) {
      const j = await kv.get('history', 'json');
      if (j && Array.isArray(j.days) && j.days.length) return { days: j.days, src: 'kv' };
    }
  } catch (e) {}
  try {
    const r = await fetch(`${origin}/data/history.json`, { cf: { cacheTtl: 600 } });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j?.days) ? { days: j.days, src: 'file' } : null;
  } catch (e) {
    return null;
  }
}

const WDK = ['일', '월', '화', '수', '목', '금', '토'];

/** 오늘을 뺀 지난 기록에 오늘 값을 얹어 5거래일을 만든다. */
function attachHistory(sectors, days, todayISO) {
  if (!days || !days.length) return;
  const past = days.filter((x) => x.d < todayISO).slice(-4);
  for (const s of sectors) {
    const seq = [];
    for (const day of past) {
      const v = day.s ? day.s[s.name] : undefined;
      if (typeof v === 'number') seq.push({ d: day.d, v });
    }
    seq.push({ d: todayISO, v: s.chg });
    if (seq.length < 2) continue;

    s.spark = seq.map((x) => x.v);
    s.spark_days = seq.map((x) => WDK[new Date(x.d + 'T00:00:00Z').getUTCDay()]);

    // 누적 등락률. 하루치를 곱해서 이어 붙인다.
    let acc = 1;
    for (const x of seq) acc *= 1 + x.v / 100;
    s.chg5 = r2((acc - 1) * 100);

    // 연속 흐름. 오늘부터 거꾸로 같은 부호가 몇 번 이어졌나.
    const last = seq[seq.length - 1].v;
    const sign = last > 0 ? 1 : last < 0 ? -1 : 0;
    let n = 0;
    if (sign) {
      for (let i = seq.length - 1; i >= 0; i--) {
        const v = seq[i].v;
        if ((v > 0 && sign > 0) || (v < 0 && sign < 0)) n++;
        else break;
      }
    }
    s.streak_sign = sign;
    s.streak = n;
  }
}

/* ── 판정 ── */

/** when: 숫자가 속한 날. 오늘 장이면 '오늘', 휴장일 · 개장 전이면 '9월 23일' 처럼 그 거래일. */
function judgeFlow(sectors, when = '오늘') {
  if (!sectors.length) return [[], [], ['데이터를 못 받았습니다', '']];

  for (const s of sectors) {
    // 등락률이 주도하고, 참여율이 보정한다. 배수 0.6 ~ 1.4
    s.flow = r2(s.chg * (0.6 + 0.8 * (s.part || 0)));
    // 종목이 거의 전부 같은 방향이면 업종 전체가 밀린 것이다
    s.hot = s.total >= 5 && (s.part || 0) >= 0.85;
  }

  const ups = sectors.filter((s) => s.chg > 0).sort((a, b) => b.flow - a.flow);
  const downs = sectors.filter((s) => s.chg < 0).sort((a, b) => a.flow - b.flow);
  const avg = sectors.reduce((t, s) => t + s.chg, 0) / sectors.length;
  const spread = Math.max(...sectors.map((s) => s.chg)) - Math.min(...sectors.map((s) => s.chg));

  const top_in = ups.slice(0, 3);
  const top_out = downs.slice(0, 3);

  let line, sub;
  if (spread < 1.0) {
    if (avg > 0.3) { line = `${when}은 다 같이 올랐다`; sub = '특별히 몰린 곳 없음'; }
    else if (avg < -0.3) { line = `${when}은 다 같이 빠졌다`; sub = top_in.length ? '그나마 버틴 곳: ' + top_in[0].name : '전 업종 약세'; }
    else { line = `${when}은 특별한 흐름 없다`; sub = '업종 차이가 작음'; }
  } else if (top_in.length) {
    const names = top_in.slice(0, 2).map((s) => s.name);
    line = `${when} 돈은 ${names.join(' · ')}${ro(names[names.length - 1])} 갔다`;
    const h = top_in[0];
    const bits = [`${h.name} ${h.total}개 중 ${h.rise}개 상승`];
    const wide = sectors.filter((s) => s.chg > 0).length;
    bits.push(`오른 업종 ${wide}개 · 빠진 업종 ${sectors.length - wide}개`);
    sub = bits.join(' · ');
  } else {
    line = `${when}은 다 빠졌다`; sub = '오른 업종 없음';
  }
  return [top_in, top_out, [line, sub]];
}

/** 받침에 따라 '로' / '으로'. 받침 없거나 ㄹ이면 '로'. */
function ro(word) {
  const c = String(word).charCodeAt(String(word).length - 1);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return '로';
  const jong = (c - 0xac00) % 28;
  return jong === 0 || jong === 8 ? '로' : '으로';
}

const gg = (gl, t) => gl.find((x) => x.ticker === t);

function judgeMood(gl) {
  let score = 0;
  const why = [];
  const nq = gg(gl, 'NQ=F'), sox = gg(gl, '^SOX'), vix = gg(gl, '^VIX');
  const krw = gg(gl, 'KRW=X'), oil = gg(gl, 'CL=F'), tnx = gg(gl, '^TNX');

  if (nq && nq.chg !== null) {
    if (nq.chg >= 0.5) { score += 2; why.push('미국 선물 강세'); }
    else if (nq.chg <= -0.5) { score -= 2; why.push('미국 선물 약세'); }
  }
  if (sox && sox.chg !== null) {
    if (sox.chg >= 1) { score += 1; why.push('미국 반도체 강세'); }
    else if (sox.chg <= -1) { score -= 1; why.push('미국 반도체 약세'); }
  }
  if (vix && vix.last !== null) {
    if (vix.last <= 16) score += 1;
    else if (vix.last >= 22) { score -= 2; why.push('공포지수 높음'); }
  }
  if (krw && krw.chg !== null) {
    if (krw.chg >= 0.5) { score -= 1; why.push('환율 급등'); }
    else if (krw.chg <= -0.4) { score += 1; why.push('환율 안정'); }
  }
  if (tnx && tnx.chg !== null && tnx.chg >= 2) { score -= 1; why.push('금리 급등'); }
  if (oil && oil.chg !== null && oil.chg <= -3) { score += 1; why.push('유가 급락'); }

  const mood = score >= 2 ? '좋음' : score <= -2 ? '나쁨' : '보통';
  const emoji = score >= 2 ? '🟢' : score <= -2 ? '🔴' : '🟡';
  return { mood, emoji, score, why: why.slice(0, 3) };
}

/* ── 시각 ── */

const WD = ['일', '월', '화', '수', '목', '금', '토'];

/** 한국거래소 휴장일 (2026년, 증권사 공지 기준). 주말은 따로 거른다. 예약 실행기(worker/cron.js)와 같은 목록이다. */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01',
  '2026-05-05', '2026-05-25', '2026-06-03', '2026-07-17', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
]);

/** 미국 주식시장 휴장일 · 조기 폐장일 (현지 날짜). 증권사 공지 기준.
 *  미결제일(콜럼버스데이 · 재향군인의날)은 장이 정상으로 열려 여기에 넣지 않는다. */
const US_HOLIDAYS = {
  '2026-01-01': '새해', '2026-01-19': '마틴루서킹 데이', '2026-02-16': '대통령의 날',
  '2026-04-03': '성금요일', '2026-05-25': '메모리얼 데이', '2026-06-19': '준틴스',
  '2026-07-03': '독립기념일 대체', '2026-09-07': '노동절', '2026-11-26': '추수감사절',
  '2026-12-25': '성탄절',
};
const US_HALF = new Set(['2026-11-27', '2026-12-24']);

function nyNow(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const dayShift = (iso, n) => {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const isWeekend = (iso) => [0, 6].includes(new Date(iso + 'T00:00:00Z').getUTCDay());
const usSession = (iso) => !isWeekend(iso) && !US_HOLIDAYS[iso];
const dd = (iso) => `${Number(iso.slice(8))}일(${'일월화수목금토'[new Date(iso + 'T00:00:00Z').getUTCDay()]})`;

/** 미국 지수 칸 제목. 지금 장중인지, 마지막 마감이 언제였는지, 그 사이에 휴장이 있었는지. */
function usState(now) {
  const { day, mins } = nyNow(now);
  const close = US_HALF.has(day) ? 13 * 60 : 16 * 60;
  if (usSession(day) && mins >= 9 * 60 + 30 && mins < close) {
    return { state: 'open', last: day, half: US_HALF.has(day), holiday: null,
      label: '미국 지금 장중' + (US_HALF.has(day) ? ' · 조기 폐장일' : '') };
  }
  let last = usSession(day) && mins >= close ? day : dayShift(day, -1);
  let holiday = null;
  for (let i = 0; i < 10 && !usSession(last); i++) {
    if (!holiday && US_HOLIDAYS[last]) holiday = { day: last, name: US_HOLIDAYS[last] };
    last = dayShift(last, -1);
  }
  // 오늘(현지)이 휴장일이면 그것도 알려 준다. 한국 아침에 보면 '어젯밤'이 바로 그 휴장일이다.
  if (!holiday && US_HOLIDAYS[day]) holiday = { day, name: US_HOLIDAYS[day] };
  const half = US_HALF.has(last);
  const recent = last === day || last === dayShift(day, -1);
  const parts = [];
  if (holiday) parts.push(`${dd(holiday.day)} 휴장(${holiday.name})`);
  parts.push((recent && !holiday ? '어젯밤 마감' : `${dd(last)} 마감`) + (half ? ' · 조기 폐장' : ''));
  return { state: holiday ? 'holiday' : 'closed', last, half, holiday, label: '미국 ' + parts.join(' · ') };
}

function marketStatus(now) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const dow = k.getUTCDay();
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  if (dow === 0 || dow === 6) return ['closed', '주말 휴장'];
  if (HOLIDAYS.has(k.toISOString().slice(0, 10))) return ['closed', '휴장일'];
  if (mins < 9 * 60) return ['pre', '개장 전'];
  if (mins < 15 * 60 + 30) return ['open', '장중'];
  if (mins < 18 * 60) return ['after', '장 마감'];
  return ['closed', '장 마감'];
}

function stamp(now) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    full: `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`,
    hm: `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`,
    date: `${p(k.getUTCMonth() + 1)}월 ${p(k.getUTCDate())}일`,
    weekday: WD[k.getUTCDay()],
  };
}

/* ── 시장 전체: 투자자별 순매수 · 오른 종목 수 ──
   네이버 증권 지수 화면에 나오는 숫자 그대로다. 순매수 단위는 억원.
   장중에는 거래소 잠정치라 마감 뒤 숫자와 다를 수 있다. */
async function readMarket() {
  const one = async (code, name) => {
    const r = await fetch(`https://m.stock.naver.com/api/index/${code}/integration`, { headers: NAVER_H });
    if (!r.ok) throw new Error(code + ' ' + r.status);
    const j = await r.json();
    const t = j.dealTrendInfo || {};
    const u = j.upDownStockInfo || {};
    const day = String(t.bizdate || '');
    return {
      name,
      day: day.length === 8 ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}` : null,
      inv: {
        personal: numOf(t.personalValue),
        foreign: numOf(t.foreignValue),
        inst: numOf(t.institutionalValue),
      },
      breadth: {
        rise: numOf(u.riseCount), fall: numOf(u.fallCount), steady: numOf(u.steadyCount),
        upper: numOf(u.upperCount), lower: numOf(u.lowerCount),
      },
    };
  };
  const out = await Promise.allSettled([one('KOSPI', '코스피'), one('KOSDAQ', '코스닥')]);
  return out.filter((x) => x.status === 'fulfilled').map((x) => x.value);
}

/* ── 장중 흐름: 지난 30분 ──
   예약 실행기가 장중 10분마다 업종 등락률을 저장소에 찍어 둔다(intra:날짜).
   지금 숫자에서 30분 전 숫자를 빼면, 그 사이 어느 업종에 속도가 붙었는지 보인다. */
async function readIntraday(ctx, dayISO) {
  try {
    const kv = ctx && ctx.env && ctx.env.FLOW;
    if (!kv) return null;
    return await kv.get('intra:' + dayISO, 'json');
  } catch (e) {
    return null;
  }
}

function attachIntraday(sectors, intra, nowMins) {
  const snaps = intra && Array.isArray(intra.snaps) ? intra.snaps : [];
  if (!snaps.length) return null;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  // 30분 전과 가장 가까운 기록. 25분보다 가까우면 비교하지 않는다.
  let base = null;
  for (const sn of snaps) if (toMin(sn.t) <= nowMins - 25) base = sn;
  if (!base) return null;
  for (const s of sectors) {
    const v = base.s ? base.s[s.name] : undefined;
    if (typeof v === 'number' && typeof s.chg === 'number') s.d30 = r2(s.chg - v);
  }
  return { from: base.t, points: snaps.length };
}

/* ── 조립 ── */

async function build(ctx, origin) {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const calISO = kst.toISOString().slice(0, 10);
  const [sectorsRes, globalsRes, histRes, marketRes, intraRes] = await Promise.allSettled([
    readSectors(), readGlobals(ctx, origin), readHistory(ctx, origin), readMarket(), readIntraday(ctx, calISO),
  ]);

  const errors = [];
  const sectors = sectorsRes.status === 'fulfilled' ? sectorsRes.value : [];
  if (sectorsRes.status !== 'fulfilled') errors.push('업종 시세');

  let globals = [];
  if (globalsRes.status === 'fulfilled') {
    globals = globalsRes.value[0];
    errors.push(...globalsRes.value[1]);
  } else {
    errors.push('해외 지표');
  }

  const now = new Date();
  const [status, label] = marketStatus(now);
  const st = stamp(now);

  // 개장 전이면 아직 어제 장의 마감치다. 그 날짜 자리에 놓는다.
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  if (k.getUTCHours() < 9) k.setUTCDate(k.getUTCDate() - 1);
  const todayISO = k.toISOString().slice(0, 10);
  // 판정 전에 숫자부터 바로잡는다. 기록에도 바로잡힌 숫자가 남는다.
  await verifySectors(sectors);
  const hist = histRes.status === 'fulfilled' ? histRes.value : null;
  if (hist) attachHistory(sectors, hist.days, todayISO);

  // 지난 30분 흐름은 장이 열려 있을 때만 뜻이 있다
  let intraday = null;
  if (status === 'open' && intraRes.status === 'fulfilled') {
    intraday = attachIntraday(sectors, intraRes.value, kst.getUTCHours() * 60 + kst.getUTCMinutes());
  }
  const market = marketRes.status === 'fulfilled' ? marketRes.value : [];

  // 숫자가 어느 거래일 것인가. 휴장일 · 개장 전에는 지난 거래일 마감치다. 제목의 '오늘'을 그 날짜로 바꾼다.
  const krAt = globals.find((g) => g.kind === 'kr' && g.at);
  const trade_day = (krAt && String(krAt.at).slice(0, 10)) || (market[0] && market[0].day) || null;
  const is_today = !trade_day || trade_day === calISO;
  const td = trade_day ? new Date(trade_day + 'T00:00:00Z') : null;
  const trade_label = td ? `${td.getUTCMonth() + 1}월 ${td.getUTCDate()}일 (${WD[td.getUTCDay()]})` : null;
  const when = is_today ? '오늘' : `${td.getUTCMonth() + 1}월 ${td.getUTCDate()}일`;

  const [top_in, top_out, [headline, subline]] = judgeFlow(sectors, when);
  const mood = judgeMood(globals);

  return {
    source: 'naver+yahoo',
    updated: st.full,
    updated_label: `${st.date} ${st.hm} 기준`,
    date_label: st.date,
    weekday: st.weekday,
    market_status: status,
    market_label: label,
    us: usState(now),
    market,
    intraday,
    is_live: status === 'open',
    trade_day,
    trade_label,
    is_today,
    headline,
    subline,
    mood,
    top_in: top_in.map((s) => s.name),
    top_out: top_out.map((s) => s.name),
    sectors,
    globals,
    errors,
    // 과거 기록을 어디서 읽었나. kv 면 예약 실행기가 쌓은 것, file 이면 GitHub 예비 파일.
    history: hist ? { src: hist.src, days: hist.days.length, last: hist.days[hist.days.length - 1]?.d || null } : null,
  };
}

export async function onRequestGet(context) {
  const cache = caches.default;
  const url = new URL(context.request.url);
  const key = new Request(`${url.origin}/api/live`, { method: 'GET' });

  const hit = await cache.match(key);
  if (hit) return hit;

  let body;
  try {
    body = await build(context, url.origin);
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }
  if (!body.sectors.length) {
    return new Response(JSON.stringify({ error: 'no sectors', errors: body.errors }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }

  const ttl = body.market_status === 'open' ? 20 : 300;
  const res = new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
      'access-control-allow-origin': '*',
    },
  });
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}
