/**
 * 섹터 흐름판 · 예약 실행기  (Cloudflare Worker)
 *
 * GitHub 예약 실행은 제때 돌지 않았다. 그래서 시계를 Cloudflare 로 옮겼다.
 * 이 실행기가 하는 일은 세 가지다.
 *
 *   1. 장중 10분마다 업종 등락률을 찍어 둔다(intra:날짜). '지난 30분' 과 '오늘 흐름' 선이 여기서 나온다.
 *   2. 마감 뒤 하루치 업종 등락률을 쌓는다(history). 상세 화면의 캔들이 여기서 나온다.
 *   3. 개장 전 · 마감 뒤에 카카오톡 '나에게 보내기'로 요약을 보낸다.
 *   4. 개장 전 한 번 경제 헤드라인(네이버 증권 주요 뉴스 제목)을 날짜별로 남긴다(news:날짜).
 *      나중에 '그 뉴스가 나온 날 돈이 실제로 어디로 갔나'를 되짚는 기록이다.
 *   5. 평일 07:00 ~ 21:59 10분마다 DART 에서 '큰손' 공시를 모은다(whale.js).
 *      5% 대량보유 보고와 임원 · 주요주주 매매 보고. 화면 '큰손 움직임'이 여기서 나온다.
 *
 * 예약 (UTC. 한국시간 = UTC + 9. Cloudflare 는 요일을 이름으로 적는다)
 *   *\/10 0-6 * * MON-FRI  09:00 ~ 15:50  10분마다. 15:40 · 15:50 은 마감 뒤 기록과 알림
 *   37,47 23 * * SUN-THU   08:37 · 08:47  개장 전 (한국 월~금 아침)
 *   3,13,23,33,43,53 * * * *   10분마다 DART 확인. 한국 평일 07~21시가 아니면 바로 끝낸다
 * 같은 알림은 하루에 한 번만 간다. 앞 순번이 성공하면 뒤 순번은 건너뛴다.
 *
 * 저장소(KV) 키
 *   history   하루치 업종 등락률 60일
 *   kakao     카카오 REST 키 · 리프레시 토큰. /kakao 페이지가 넣는다. 밖으로 보여주지 않는다.
 *   intra:날짜  장중 10분 간격 업종 등락률. 나흘 뒤 저절로 지워진다.
 *   runs      최근 실행 기록 20개
 *   news:날짜   그날 아침 헤드라인 제목 10개. 1년 뒤 저절로 지워진다.
 *   sent:날짜:am|pm   그날 알림을 보냈다는 표시. 사흘 뒤 저절로 지워진다.
 *   whale:v1 · whale:seen · whale:map   큰손 공시 목록 · 이미 본 공시 · 종목코드 표 (whale.js 참고)
 */

import { harvestWhale } from './whale.js';

const WHALE_CRON = '3,13,23,33,43,53 * * * *';

const SITE = 'https://lucent-sector.pages.dev';
const KEEP_DAYS = 60;

/** 한국거래소 휴장일 (2026년, 증권사 공지 기준). 주말은 따로 거른다. 해가 바뀌면 여기에 더한다. */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01',
  '2026-05-05', '2026-05-25', '2026-06-03', '2026-07-17', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25', '2026-12-31',
]);

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

/* ── 2. 카카오톡 ── */

async function kakaoAccess(env) {
  const k = await env.FLOW.get('kakao', 'json');
  if (!k || !k.key || !k.refresh) return null;
  const form = { grant_type: 'refresh_token', client_id: k.key, refresh_token: k.refresh };
  if (k.secret) form.client_secret = k.secret;
  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(form),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('토큰 갱신 실패 ' + JSON.stringify(j).slice(0, 160));
  // 만료가 한 달 안으로 다가오면 카카오가 새 리프레시 토큰을 준다. 받은 즉시 바꿔 끼운다.
  if (j.refresh_token) {
    k.refresh = j.refresh_token;
    k.renewed_at = new Date().toISOString();
    await env.FLOW.put('kakao', JSON.stringify(k));
  }
  return j.access_token;
}

async function sendMemo(token, text) {
  const tpl = {
    object_type: 'text',
    text,
    link: { web_url: SITE, mobile_web_url: SITE },
    button_title: '열어보기',
  };
  const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.result_code !== 0) throw new Error('전송 실패 ' + JSON.stringify(j).slice(0, 160));
}

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

/** 카카오 글자 한도(200자)를 넘기면 뒤쪽 줄부터 통째로 뺀다. 줄 중간이 잘리지 않게. */
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

    // 2. 아침 헤드라인. 08:00 ~ 09:00 사이 한 번 받아 두고 카톡에도 쓴다.
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

    // 3. 카톡
    const slot = mins >= 8 * 60 && mins < 9 * 60 ? 'am'
      : mins >= 15 * 60 + 35 && mins < 17 * 60 ? 'pm' : null;
    if (!slot) {
      log.steps.push('알림 시간 아님');
    } else if (dow === 0 || dow === 6 || HOLIDAYS.has(today)) {
      log.steps.push('휴장일이라 알림 안 함');
    } else if (slot === 'pm' && td && td !== today) {
      log.steps.push('오늘 장 숫자가 아니라 알림 안 함');
    } else {
      const flag = `sent:${today}:${slot}`;
      if (await env.FLOW.get(flag)) {
        log.steps.push('알림 이미 보냄');
      } else {
        try {
          const tok = await kakaoAccess(env);
          if (!tok) {
            log.steps.push('카톡 연결 전');
          } else {
            await sendMemo(tok, slot === 'am' ? textAM(d, now, news) : textPM(d));
            await env.FLOW.put(flag, '1', { expirationTtl: 3 * 86400 });
            log.steps.push('카톡 보냄');
          }
        } catch (e) {
          log.steps.push('카톡 실패 · ' + String(e.message || e).slice(0, 160));
        }
      }
    }
  }

  try {
    const runs = (await env.FLOW.get('runs', 'json')) || [];
    runs.unshift(log);
    await env.FLOW.put('runs', JSON.stringify(runs.slice(0, 20)));
  } catch (e) {}
  return log;
}

/* ── 큰손 공시 ── */

async function whaleRun(env, force) {
  const now = kstNow();
  const h = now.getUTCHours(), dow = now.getUTCDay();
  if (!force && (dow === 0 || dow === 6 || HOLIDAYS.has(ymd(now)) || h < 7 || h > 21)) return null;
  try {
    const r = await harvestWhale(env, { budget: 40 });
    return r.log;
  } catch (e) {
    return { err: String(e.message || e).slice(0, 160) };
  }
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

    // 상태: 기록이 며칠 쌓였나, 카톡이 연결됐나, 최근에 뭘 했나. 토큰은 보여주지 않는다.
    if (u.pathname === '/' || u.pathname === '/status') {
      const hist = await env.FLOW.get('history', 'json');
      const k = await env.FLOW.get('kakao', 'json');
      const runs = (await env.FLOW.get('runs', 'json')) || [];
      const ws = await env.FLOW.get('whale:at', 'json');
      return json({
        days: hist && hist.days ? hist.days.map((x) => x.d) : [],
        kakao: k ? { connected: true, saved_at: k.saved_at || null, renewed_at: k.renewed_at || null } : { connected: false },
        whale: ws ? { checked: ws.at || null, last: ws.log || null } : null,
        runs: runs.slice(0, 10),
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
