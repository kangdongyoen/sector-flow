/**
 * 섹터 흐름판 · 예약 실행기  (Cloudflare Worker)
 *
 * GitHub 예약 실행은 제때 돌지 않았다. 그래서 시계를 Cloudflare 로 옮겼다.
 * 이 실행기가 하는 일은 세 가지다.
 *
 *   1. 장중 10분마다 업종 등락률을 찍어 둔다(intra:날짜). '지난 30분' 과 '오늘 흐름' 선이 여기서 나온다.
 *   2. 마감 뒤 하루치 업종 등락률을 쌓는다(history). 상세 화면의 캔들이 여기서 나온다.
 *   3. 개장 전 · 마감 뒤에 휴대폰 알림으로 요약을 보낸다(push.js).
 *   4. 개장 전 한 번 경제 헤드라인(네이버 증권 주요 뉴스 제목)을 날짜별로 남긴다(news:날짜).
 *      나중에 '그 뉴스가 나온 날 돈이 실제로 어디로 갔나'를 되짚는 기록이다.
 *   5. 평일 07:00 ~ 21:59 10분마다 DART 에서 '큰손' 공시를 모은다(whale.js).
 *      5% 대량보유 보고와 임원 · 주요주주 매매 보고. 화면 '큰손 움직임'이 여기서 나온다.
 *   6. 휴대폰 알림(push.js, 웹 푸시). 사이트에서 '알림 받기'를 누른 기기로 간다.
 *   7. 마감 뒤 15:50부터 업종별 수급(flow.js)을 조금씩 받는다. 외국인 · 기관 · 개인이 오늘 어느 업종을 샀나. 18시쯤 다 찬다.
 *      08:37 개장 전 · 15:40 마감 · 18:33 그날 큰손 요약 · 아주 큰 공시는 들어오는 즉시
 *
 * 예약 (UTC. 한국시간 = UTC + 9. Cloudflare 는 요일을 이름으로 적는다)
 *   *\/10 0-6 * * MON-FRI  09:00 ~ 15:50  10분마다. 15:40 · 15:50 은 마감 뒤 기록과 알림
 *   37,47 23 * * SUN-THU   08:37 · 08:47  개장 전 (한국 월~금 아침)
 *   3,13,23,33,43,53 * * * *   10분마다 DART 확인. 한국 평일 07~21시가 아니면 바로 끝낸다
 * 같은 알림은 하루에 한 번만 간다. 앞 순번이 성공하면 뒤 순번은 건너뛴다.
 *
 * 저장소(KV) 키
 *   history   하루치 업종 등락률 60일
 *   intra:날짜  장중 10분 간격 업종 등락률. 나흘 뒤 저절로 지워진다.
 *   runs      최근 실행 기록 20개
 *   news:날짜   그날 아침 헤드라인 제목 10개. 1년 뒤 저절로 지워진다.
 *   whale:v1 · whale:seen · whale:map   큰손 공시 목록 · 이미 본 공시 · 종목코드 표 (whale.js 참고)
 *   vapid     웹 푸시 서명 키. 밖으로 보여주지 않는다
 *   sub:…     알림을 받는 기기 하나. functions/api/push.js 가 만든다
 *   push:날짜:am|pm|wh|wa   그날 휴대폰 알림을 보냈다는 표시. 사흘 뒤 저절로 지워진다.
 *   flow:members · flow:날짜 · flow:latest   업종별 수급 (flow.js 참고)
 *   wruns     큰손 · 수급 실행 기록 최근 30개
 */

import { harvestWhale, isInstant, whatLine, whenLine, digest } from './whale.js';
import { KR_HOLIDAYS as HOLIDAYS } from './calendar.js';
import { refreshMembers, fetchFlow, readFlow, flowLine } from './flow.js';
import { listSubs, pushAll, pushEach, pushNote } from './push.js';

const WHALE_CRON = '3,13,23,33,43,53 * * * *';

const SITE = 'https://lucent-sector.pages.dev';
const KEEP_DAYS = 60;


const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);
const pct = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 시세 받기 ── */

async function getLive() {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SITE}/api/live?t=${Date.now()}`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('live ' + r.status);
      const d = await r.json();
      if (!d.sectors || !d.sectors.length) throw new Error('업종 없음');
      return d;
    } catch (e) {
      last = e;
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

const G = (d, n) => (d.globals || []).find((g) => g.name === n);

/** 경제 헤드라인. 화면과 같은 /api/news 를 부른다. 제목 · 언론사 · 시각 · 주소만 온다. */
async function getNews() {
  const r = await fetch(`${SITE}/api/news?t=${Date.now()}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('news ' + r.status);
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}

/** 아침 헤드라인을 그날 이름으로 한 번만 남긴다 */
async function archiveNews(env, day, items) {
  const key = 'news:' + day;
  if (!items.length || (await env.FLOW.get(key))) return false;
  const at = kstNow().toISOString().slice(11, 16);
  const rows = items.slice(0, 10).map((x) => ({ t: x.t, src: x.src, at: x.at, url: x.url }));
  await env.FLOW.put(key, JSON.stringify({ day, at, items: rows }), { expirationTtl: 366 * 86400 });
  return true;
}

/** 이 숫자가 어느 거래일 것인가. 시계가 아니라 코스피 마지막 체결 시각으로 정한다.
 *  그래야 휴장일에 어제 숫자를 오늘 것으로 잘못 쌓지 않는다. */
function tradeDate(d) {
  const k = G(d, '코스피');
  const at = k && k.at ? String(k.at) : '';
  const m = at.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 체결 시각을 못 받았을 때만 쓰는 예비 계산. 개장 전이면 전 거래일로 돌린다. */
function fallbackDay(now) {
  const k = new Date(now.getTime());
  if (k.getUTCHours() < 9) k.setUTCDate(k.getUTCDate() - 1);
  for (let i = 0; i < 10; i++) {
    const dow = k.getUTCDay();
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(ymd(k))) break;
    k.setUTCDate(k.getUTCDate() - 1);
  }
  return ymd(k);
}

/* ── 1. 하루치 기록 ── */

/** 저장소가 비어 있으면 GitHub 에 쌓아 둔 기록을 가져와 이어 붙인다. */
async function loadHistory(env) {
  let hist = await env.FLOW.get('history', 'json');
  if (hist && Array.isArray(hist.days)) return [hist, false];
  try {
    const r = await fetch(`${SITE}/data/history.json?t=${Date.now()}`);
    hist = r.ok ? await r.json() : null;
  } catch (e) {
    hist = null;
  }
  if (!hist || !Array.isArray(hist.days)) hist = { unit: 'industry', days: [] };
  return [hist, true];
}

async function seed(env) {
  const [hist, fresh] = await loadHistory(env);
  if (fresh) await env.FLOW.put('history', JSON.stringify(hist));
  return [hist.days.length, fresh];
}

async function record(env, d, day) {
  const [hist] = await loadHistory(env);
  const row = { d: day, closed: true, s: {} };
  for (const s of d.sectors || []) if (typeof s.chg === 'number') row.s[s.name] = s.chg;
  hist.unit = 'industry';
  hist.days = hist.days
    .filter((x) => x && x.d && x.d !== day)
    .concat([row])
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .slice(-KEEP_DAYS);
  await env.FLOW.put('history', JSON.stringify(hist));
  return hist.days.length;
}

/** 장중 한 장. 같은 시각이 이미 있으면 넘어간다. */
async function snapshot(env, d, day, t) {
  const key = 'intra:' + day;
  const cur = (await env.FLOW.get(key, 'json')) || { snaps: [] };
  const last = cur.snaps[cur.snaps.length - 1];
  if (last && last.t >= t) return cur.snaps.length;
  const s = {};
  for (const x of d.sectors || []) if (typeof x.chg === 'number') s[x.name] = x.chg;
  cur.snaps.push({ t, s });
  await env.FLOW.put(key, JSON.stringify(cur), { expirationTtl: 4 * 86400 });
  return cur.snaps.length;
}

/* ── 2. 알림 문구 ── */

function dayLabel(now) {
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${m}월 ${dd}일 (${'일월화수목금토'[now.getUTCDay()]})`;
}

/** 개장 전: 어젯밤 미국이 어떻게 끝났고, 지금 분위기가 어떤가 */
function textAM(d, now, news) {
  const L = [`[섹터 흐름판] ${dayLabel(now)} 개장 전`];
  const us = [['다우', '다우'], ['나스닥', '나스닥'], ['필라델피아 반도체', '반도체']]
    .map(([n, s]) => [G(d, n), s])
    .filter(([g]) => g && typeof g.chg === 'number');
  // 미국 휴장 · 조기 폐장은 /api/live 가 계산해 준 제목을 그대로 쓴다. 휴장 다음날 숫자를 어젯밤 것으로 오해하지 않게.
  const head = (d.us && d.us.label) || '미국 마감';
  if (us.length) L.push(head);
  if (us.length) L.push(us.map(([g, s]) => `${s} ${pct(g.chg)}`).join(' · '));
  const nq = G(d, '나스닥 선물');
  if (nq && typeof nq.chg === 'number') L.push(`나스닥 선물 ${pct(nq.chg)}`);
  const m = d.mood || {};
  if (m.mood) L.push(`분위기 ${m.mood}` + ((m.why || []).length ? ' · ' + m.why.slice(0, 2).join(' · ') : ''));
  // 헤드라인은 제목만, 앞쪽 두 개. 글자 한도를 넘기면 fit 이 통째로 뺀다.
  for (const x of (news || []).slice(0, 2)) L.push('· ' + cut(x.t, 30));
  return fit(L);
}

const cut = (t, n) => {
  const a = [...String(t || '')];
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
};

const eok = (v) => (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-US') + '억';

/** 알림 글자 한도(200자)를 넘기면 뒤쪽 줄부터 통째로 뺀다. 줄 중간이 잘리지 않게. */
function fit(lines, max = 200) {
  const out = [];
  for (const l of lines.filter(Boolean)) {
    if ([...out, l].join('\n').length > max) break;
    out.push(l);
  }
  return out.join('\n');
}

/** 마감 뒤: 오늘 돈이 어디로 갔나 */
function textPM(d) {
  const L = [`[섹터 흐름판] ${d.date_label || ''} 마감`, d.headline || ''];
  const ks = G(d, '코스피'), kq = G(d, '코스닥');
  if (ks && kq && typeof ks.chg === 'number' && typeof kq.chg === 'number') {
    L.push(`코스피 ${pct(ks.chg)} · 코스닥 ${pct(kq.chg)}`);
  }
  // 누가 샀고 누가 팔았나. 코스피 기준, 네이버 증권 숫자 그대로(억원).
  const m = (d.market || []).find((x) => x.name === '코스피');
  if (m && m.inv && [m.inv.foreign, m.inv.inst, m.inv.personal].every((v) => typeof v === 'number')) {
    L.push(`외국인 ${eok(m.inv.foreign)} · 기관 ${eok(m.inv.inst)} · 개인 ${eok(m.inv.personal)}`);
  }
  const S = (d.sectors || []).filter((s) => typeof s.chg === 'number');
  const top = (d.top_in || [])[0] && S.find((s) => s.name === d.top_in[0]);
  if (top) {
    L.push(`가장 센 곳 ${top.name} ${pct(top.chg)}` + (top.total ? ` (${top.total}개 중 ${top.rise}개 상승)` : ''));
  }
  if (S.length) {
    const up = S.filter((s) => s.chg > 0).length;
    const dn = S.filter((s) => s.chg < 0).length;
    L.push(`오른 업종 ${up} · 빠진 업종 ${dn}`);
  }
  return fit(L);
}

/* ── 한 번 돌기 ── */

async function run(env, why) {
  const now = kstNow();
  const today = ymd(now);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const dow = now.getUTCDay();
  const log = { at: now.toISOString().slice(0, 16).replace('T', ' '), why, steps: [] };

  let d = null;
  try {
    d = await getLive();
  } catch (e) {
    log.steps.push('시세 못 받음 · ' + String(e.message || e).slice(0, 120));
  }

  if (d) {
    // 1. 기록. 장중 숫자는 아직 확정이 아니라 쌓지 않는다.
    const td = tradeDate(d);
    const hm = now.toISOString().slice(11, 16);
    if (d.market_status === 'open' && (!td || td === today)) {
      const [n, fresh] = await seed(env);
      let snap = '';
      try {
        snap = ` ${await snapshot(env, d, today, hm)}번째 찍음`;
      } catch (e) {
        snap = ' · 장중 기록 실패';
      }
      log.steps.push('장중' + snap + (fresh ? ` · 기존 기록 ${n}일 옮김` : ''));
    } else {
      // 마감 직후 한 장을 더 찍어 '오늘 흐름' 선이 종가에서 끝나게 한다
      if (td === today && mins >= 15 * 60 + 30 && mins < 16 * 60 + 30) {
        try { await snapshot(env, d, today, '15:30'); } catch (e) {}
      }
      try {
        const day = td || fallbackDay(now);
        const n = await record(env, d, day);
        log.steps.push(`기록 ${day} · 쌓인 날 ${n}일`);
      } catch (e) {
        log.steps.push('기록 실패 · ' + String(e.message || e).slice(0, 120));
      }
    }

    // 2. 아침 헤드라인. 08:00 ~ 09:00 사이 한 번 받아 두고 아침 알림에도 쓴다.
    let news = null;
    if (mins >= 8 * 60 && mins < 9 * 60) {
      try {
        news = await getNews();
        const saved = await archiveNews(env, today, news);
        log.steps.push(saved ? `헤드라인 ${Math.min(news.length, 10)}개 남김` : '헤드라인 이미 남김');
      } catch (e) {
        log.steps.push('헤드라인 못 받음 · ' + String(e.message || e).slice(0, 80));
      }
    }

    // 3. 휴대폰 알림
    const slot = mins >= 8 * 60 && mins < 9 * 60 ? 'am'
      : mins >= 15 * 60 + 35 && mins < 17 * 60 ? 'pm' : null;
    if (!slot) {
      log.steps.push('알림 시간 아님');
    } else if (dow === 0 || dow === 6 || HOLIDAYS.has(today)) {
      log.steps.push('휴장일이라 알림 안 함');
    } else if (slot === 'pm' && td && td !== today) {
      log.steps.push('오늘 장 숫자가 아니라 알림 안 함');
    } else {
      const text = slot === 'am' ? textAM(d, now, news) : textPM(d);
      log.steps.push(await pushOnce(env, `push:${today}:${slot}`, slot, () => {
        const [head, ...rest] = text.split('\n');
        return { title: head.replace(/^\[섹터 흐름판\]\s*/, ''), body: rest.join('\n'), url: SITE + '/', tag: slot };
      }));
      // 마감 뒤 관심 업종 소식. 그 기기가 관심으로 둔 업종이 상위 · 하위 3위에 들었을 때만, 기기마다 다른 글
      if (slot === 'pm') log.steps.push(await watchClose(env, d, today));
    }
  }

  try {
    const runs = (await env.FLOW.get('runs', 'json')) || [];
    runs.unshift(log);
    await env.FLOW.put('runs', JSON.stringify(runs.slice(0, 20)));
  } catch (e) {}
  return log;
}

/* ── 휴대폰 알림 ── */

/** 하루 한 번만 가는 알림. 표시(flag)가 있으면 건너뛴다. 결과를 한 줄로 돌려준다 */
async function pushOnce(env, flag, kind, make, subs) {
  if (await env.FLOW.get(flag)) return '휴대폰 이미 보냄';
  try {
    const r = await pushAll(env, kind, make(), subs);
    if (r.sent) await env.FLOW.put(flag, '1', { expirationTtl: 3 * 86400 });
    return pushNote(r);
  } catch (e) {
    return '휴대폰 실패 · ' + String(e.message || e).slice(0, 120);
  }
}

/** 관심 업종이 오늘 돈이 들어간 곳 · 빠진 곳 3위 안에 들었나. 기기마다 다른 글이라 pushEach 로 간다 */
async function watchClose(env, d, today) {
  const flag = `push:${today}:wa`;
  if (await env.FLOW.get(flag)) return '관심 이미 보냄';
  let subs;
  try {
    subs = await listSubs(env);
  } catch (e) {
    return '관심 구독 못 읽음';
  }
  const S = Object.fromEntries((d.sectors || []).map((s) => [s.name, s]));
  const rank = (list) => Object.fromEntries((list || []).slice(0, 3).map((n, i) => [n, i + 1]));
  const up = rank(d.top_in), dn = rank(d.top_out);
  const r = await pushEach(env, 'wa', subs, (sub) => {
    const names = (sub.watch || []).filter((n) => S[n] && (up[n] || dn[n]));
    if (!names.length) return null;
    const lines = names.map((n) => `${n} ${up[n] ? `들어간 곳 ${up[n]}위` : `빠진 곳 ${dn[n]}위`} ${pct(S[n].chg)}`);
    return { title: `관심 업종 ${names.length === 1 ? names[0] : names.length + '개'} · 오늘 ${up[names[0]] ? '상위' : '하위'}권`, body: lines.join('\n'), url: SITE + '/#s=' + S[names[0]].no, tag: 'wa' };
  });
  if (r.sent) await env.FLOW.put(flag, '1', { expirationTtl: 3 * 86400 });
  return '관심 ' + pushNote(r).replace('휴대폰 ', '');
}

/* ── 큰손 공시 ── */

async function whaleRun(env, force) {
  const log = await whaleRunInner(env, force);
  if (log) {
    try {
      const runs = (await env.FLOW.get('wruns', 'json')) || [];
      runs.unshift(log);
      await env.FLOW.put('wruns', JSON.stringify(runs.slice(0, 30)));
    } catch (e) {}
  }
  return log;
}

async function whaleRunInner(env, force) {
  const now = kstNow();
  const today = ymd(now);
  const h = now.getUTCHours(), dow = now.getUTCDay();
  const mins = h * 60 + now.getUTCMinutes();
  const tradingDay = dow !== 0 && dow !== 6 && !HOLIDAYS.has(today);
  if (!force && (!tradingDay || h < 7 || h > 21)) return null;

  // 바깥 요청은 한 번 돌 때 50개까지. 알림 몫(구독자 수 × 2)을 먼저 떼고 나머지를 DART 와 수급이 나눠 쓴다
  let subs = [];
  try {
    subs = await listSubs(env);
  } catch (e) {}
  const pool = { n: Math.max(12, 44 - subs.length * 2) };
  const log = { at: now.toISOString().slice(0, 16).replace('T', ' '), subs: subs.length };

  // 수급. 15:50부터 그날 치를 다 받을 때까지, 한 번에 28개씩(376개 → 14번, 18시쯤). 그동안 DART 는 나머지로 본다
  let flowToday = null;
  if (tradingDay && mins >= 15 * 60 + 50) {
    try {
      flowToday = await readFlow(env, today);
      if (!flowToday || !flowToday.complete) {
        const want = Math.min(28, pool.n - 10);
        const fb = { n: want };
        const fr = await fetchFlow(env, today, fb, { giveUp: mins >= 17 * 60 + 30 });
        pool.n -= want - fb.n;
        log.flow = fr.why ? fr.why : `${fr.done}/${fr.need}` + (fr.miss ? ` · 아직 ${fr.miss}` : '') + (fr.gone ? ` · 뺌 ${fr.gone}` : '') + (fr.err ? ` · 실패 ${fr.err}` : '') + (fr.complete ? ' · 완료' : '');
        if (fr.complete) flowToday = await readFlow(env, today);
      }
    } catch (e) {
      log.flow = '실패 · ' + String(e.message || e).slice(0, 80);
    }
  } else if (mins < 9 * 60) {
    // 아침 한가할 때 종목 목록을 손본다. 7일마다 한 번
    try {
      const mem = await env.FLOW.get('flow:members', 'json');
      const due = !mem || !mem.at || Date.now() - Date.parse(mem.at) > 7 * 86400 * 1000 || mem.building;
      if (due) {
        const live = await getLive();
        const want = Math.min(20, pool.n - 10);
        const mb = { n: want };
        const mr = await refreshMembers(env, live.sectors || [], mb);
        pool.n -= want - mb.n + 1;
        log.members = mr.skipped ? '최신' : `${mr.got}개 · 남은 ${mr.left}` + (mr.finished ? ' · 완료' : '');
      }
    } catch (e) {
      log.members = '실패 · ' + String(e.message || e).slice(0, 80);
    }
  }

  let r;
  try {
    r = await harvestWhale(env, { budget: pool.n });
  } catch (e) {
    log.err = String(e.message || e).slice(0, 160);
    return log;
  }
  Object.assign(log, r.log);
  if (!subs.length) return log;

  // 아주 큰 공시는 바로 울린다. 오늘 · 어제 공시만, 한 회사 한 번. 여러 건이면 한 알림에 묶는다
  const yday = ymd(new Date(now.getTime() - 86400 * 1000));
  const seen = new Set();
  const hot = r.fresh
    .filter((x) => x.day >= yday && isInstant(x))
    .filter((x) => (seen.has(x.corp) ? false : seen.add(x.corp)));
  if (hot.length) {
    // 누르면 사이트로 간다. 한 건이면 그 업종 상세의 큰손 칸, 여러 건이면 홈의 큰손 칸. DART 원문은 거기서 한 번 더 누르면 된다
    const msg = hot.length === 1
      ? { title: `큰손 · ${hot[0].corp}`, body: `${whatLine(hot[0])}\n${whenLine(hot[0])}`, url: SITE + (hot[0].no ? '/#s=' + hot[0].no : '/#whale'), tag: 'hot-' + hot[0].rcp, hot: true }
      : { title: `큰손 ${hot.length}건`, body: hot.slice(0, 5).map((x) => `${x.corp} | ${whatLine(x)}`).join('\n'), url: SITE + '/#whale', tag: 'hot-' + hot[0].rcp, hot: true };
    try {
      log.hot = pushNote(await pushAll(env, 'hot', msg, subs));
    } catch (e) {
      log.hot = '실패 · ' + String(e.message || e).slice(0, 80);
    }
  }

  // 관심 업종 종목에 난 눈여겨볼 공시. 기기마다 그 기기 관심 업종 것만, 한 번에 세 건까지
  const byNo = {};
  const hotRcp = new Set(hot.map((x) => x.rcp));
  for (const x of r.fresh) if (x.hi && x.no && x.day >= yday) (byNo[x.no] || (byNo[x.no] = [])).push(x);
  if (Object.keys(byNo).length) {
    const wr = await pushEach(env, 'wa', subs, (sub) => {
      const mine = [];
      (sub.watch_no || []).forEach((no, i) => { for (const x of byNo[no] || []) mine.push(Object.assign({ sec: (sub.watch || [])[i] || '' }, x)); });
      // 아주 큰 공시로 이미 그 기기에 간 것은 또 보내지 않는다
      const hotOff = !!(sub.prefs && sub.prefs.hot === false);
      const pick = mine.filter((x) => hotOff || !hotRcp.has(x.rcp)).slice(0, 3);
      if (!pick.length) return null;
      return pick.length === 1
        ? { title: `관심 ${pick[0].sec} · ${pick[0].corp}`, body: `${whatLine(pick[0])}\n${whenLine(pick[0])}`, url: SITE + '/#s=' + pick[0].no, tag: 'wa-' + pick[0].rcp }
        : { title: `관심 업종 큰손 ${pick.length}건`, body: pick.map((x) => `${x.corp} | ${whatLine(x)}`).join('\n'), url: SITE + '/#s=' + pick[0].no, tag: 'wa-' + pick[0].rcp };
    });
    if (wr.n) log.watch = pushNote(wr);
  }

  // 저녁 요약. 18:30 이 지나고 처음 도는 차례에 한 번
  if (mins >= 18 * 60 + 30) {
    const dg = digest(r.out.items || [], today);
    // 수급이 다 받아졌으면 외국인 · 기관이 산 업종을 두 줄 덧붙인다
    const fl = flowToday && flowToday.complete ? [flowLine(flowToday, 'f', '외국인'), flowLine(flowToday, 'i', '기관')].filter(Boolean) : [];
    const msg = dg ? { title: dg.title, body: fl.length ? fl.join('\n') + '\n' + dg.body : dg.body }
      : fl.length ? { title: `오늘 수급 ${today.slice(5).replace('-', '/')}`, body: fl.join('\n') } : null;
    if (msg) log.digest = await pushOnce(env, `push:${today}:wh`, 'wh', () => Object.assign(msg, { url: SITE + '/#flow', tag: 'wh' }), subs);
  }
  return log;
}

/* ── 바깥에서 보는 창 ── */

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 1), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === WHALE_CRON) ctx.waitUntil(whaleRun(env, false));
    else ctx.waitUntil(run(env, event.cron));
  },

  async fetch(req, env) {
    const u = new URL(req.url);

    // 상태: 기록이 며칠 쌓였나, 알림 기기가 몇 대인가, 최근에 뭘 했나.
    if (u.pathname === '/' || u.pathname === '/status') {
      const hist = await env.FLOW.get('history', 'json');
      const runs = (await env.FLOW.get('runs', 'json')) || [];
      const ws = await env.FLOW.get('whale:at', 'json');
      const wruns = (await env.FLOW.get('wruns', 'json')) || [];
      return json({
        days: hist && hist.days ? hist.days.map((x) => x.d) : [],
        whale: ws ? { checked: ws.at || null, last: ws.log || null } : null,
        flow: { latest: await env.FLOW.get('flow:latest') },
        push: { devices: (await env.FLOW.list({ prefix: 'sub:' })).keys.length },
        runs: runs.slice(0, 10),
        wruns: wruns.slice(0, 12),
      });
    }

    // 기록 원본. 공개 시세라 감출 게 없다.
    if (u.pathname === '/history') {
      return json((await env.FLOW.get('history', 'json')) || { unit: 'industry', days: [] });
    }

    // 손으로 한 번 돌리기. 아무나 마구 누르지 못하게 5분에 한 번만 받는다.
    if (u.pathname === '/run') {
      const last = await env.FLOW.get('manual_at');
      if (last && Date.now() - Number(last) < 5 * 60 * 1000) {
        return json({ ok: false, why: '5분 안에 다시 돌릴 수 없습니다' }, 429);
      }
      await env.FLOW.put('manual_at', String(Date.now()), { expirationTtl: 3600 });
      return json({ ok: true, log: await run(env, 'manual') });
    }

    // 큰손 공시 손으로 한 번 모으기. 2분에 한 번만.
    if (u.pathname === '/whale') {
      const last = await env.FLOW.get('whale_manual_at');
      if (last && Date.now() - Number(last) < 2 * 60 * 1000) {
        return json({ ok: false, why: '2분 안에 다시 돌릴 수 없습니다' }, 429);
      }
      await env.FLOW.put('whale_manual_at', String(Date.now()), { expirationTtl: 3600 });
      return json({ ok: true, log: await whaleRun(env, true) });
    }

    return json({ error: 'not found' }, 404);
  },
};
