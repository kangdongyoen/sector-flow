/**
 * 큰손 움직임 · DART 공시 수집기  (lucent-sector-cron 안에서 돈다)
 *
 * 공시 두 가지만 본다.
 *   D001 주식등의대량보유상황보고서            5% 넘게 가진 사람 · 기관의 지분이 바뀐 기록
 *   D002 임원ㆍ주요주주특정증권등소유상황보고서   회사 사람이 주식을 사고판 기록
 *
 * 남기는 기준
 *   5%   지분율이 실제로 바뀐 것만. 담보계약 · 계약 변경처럼 숫자가 그대로인 보고는 버린다.
 *   임원  장내매수 · 장내매도 · 시간외매매만. 스톡옵션 · 성과주식 · 증여 · 전환은 버린다.
 *        합쳐서 5천만원이 안 되는 매매도 버린다.
 *   정정 보고([기재정정])와 코스피 · 코스닥 밖 회사는 보지 않는다.
 *
 * 한 번 돌 때 DART 에 보내는 요청은 budget 개를 넘지 않는다(무료 요금제 한도 50).
 * 못 본 공시는 다음 차례에 이어서 본다. 목록은 최근 4일치만 훑는다.
 *
 * 저장소(KV)
 *   whale:v1    화면이 읽는 목록. 45일치, 많아야 400건
 *   whale:seen  이미 열어 본 접수번호와 마지막 실행 기록. 같은 공시를 두 번 열지 않는다
 *   whale:map   DART 회사번호 → 종목코드, 종목코드 → 네이버 업종번호
 *
 * 숫자는 공시 원문 그대로 옮긴다. 해석하거나 점수를 매기지 않는다.
 */

const DART = 'https://dart.fss.or.kr';
const NAVER = 'https://m.stock.naver.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html,application/json,*/*;q=0.8' };

const KEEP_DAYS = 45;
const MAX_ITEMS = 400;
const MIN_AMT = 5e7; // 임원 매매 최소 금액(원)

/* 시험할 때 요청 경로를 바꿔 끼울 수 있게 */
let F = (u, i) => fetch(u, i);
export const setFetch = (f) => {
  F = f;
};

/* ── 글자 다루기 ── */

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·' };
export const txt = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const v = ENT[e.toLowerCase()];
      return v === undefined ? m : v;
    })
    .replace(/[\s 　]+/g, ' ')
    .trim();

const sq = (s) => String(s || '').replace(/\s/g, '');

/** 표 칸을 순서대로 */
export function cells(h) {
  const out = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(h))) out.push(txt(m[1]));
  return out;
}

function after(cs, label, k = 1) {
  const L = sq(label);
  const i = cs.findIndex((x) => sq(x) === L);
  return i >= 0 && i + k < cs.length ? cs[i + k] : null;
}

const num = (s) => {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

/** '2026년 09월 17일' · '2026.09.17' · '2026-09-17' → '2026-09-17' */
const ymdOf = (s) => {
  const m = String(s || '').match(/(\d{4})\s*[.년\-/]\s*(\d{1,2})\s*[.월\-/]\s*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};

const cut = (t, n) => {
  const a = [...String(t || '')];
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
};

/** 회사 · 기관 이름에서 법인 꼬리표를 뗀다 */
const tidy = (n) =>
  String(n || '')
    .replace(/주식회사|\(주\)|㈜|\(유\)|유한회사/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ── DART 받기 ── */

async function get(url, init = {}) {
  const r = await F(url, Object.assign({}, init, { headers: Object.assign({}, H, init.headers || {}) }));
  if (!r.ok) throw new Error(r.status + ' ' + url.replace(DART, '').replace(NAVER, '').slice(0, 40));
  return r.text();
}

/** 공시통합검색. 최신순 한 쪽 */
export async function list(type, start, end, size = 100, page = 1) {
  const body = new URLSearchParams({
    currentPage: String(page), maxResults: String(size), maxLinks: '10', sort: 'date', series: 'desc',
    textCrpCik: '', lateKeyword: '', keyword: '', reportNamePopYn: '', textkeyword: '',
    businessCode: 'all', autoSearch: 'N', option: 'corp', textCrpNm: '', reportName: '', tocSrch: '',
    textPresenterNm: '', startDate: start, endDate: end, decadeType: '', finalReport: 'recent',
    businessNm: '', corporationType: '', closingAccountsMonth: '', tocSrch2: '', publicType: type,
  }).toString();
  const h = await get(DART + '/dsab007/detailSearch.ax', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: DART + '/dsab007/main.do',
    },
  });
  const rows = [];
  for (const tr of h.split(/<tr[\s>]/).slice(1)) {
    const rcp = (tr.match(/rcpNo=(\d{14})/) || [])[1];
    if (!rcp) continue;
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
    if (tds.length < 5) continue;
    rows.push({
      rcp,
      type,
      mkt: (tr.match(/tagCom_(kospi|kosdaq|konex|etc)"/) || [])[1] || '',
      cik: (tr.match(/openCorpInfoNew\('(\d+)'/) || [])[1] || '',
      corp: txt(tds[1].replace(/<span class="tagCom[^"]*"[^>]*>[\s\S]*?<\/span>/g, '')),
      rpt: txt(tds[2]),
      by: txt(tds[3]),
      day: ymdOf(txt(tds[4])),
    });
  }
  return rows;
}

/** 공시 문서의 목차. 각 칸을 따로 열 때 필요한 번호가 여기 있다 */
async function toc(rcp) {
  const h = await get(`${DART}/dsaf001/main.do?rcpNo=${rcp}`);
  const out = [];
  const re =
    /node\d+\['text'\] = "([^"]*)";[\s\S]*?node\d+\['dcmNo'\] = "(\d+)";\s*node\d+\['eleId'\] = "(\d+)";\s*node\d+\['offset'\] = "(\d+)";\s*node\d+\['length'\] = "(\d+)";\s*node\d+\['dtd'\] = "([^"]*)"/g;
  let m;
  while ((m = re.exec(h))) out.push({ t: txt(m[1]), dcm: m[2], ele: m[3], off: m[4], len: m[5], dtd: m[6] });
  return out;
}

const part = (rcp, n) =>
  get(`${DART}/report/viewer.do?rcpNo=${rcp}&dcmNo=${n.dcm}&eleId=${n.ele}&offset=${n.off}&length=${n.len}&dtd=${n.dtd}`);

/* ── 공시 읽기 ── */

/** 5% 보고 첫 장(요약정보) */
export function parse5(h) {
  const cs = cells(h);
  const flat = txt(h);
  const r = {};
  r.ev = ymdOf((flat.match(/보고의무발생일[^0-9]{0,12}([0-9][0-9.\s년월일-]{7,16})/) || [])[1]);
  const w = flat.match(/보고자\s*:\s*(.+?)\s*요약정보/);
  r.who = w ? w[1].split('위 대리인')[0].trim() : null;
  r.rel = after(cs, '발행회사와의 관계');
  r.kind = after(cs, '보고구분');
  r.reason = after(cs, '보고사유');
  r.purpose = /약식서식/.test(flat) ? after(cs, '보유목적') : '경영권 영향';
  const i = cs.findIndex((x) => sq(x) === '보유주식등의수및보유비율');
  if (i >= 0) {
    const seg = cs.slice(i, i + 12);
    const a = seg.findIndex((x) => sq(x) === '직전보고서');
    const b = seg.findIndex((x) => sq(x) === '이번보고서');
    if (a >= 0) {
      r.sh0 = num(seg[a + 1]);
      r.p0 = num(seg[a + 2]);
    }
    if (b >= 0) {
      r.sh1 = num(seg[b + 1]);
      r.p1 = num(seg[b + 2]);
    }
  }
  return r;
}

/** 임원 보고 '3. 특정증권등의 소유상황' 세부변동내역 */
export function parseTrades(h) {
  const cs = cells(h);
  const i = cs.findIndex((x) => sq(x) === '보고사유');
  const out = [];
  if (i < 0) return out;
  for (let k = i + 1; k < cs.length; k++) {
    if (sq(cs[k]) === '합계') break;
    const m = cs[k].match(/^(.+)\(([+-])\)$/);
    if (!m) continue;
    const row = cs.slice(k, k + 9);
    out.push({ why: sq(m[1]), sign: m[2], day: ymdOf(row[1]), sort: row[2], d: num(row[4]), px: num(row[6]) });
    k += 8;
  }
  return out;
}

/** 임원 보고 '2. 보고자에 관한 사항' */
export function parseRole(h) {
  const cs = cells(h);
  const role = after(cs, '직위명');
  const major = after(cs, '주요주주');
  const clean = (v) => (v && !/^[-–\s]*$/.test(v) ? v : null);
  return { role: clean(role), major: !!clean(major), type: clean(after(cs, '보고자 구분')) };
}

/** 누가 움직였나. 이름과 회사와의 관계로만 나눈다 */
export function whoKind(name, rel) {
  const n = String(name || '');
  if (/국민연금/.test(n)) return '국민연금';
  if (/사학연금|공무원연금|교직원공제|군인공제|우정사업|한국투자공사|새마을금고중앙회/.test(n)) return '연기금';
  if (/최대주주|사실상지배/.test(rel || '')) return '최대주주';
  if (/우리사주/.test(n)) return '우리사주';
  if (/[A-Za-z]{3,}/.test(n) && !/[가-힣]{2,}/.test(n)) return '외국계';
  if (/엘엘씨|리미티드|인코퍼레이티드|피엘씨|매니지먼트|에이지$|엘피$|인크$/.test(n)) return '외국계';
  if (/조합/.test(n)) return '투자조합';
  if (/운용|투자신탁|투자자문|투자일임|인베스트|파트너스|캐피탈|사모|벤처스|펀드|신기술/.test(n)) return '운용사';
  if (/증권|은행|보험|생명|화재|금융|저축|카드|공제/.test(n)) return '금융사';
  if (/주식회사|\(주\)|㈜|홀딩스|지주|코퍼레이션|유한회사|재단|법인|그룹/.test(n)) return '법인';
  return '개인';
}

/** 보고사유에서 짧은 꼬리표 두 개까지 */
export function tag5(reason) {
  const s = String(reason || '');
  const t = [];
  // 빚을 못 갚아 담보로 잡힌 주식이 넘어가거나 팔린 것. 투자 판단이 아니다
  if (/담보\s*처분|담보권\s*실행|기한\s*이익\s*상실|반대\s*매매/.test(s)) return ['담보 처분'];
  const comp = /매수선택권|주식매수청구|양도제한|RSU/i.test(s);
  if (/장내\s*매수|장내에서[^,.]*매수/.test(s)) t.push('장내 매수');
  else if (/매수|취득/.test(s) && !comp) t.push('매수');
  if (/장내\s*매도|장내에서[^,.]*매도/.test(s)) t.push('장내 매도');
  else if (/매도|처분/.test(s)) t.push('매도');
  if (/시간외|블록딜|대량매매/.test(s)) t.push('시간외');
  if (/공개매수/.test(s)) t.push('공개매수');
  if (/양수도|경영권\s*(인수|양수)/.test(s)) t.push('경영권 거래');
  if (/유상증자|제3자\s*배정|신주\s*(취득|인수|배정)/.test(s)) t.push('증자');
  if (/증여|수증/.test(s)) t.push('증여');
  if (/상속/.test(s)) t.push('상속');
  if (/전환|교환|신주인수권/.test(s)) t.push('전환');
  if (/합병|분할/.test(s)) t.push('합병');
  if (/발행주식\s*총수|감자|무상/.test(s)) t.push('주식수 변동');
  if (comp) t.push('보상주식');
  return [...new Set(t)].slice(0, 2);
}

const TRADE = new Set(['장내 매수', '매수', '장내 매도', '매도', '시간외', '공개매수', '증자', '경영권 거래']);

/** 홈에 올릴 만한 5% 보고인가: 돈이 오간 변동이면서 0.5%p 이상 바뀌었거나, 새로 5%를 넘었거나, 5% 아래로 내려간 것 */
export function hi5(x) {
  const tags = x.tags || [];
  if (tags.some((t) => t === '증여' || t === '상속' || t === '담보 처분')) return 0;
  const isNew = /신규/.test(x.kind || '');
  const trade = tags.some((t) => TRADE.has(t)) || (isNew && !tags.length);
  if (!trade) return 0;
  if (isNew) return x.p1 >= 5 ? 1 : 0;
  return Math.abs(x.d) >= 0.5 || (x.p0 >= 5 && x.p1 < 5) ? 1 : 0;
}

/* ── 공시 한 건 처리 ── */

async function codeOf(row, nodes, map, budget) {
  if (map.c[row.cik]) return map.c[row.cik];
  const n = nodes.find((x) => /^1\.\s*발행회사/.test(x.t));
  if (!n || budget.n < 1) return null;
  budget.n--;
  const code = (after(cells(await part(row.rcp, n)), '회사코드') || '').replace(/\D/g, '');
  if (code.length === 6) {
    map.c[row.cik] = code;
    map.dirty = true;
    return code;
  }
  return null;
}

async function industryOf(code, map, budget) {
  if (!code) return null;
  if (code in map.i) return map.i[code] || null;
  if (budget.n < 1) return null;
  budget.n--;
  try {
    const t = await get(`${NAVER}/api/stock/${code}/integration`, {
      headers: { referer: NAVER + '/', accept: 'application/json' },
    });
    const no = Number((t.match(/"industryCode"\s*:\s*"?(\d+)/) || [])[1]) || 0;
    map.i[code] = no;
    map.dirty = true;
    return no || null;
  } catch (e) {
    return null;
  }
}

/** 5% 보고 한 건 → 남길 만하면 한 줄, 아니면 null */
async function do5(row, map, budget) {
  budget.n--;
  const nodes = await toc(row.rcp);
  if (!nodes.length) return null;
  budget.n--;
  const p = parse5(await part(row.rcp, nodes[0]));
  const isNew = /신규/.test(p.kind || '');
  const p0 = p.p0 === null || p.p0 === undefined ? 0 : p.p0;
  const p1 = p.p1;
  if (typeof p1 !== 'number') return null;
  const d = Math.round((p1 - p0) * 100) / 100;
  if (!isNew && Math.abs(d) < 0.01) return null; // 지분이 그대로면 담보 · 계약 얘기다
  // 대표보고자가 바뀐 보고는 서로 다른 사람의 지분을 견주게 돼서 증감이 뜻이 없다
  if (/대표\s*보고자/.test(p.reason || '')) return null;
  const tags = tag5(p.reason);
  const code = await codeOf(row, nodes, map, budget);
  const no = await industryOf(code, map, budget);
  const who = tidy(p.who || row.by);
  const wk = whoKind(p.who || row.by, p.rel);
  const it = {
    k: '5',
    rcp: row.rcp,
    day: row.day,
    ev: p.ev || row.day,
    corp: tidy(row.corp),
    code,
    no,
    mkt: row.mkt,
    who: cut(who, 40),
    wk,
    rel: p.rel || null,
    kind: p.kind || null,
    pur: p.purpose || null,
    p0: p.p0 === null || p.p0 === undefined ? null : p.p0,
    p1,
    d,
    tags,
    rs: cut(String(p.reason || '').replace(/^[-\s]+/, ''), 70),
  };
  it.hi = hi5(it);
  return it;
}

/** 임원 · 주요주주 보고 한 건 */
async function doIn(row, map, budget) {
  budget.n--;
  const nodes = await toc(row.rcp);
  const n3 = nodes.find((x) => /^3\.\s*특정증권/.test(x.t));
  if (!n3) return null;
  budget.n--;
  const all = parseTrades(await part(row.rcp, n3));
  const tr = all.filter(
    (x) => /^(장내매수|장내매도|시간외매매)$/.test(x.why) && /주/.test(x.sort || '') && !/사채/.test(x.sort || '')
  );
  if (!tr.length) return null;
  let amt = 0, sh = 0, gross = 0, gsh = 0, last = null, first = null;
  for (const x of tr) {
    const q = Math.abs(x.d || 0) * (x.sign === '-' ? -1 : 1);
    sh += q;
    if (x.px) {
      amt += q * x.px;
      gross += Math.abs(q) * x.px;
      gsh += Math.abs(q);
    }
    // 변동일은 결제일이다. 보고일보다 뒤로 적힌 날짜는 믿지 않는다
    if (x.day && x.day <= row.day) {
      if (!last || x.day > last) last = x.day;
      if (!first || x.day < first) first = x.day;
    }
  }
  if (Math.abs(amt) < MIN_AMT) return null;
  const n2 = nodes.find((x) => /^2\.\s*보고자/.test(x.t));
  let role = { role: null, major: false };
  if (n2 && budget.n >= 1) {
    budget.n--;
    role = parseRole(await part(row.rcp, n2));
  }
  const code = await codeOf(row, nodes, map, budget);
  const no = await industryOf(code, map, budget);
  const kinds = [...new Set(tr.map((x) => x.why))];
  const tags = kinds.map((w) =>
    w === '시간외매매' ? (sh >= 0 ? '시간외 매수' : '시간외 매도') : w === '장내매수' ? '장내 매수' : '장내 매도'
  );
  return {
    k: 'in',
    rcp: row.rcp,
    day: row.day,
    ev: last || row.day,
    ev0: first && first !== last ? first : null,
    corp: tidy(row.corp),
    code,
    no,
    mkt: row.mkt,
    who: cut(tidy(row.by), 40),
    wk: role.role ? '임원' : role.major ? '주요주주' : whoKind(row.by, ''),
    role: role.role ? cut(role.role, 16) : role.major ? '주요주주' : null,
    amt: Math.round(amt),
    sh: Math.round(sh),
    px: gsh ? Math.round(gross / gsh) : null,
    tags: [...new Set(tags)].slice(0, 2),
    hi: Math.abs(amt) >= 1e8 ? 1 : 0,
  };
}

/** 공시 한 건. 목록 한 줄을 받아 남길 줄을 돌려준다(버릴 것이면 null) */
export const one = (row, map, budget) => (row.type === 'D001' ? do5(row, map, budget) : doIn(row, map, budget));

/* ── 한 번 돌기 ── */

/** 열어 볼 필요도 없는 공시: 정정 보고, 코스피 · 코스닥 밖, 리츠 · 스팩 */
export const junk = (r) =>
  /기재정정|첨부정정|첨부추가/.test(r.rpt) || !/^(kospi|kosdaq)$/.test(r.mkt) || /리츠|스팩|기업인수목적/.test(r.corp);

const ymd8 = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function kvJSON(env, key, dflt) {
  try {
    const v = await env.FLOW.get(key, 'json');
    return v || dflt;
  } catch (e) {
    return dflt;
  }
}

/**
 * opt.budget  DART · 네이버에 보낼 요청 상한 (기본 40)
 * opt.days    목록을 며칠 거슬러 볼지 (기본 4)
 * opt.store   false 면 저장하지 않고 결과만 돌려준다(시험용)
 */
export async function harvestWhale(env, opt = {}) {
  const budget = { n: opt.budget || 40 };
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const today = now.toISOString().slice(0, 10);
  const end = ymd8(now);
  const start = ymd8(new Date(now.getTime() - (opt.days || 4) * 86400 * 1000));
  const cur = opt.cur || (await kvJSON(env, 'whale:v1', { items: [] }));
  const seenBox = opt.seen || (await kvJSON(env, 'whale:seen', { r: {} }));
  const map = opt.map || (await kvJSON(env, 'whale:map', { c: {}, i: {} }));
  map.c = map.c || {};
  map.i = map.i || {};
  const seen = seenBox.r || {};
  const log = { at: now.toISOString().slice(0, 16).replace('T', ' '), got: 0, skip: 0, err: 0, left: 0 };

  // 1. 목록
  let rows = [];
  for (const t of ['D001', 'D002']) {
    if (budget.n < 2) break;
    budget.n--;
    try {
      rows = rows.concat(await list(t, start, end, opt.size || 100));
    } catch (e) {
      log.err++;
      log.why = String(e.message || e).slice(0, 80);
    }
  }

  // 2. 안 본 것만, 최신부터
  const todo = [];
  for (const r of rows) {
    if (seen[r.rcp]) continue;
    if (junk(r)) {
      seen[r.rcp] = r.day || today;
      log.skip++;
      continue;
    }
    todo.push(r);
  }
  todo.sort((a, b) => (a.rcp < b.rcp ? 1 : -1));

  // 3. 하나씩 연다
  const fresh = [];
  let i = 0, opened = 0;
  for (; i < todo.length; i++) {
    const r = todo[i];
    if (budget.n < 5) break;
    try {
      const it = await one(r, map, budget);
      if (it) fresh.push(it);
      else log.skip++;
      seen[r.rcp] = r.day || today;
      opened++;
    } catch (e) {
      log.err++;
      log.why = String(e.message || e).slice(0, 80);
    }
  }
  log.left = todo.length - i;
  log.got = fresh.length;

  // 4. 합치고 오래된 것 버리기
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const byRcp = new Map((cur.items || []).map((x) => [x.rcp, x]));
  for (const x of fresh) byRcp.set(x.rcp, x);
  const items = [...byRcp.values()]
    .filter((x) => x.day >= cutoff)
    .sort((a, b) => (a.day === b.day ? (a.rcp < b.rcp ? 1 : -1) : a.day < b.day ? 1 : -1))
    .slice(0, MAX_ITEMS);
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];

  const out = { updated: fresh.length ? log.at : cur.updated || null, items };
  if (opt.store !== false) {
    const writes = [];
    if (fresh.length) writes.push(env.FLOW.put('whale:v1', JSON.stringify(out)));
    if (log.skip || opened) {
      writes.push(env.FLOW.put('whale:seen', JSON.stringify({ at: log.at, log, r: seen })));
    }
    if (map.dirty) {
      delete map.dirty;
      writes.push(env.FLOW.put('whale:map', JSON.stringify(map)));
    }
    await Promise.all(writes);
  }
  return { log, out, seen, map, fresh };
}
