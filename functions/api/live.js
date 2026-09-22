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

/** 해외 지표. [티커, 이름, 분류, 단위] */
const GLOBALS = [
  ['NQ=F', '나스닥 선물', 'idx', ''],
  ['ES=F', 'S&P500 선물', 'idx', ''],
  ['^SOX', '미국 반도체', 'idx', ''],
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

/* ── 해외 지표: 야후 ── */

async function yahoo(sym) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`,
    { headers: { 'user-agent': UA, accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(sym + ' ' + r.status);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  if (!m) throw new Error(sym + ' empty');
  return { pct: m.regularMarketChangePercent ?? null, price: m.regularMarketPrice ?? null };
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
  };
}

async function readGlobals() {
  const errs = [];
  const jobs = [
    naverIndex('KOSPI', '코스피'),
    naverIndex('KOSDAQ', '코스닥'),
    ...GLOBALS.map(async ([t, name, kind, unit]) => {
      const q = await yahoo(t);
      const v = q.price;
      return {
        name,
        kind,
        ticker: t,
        unit,
        last: v === null ? null : Math.abs(v) >= 1000 ? Math.round(v) : r2(v),
        chg: r2(q.pct),
      };
    }),
  ];
  const settled = await Promise.allSettled(jobs);
  const out = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled' && s.value.last !== null) out.push(s.value);
    else errs.push(i < 2 ? ['코스피', '코스닥'][i] : GLOBALS[i - 2][1]);
  });
  return [out, errs];
}

/* ── 판정 ── */

function judgeFlow(sectors) {
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
    if (avg > 0.3) { line = '오늘은 다 같이 올랐다'; sub = '특별히 몰린 곳 없음'; }
    else if (avg < -0.3) { line = '오늘은 다 같이 빠졌다'; sub = top_in.length ? '그나마 버틴 곳: ' + top_in[0].name : '전 업종 약세'; }
    else { line = '오늘은 특별한 흐름 없다'; sub = '업종 차이가 작음'; }
  } else if (top_in.length) {
    line = `오늘 돈은 ${top_in.slice(0, 2).map((s) => s.name).join(' · ')}로 갔다`;
    const h = top_in[0];
    const bits = [`${h.name} ${h.total}개 중 ${h.rise}개 상승`];
    const wide = sectors.filter((s) => s.chg > 0).length;
    bits.push(`오른 업종 ${wide}개 · 빠진 업종 ${sectors.length - wide}개`);
    sub = bits.join(' · ');
  } else {
    line = '오늘은 다 빠졌다'; sub = '오른 업종 없음';
  }
  return [top_in, top_out, [line, sub]];
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

function marketStatus(now) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const dow = k.getUTCDay();
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  if (dow === 0 || dow === 6) return ['closed', '주말 휴장'];
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

/* ── 조립 ── */

async function build() {
  const [sectorsRes, globalsRes] = await Promise.allSettled([readSectors(), readGlobals()]);

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

  const [top_in, top_out, [headline, subline]] = judgeFlow(sectors);
  const mood = judgeMood(globals);

  const now = new Date();
  const [status, label] = marketStatus(now);
  const st = stamp(now);

  return {
    source: 'naver+yahoo',
    updated: st.full,
    updated_label: `${st.date} ${st.hm} 기준`,
    date_label: st.date,
    weekday: st.weekday,
    market_status: status,
    market_label: label,
    is_live: status === 'open',
    headline,
    subline,
    mood,
    top_in: top_in.map((s) => s.name),
    top_out: top_out.map((s) => s.name),
    sectors,
    globals,
    errors,
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
    body = await build();
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
