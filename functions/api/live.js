/**
 * 실시간 섹터 흐름 API  ·  Cloudflare Pages Function
 *
 * 경로: /api/live
 *
 * 왜 이게 필요한가.
 *   원래 구조는 GitHub가 30분마다 HTML을 새로 만들어 덮어쓰는 방식이었다.
 *   그러면 아무리 자주 돌려도 '만들 때 계산'이라 실시간이 될 수 없다.
 *   이 함수는 화면이 열릴 때마다 그 자리에서 시세를 받아 판정한다.
 *
 * 판정 규칙은 collect.py 와 똑같이 맞춰 둔다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
 * 등락률은 야후가 직접 계산해 주는 regularMarketChangePercent 를 쓴다.
 * 선물·환율·코인은 24시간 돌아가서 일봉으로 계산하면 기준일이 어긋나기 때문이다.
 */

const SECTORS = [
  ['091160.KS', '반도체',     'KODEX 반도체',        '^SOX'],
  ['266370.KS', 'IT하드웨어',  'KODEX IT하드웨어',    '^SOX'],
  ['139260.KS', 'IT대형주',    'TIGER 200 IT',        '^SOX'],
  ['305720.KS', '2차전지',     'KODEX 2차전지산업',   'NQ=F'],
  ['244580.KS', '바이오',      'KODEX 바이오',        '^TNX'],
  ['091180.KS', '자동차',      'KODEX 자동차',        'KRW=X'],
  ['102960.KS', '조선',        'KODEX 기계장비',      'KRW=X'],
  ['139230.KS', '중공업',      'TIGER 200 중공업',    'KRW=X'],
  ['091170.KS', '은행',        'KODEX 은행',          '^TNX'],
  ['102970.KS', '증권',        'KODEX 증권',          '^KS11'],
  ['117700.KS', '건설',        'KODEX 건설',          '^TNX'],
  ['117460.KS', '에너지화학',  'KODEX 에너지화학',    'CL=F'],
  ['140710.KS', '운송',        'KODEX 운송',          'CL=F'],
  ['228790.KS', '화장품',      'TIGER 화장품',        '^KS11'],
  ['266390.KS', '소비재',      'KODEX 경기소비재',    '^KS11'],
];

const GLOBALS = [
  ['NQ=F',      '나스닥 선물',    'idx',    ''],
  ['ES=F',      'S&P500 선물',   'idx',    ''],
  ['^SOX',      '미국 반도체',    'idx',    ''],
  ['^KS11',     '코스피',         'kr',     ''],
  ['^KQ11',     '코스닥',         'kr',     ''],
  ['KRW=X',     '원달러',         'fx',     '원'],
  ['DX-Y.NYB',  '달러인덱스',     'fx',     ''],
  ['CL=F',      '유가(WTI)',      'cmd',    '$'],
  ['GC=F',      '금',             'cmd',    '$'],
  ['^TNX',      '미국 10년 금리', 'rate',   '%'],
  ['^VIX',      '공포지수(VIX)',  'risk',   ''],
  ['BTC-USD',   '비트코인',       'crypto', '$'],
];

const UA = 'Mozilla/5.0 (compatible; sector-flow/1.0)';
const YH = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function quote(sym) {
  const url = `${YH}${encodeURIComponent(sym)}?range=1mo&interval=1d`;
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${sym} ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`${sym} empty`);
  const q = res.indicators?.quote?.[0] || {};
  const ts = res.timestamp || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c === null || c === undefined) continue;
    rows.push({ t: ts[i], c, v: q.volume?.[i] ?? 0 });
  }
  return {
    sym,
    pct: res.meta?.regularMarketChangePercent ?? null,
    price: res.meta?.regularMarketPrice ?? (rows.length ? rows[rows.length - 1].c : null),
    time: res.meta?.regularMarketTime ?? null,
    rows,
  };
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const r2 = (x) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100);

/** 연속 상승/하락 일수. 부호가 바뀌면 끊긴다. collect.py 의 streak() 과 같다. */
function streak(rets) {
  if (!rets.length) return [0, 0];
  const last = rets[rets.length - 1];
  const sign = last > 0 ? 1 : last < 0 ? -1 : 0;
  if (!sign) return [0, 0];
  let n = 0;
  for (let i = rets.length - 1; i >= 0; i--) {
    const v = rets[i];
    if ((v > 0 && sign > 0) || (v < 0 && sign < 0)) n++;
    else break;
  }
  return [sign, n];
}

const WD = ['일', '월', '화', '수', '목', '금', '토'];

function buildSector(meta, q) {
  const [ticker, name, etf, driver] = meta;
  const rows = q.rows;
  if (rows.length < 5) return null;

  const closes = rows.map((r) => r.c);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);

  // 등락률은 야후 공식값을 쓰고, 없으면 일봉으로 계산한다.
  const chg = q.pct !== null ? r2(q.pct) : r2((closes.at(-1) / closes.at(-2) - 1) * 100);

  // 돈 몰림 = 오늘 거래대금 / 최근 20일 중앙값
  let money = null;
  const turn = rows.map((r) => r.c * (r.v || 0)).filter((x) => x > 0);
  if (turn.length >= 10) {
    const base = median(turn.slice(Math.max(0, turn.length - 21), turn.length - 1));
    if (base > 0) money = r2(turn.at(-1) / base);
  }

  const [sign, n] = streak(rets);
  const tail = rets.slice(-5);
  const tailRows = rows.slice(-tail.length);

  return {
    name, ticker, etf, driver,
    chg,
    chg5: closes.length >= 6 ? r2((closes.at(-1) / closes.at(-6) - 1) * 100) : null,
    money,
    streak_sign: sign,
    streak: n,
    price: Math.round(q.price ?? closes.at(-1)),
    volume: rows.at(-1).v || null,
    spark: tail.map((x) => r2(x * 100)),
    spark_days: tailRows.map((r) => WD[new Date((r.t + 32400) * 1000).getUTCDay()]),
  };
}

function judgeFlow(sectors) {
  const valid = sectors.filter((s) => s.chg !== null);
  if (!valid.length) return [[], [], ['데이터를 못 받았습니다', '']];

  for (const s of valid) {
    let m = s.money || 1.0;
    m = Math.max(0.4, Math.min(2.0, m));
    s.flow = r2(s.chg * (0.6 + 0.4 * m));
    s.hot = !!(s.money && s.money >= 1.5);
  }

  const ups = valid.filter((s) => s.chg > 0).sort((a, b) => b.flow - a.flow);
  const downs = valid.filter((s) => s.chg < 0).sort((a, b) => a.flow - b.flow);
  const avg = valid.reduce((t, s) => t + s.chg, 0) / valid.length;
  const spread = Math.max(...valid.map((s) => s.chg)) - Math.min(...valid.map((s) => s.chg));

  const top_in = ups.slice(0, 3);
  const top_out = downs.slice(0, 3);

  let line, sub;
  if (spread < 1.0) {
    if (avg > 0.3) { line = '오늘은 다 같이 올랐다'; sub = '특별히 몰린 곳 없음'; }
    else if (avg < -0.3) { line = '오늘은 다 같이 빠졌다'; sub = top_in.length ? '그나마 버틴 곳: ' + top_in[0].name : '전 섹터 약세'; }
    else { line = '오늘은 특별한 흐름 없다'; sub = '섹터 차이가 작음'; }
  } else if (top_in.length) {
    line = `오늘 돈은 ${top_in.slice(0, 2).map((s) => s.name).join(' · ')}로 갔다`;
    const h = top_in[0];
    const bits = [];
    if (h.streak >= 2 && h.streak_sign > 0) bits.push(`${h.name} ${h.streak}일째`);
    if (h.money && h.money >= 1.3) bits.push('거래 크게 늘어남');
    sub = bits.length ? bits.join(' · ') : `${h.name} 오늘 시작`;
  } else {
    line = '오늘은 다 빠졌다'; sub = '유입 섹터 없음';
  }
  return [top_in, top_out, [line, sub]];
}

const gg = (gl, t) => gl.find((x) => x.ticker === t);

function judgeMood(gl) {
  let score = 0;
  const why = [];
  const nq = gg(gl, 'NQ=F'), sox = gg(gl, '^SOX'), vix = gg(gl, '^VIX');
  const krw = gg(gl, 'KRW=X'), oil = gg(gl, 'CL=F'), tnx = gg(gl, '^TNX');

  if (nq?.chg !== null && nq) {
    if (nq.chg >= 0.5) { score += 2; why.push('미국 선물 강세'); }
    else if (nq.chg <= -0.5) { score -= 2; why.push('미국 선물 약세'); }
  }
  if (sox?.chg !== null && sox) {
    if (sox.chg >= 1) { score += 1; why.push('미국 반도체 강세'); }
    else if (sox.chg <= -1) { score -= 1; why.push('미국 반도체 약세'); }
  }
  if (vix?.last !== null && vix) {
    if (vix.last <= 16) score += 1;
    else if (vix.last >= 22) { score -= 2; why.push('공포지수 높음'); }
  }
  if (krw?.chg !== null && krw) {
    if (krw.chg >= 0.5) { score -= 1; why.push('환율 급등'); }
    else if (krw.chg <= -0.4) { score += 1; why.push('환율 안정'); }
  }
  if (tnx?.chg !== null && tnx && tnx.chg >= 2) { score -= 1; why.push('금리 급등'); }
  if (oil?.chg !== null && oil && oil.chg <= -3) { score += 1; why.push('유가 급락'); }

  const mood = score >= 2 ? '좋음' : score <= -2 ? '나쁨' : '보통';
  const emoji = score >= 2 ? '🟢' : score <= -2 ? '🔴' : '🟡';
  return { mood, emoji, score, why: why.slice(0, 3) };
}

function attachDrivers(sectors, gl) {
  for (const s of sectors) {
    const d = gg(gl, s.driver);
    if (!d || d.chg === null) { s.driver_text = null; continue; }
    const rising = ['idx', 'kr'].includes(d.kind) ? '강세' : '상승';
    const falling = ['idx', 'kr'].includes(d.kind) ? '약세' : '하락';
    const word = d.chg > 0 ? rising : d.chg < 0 ? falling : '보합';
    s.driver_text = `${d.name} ${word} ${d.chg > 0 ? '+' : ''}${d.chg}%`;
  }
}

/** 한국 시간 기준 장 상태. */
function marketStatus(now) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const dow = kst.getUTCDay();
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (dow === 0 || dow === 6) return ['closed', '주말 휴장'];
  if (mins < 9 * 60) return ['pre', '개장 전'];
  if (mins < 15 * 60 + 30) return ['open', '장중'];
  if (mins < 18 * 60) return ['after', '장 마감'];
  return ['closed', '장 마감'];
}

function kstStamp(now) {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    full: `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`,
    hm: `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`,
    date: `${p(k.getUTCMonth() + 1)}월 ${p(k.getUTCDate())}일`,
    weekday: WD[k.getUTCDay()],
  };
}

async function build() {
  const all = [...SECTORS.map((m) => m[0]), ...GLOBALS.map((m) => m[0])];
  const settled = await Promise.allSettled(all.map(quote));
  const byId = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') byId[all[i]] = r.value;
  });

  const sectors = [];
  for (const m of SECTORS) {
    const q = byId[m[0]];
    const s = q ? buildSector(m, q) : null;
    if (s) sectors.push(s);
    else errors.push(m[1]);
  }

  const globals = [];
  for (const [ticker, name, kind, unit] of GLOBALS) {
    const q = byId[ticker];
    if (!q || q.price === null) { errors.push(name); continue; }
    const v = q.price;
    globals.push({
      name, kind, ticker, unit,
      last: Math.abs(v) >= 1000 ? Math.round(v) : r2(v),
      chg: q.pct !== null ? r2(q.pct) : null,
    });
  }

  const [top_in, top_out, [headline, subline]] = judgeFlow(sectors);
  const mood = judgeMood(globals);
  attachDrivers(sectors, globals);

  const now = new Date();
  const [status, label] = marketStatus(now);
  const st = kstStamp(now);

  return {
    source: 'live',
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

  let body, ttl;
  try {
    body = await build();
    // 장중엔 20초, 그 밖엔 5분. 야후를 두드리는 횟수를 줄인다.
    ttl = body.market_status === 'open' ? 20 : 300;
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
    });
  }

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
