#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
섹터 흐름판 - 데이터 수집기
종목이 아니라 섹터/자산군 단위로만 본다.
"""
import json, os, sys, warnings
from datetime import datetime, timezone, timedelta
import yfinance as yf
import pandas as pd

warnings.filterwarnings('ignore')
KST = timezone(timedelta(hours=9))
BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, 'data')
os.makedirs(DATA, exist_ok=True)

# 한국 섹터 = 섹터 대표 ETF (개별 종목 아님)
SECTORS = {
# (섹터명, 대표 ETF 한글명, 근거로 볼 글로벌 신호)
    '091160.KS': ('반도체',     'KODEX 반도체',        '^SOX'),
    '266370.KS': ('IT하드웨어', 'KODEX IT하드웨어',    '^SOX'),
    '139260.KS': ('IT대형주',   'TIGER 200 IT',        '^SOX'),
    '305720.KS': ('2차전지',    'KODEX 2차전지산업',   'NQ=F'),
    '244580.KS': ('바이오',     'KODEX 바이오',        '^TNX'),
    '091180.KS': ('자동차',     'KODEX 자동차',        'KRW=X'),
    '102960.KS': ('조선',       'KODEX 조선',          'KRW=X'),
    '139230.KS': ('중공업',     'TIGER 200 중공업',    'KRW=X'),
    '091170.KS': ('은행',       'KODEX 은행',          '^TNX'),
    '102970.KS': ('증권',       'KODEX 증권',          '^KS11'),
    '117700.KS': ('건설',       'KODEX 건설',          '^TNX'),
    '117460.KS': ('에너지화학', 'KODEX 에너지화학',    'CL=F'),
    '140710.KS': ('운송',       'KODEX 운송',          'CL=F'),
    '228790.KS': ('화장품',     'TIGER 화장품',        '^KS11'),
    '266390.KS': ('소비재',     'KODEX 경기소비재',    '^KS11'),
}

# 글로벌 신호
GLOBALS = {
    'NQ=F':      ('나스닥 선물', 'idx', ''),
    'ES=F':      ('S&P500 선물', 'idx', ''),
    '^SOX':      ('미국 반도체', 'idx', ''),
    '^KS11':     ('코스피', 'kr', ''),
    '^KQ11':     ('코스닥', 'kr', ''),
    'KRW=X':     ('원달러', 'fx', '원'),
    'DX-Y.NYB':  ('달러인덱스', 'fx', ''),
    'CL=F':      ('유가(WTI)', 'cmd', '$'),
    'GC=F':      ('금', 'cmd', '$'),
    '^TNX':      ('미국 10년 금리', 'rate', '%'),
    '^VIX':      ('공포지수(VIX)', 'risk', ''),
    'BTC-USD':   ('비트코인', 'crypto', '$'),
}


def pct(a, b):
    if b in (None, 0) or pd.isna(a) or pd.isna(b):
        return None
    return round((a / b - 1) * 100, 2)


def fetch(tickers, period='3mo'):
    """여러 티커를 한 번에. 실패한 티커는 조용히 빠짐."""
    df = yf.download(list(tickers), period=period, progress=False,
                     auto_adjust=True, group_by='ticker', threads=True)
    return df


def series_for(df, tk, field):
    try:
        s = df[tk][field].dropna()
        return s if len(s) else None
    except Exception:
        return None


def streak(returns):
    """연속 상승/하락 일수. 부호가 바뀌면 끊김."""
    if returns is None or len(returns) < 2:
        return 0, 0
    r = returns.dropna().values
    if len(r) == 0:
        return 0, 0
    sign = 1 if r[-1] > 0 else (-1 if r[-1] < 0 else 0)
    if sign == 0:
        return 0, 0
    n = 0
    for v in reversed(r):
        if (v > 0 and sign > 0) or (v < 0 and sign < 0):
            n += 1
        else:
            break
    return sign, n


def collect_sectors():
    df = fetch(SECTORS.keys())
    out, errs = [], []
    for tk, (name, etf, drv) in SECTORS.items():
        close = series_for(df, tk, 'Close')
        vol = series_for(df, tk, 'Volume')
        if close is None or len(close) < 5:
            errs.append(name)
            continue
        chg = pct(close.iloc[-1], close.iloc[-2]) if len(close) >= 2 else None
        rets = close.pct_change()
        sign, n = streak(rets)

        # 돈 몰림 = 오늘 거래대금 / 최근 20일 중앙값
        money_ratio = None
        if vol is not None and len(vol) >= 10:
            turnover = (vol * close).dropna()
            if len(turnover) >= 10:
                base = turnover.iloc[-21:-1].median() if len(turnover) > 21 else turnover.iloc[:-1].median()
                if base and base > 0:
                    money_ratio = round(float(turnover.iloc[-1] / base), 2)

        # 5일 누적
        chg5 = pct(close.iloc[-1], close.iloc[-6]) if len(close) >= 6 else None

        # 최근 5거래일 일간 등락률 + 실제 거래일 요일 (미니 차트용)
        tail = rets.dropna().iloc[-5:]
        spark = [round(float(x) * 100, 2) for x in tail]
        spark_days = [['월','화','수','목','금','토','일'][ts.weekday()] for ts in tail.index]

        out.append({
            'name': name, 'ticker': tk, 'etf': etf, 'driver': drv,
            'chg': chg, 'chg5': chg5,
            'money': money_ratio,
            'streak_sign': sign, 'streak': n,
            'price': round(float(close.iloc[-1])),
            'volume': int(vol.iloc[-1]) if vol is not None and len(vol) else None,
            'spark': spark, 'spark_days': spark_days,
        })
    return out, errs


def collect_globals():
    df = fetch(GLOBALS.keys(), period='1mo')
    out, errs = [], []
    for tk, (name, kind, unit) in GLOBALS.items():
        close = series_for(df, tk, 'Close')
        if close is None or len(close) < 2:
            errs.append(name)
            continue
        v = float(close.iloc[-1])
        out.append({
            'name': name, 'kind': kind, 'ticker': tk, 'unit': unit,
            'last': round(v, 0 if abs(v) >= 1000 else 2),
            'chg': pct(close.iloc[-1], close.iloc[-2]),
        })
    return out, errs


def g(gl, ticker):
    for x in gl:
        if x['ticker'] == ticker:
            return x
    return None


def judge_mood(gl):
    """오늘 분위기: 좋음 / 보통 / 나쁨. 근거 문장 포함."""
    score, why = 0, []
    nq = g(gl, 'NQ=F'); sox = g(gl, '^SOX'); vix = g(gl, '^VIX')
    krw = g(gl, 'KRW=X'); oil = g(gl, 'CL=F'); tnx = g(gl, '^TNX')

    if nq and nq['chg'] is not None:
        if nq['chg'] >= 0.5: score += 2; why.append('미국 선물 강세')
        elif nq['chg'] <= -0.5: score -= 2; why.append('미국 선물 약세')
    if sox and sox['chg'] is not None:
        if sox['chg'] >= 1: score += 1; why.append('미국 반도체 강세')
        elif sox['chg'] <= -1: score -= 1; why.append('미국 반도체 약세')
    if vix and vix['last'] is not None:
        if vix['last'] <= 16: score += 1
        elif vix['last'] >= 22: score -= 2; why.append('공포지수 높음')
    if krw and krw['chg'] is not None:
        if krw['chg'] >= 0.5: score -= 1; why.append('환율 급등')
        elif krw['chg'] <= -0.4: score += 1; why.append('환율 안정')
    if tnx and tnx['chg'] is not None:
        if tnx['chg'] >= 2: score -= 1; why.append('금리 급등')
    if oil and oil['chg'] is not None and oil['chg'] <= -3:
        score += 1; why.append('유가 급락')

    if score >= 2: mood, emoji = '좋음', '🟢'
    elif score <= -2: mood, emoji = '나쁨', '🔴'
    else: mood, emoji = '보통', '🟡'
    return {'mood': mood, 'emoji': emoji, 'score': score, 'why': why[:3]}


def judge_flow(sectors):
    """유입/유출 판정. 등락률 + 돈 몰림 가중."""
    valid = [s for s in sectors if s['chg'] is not None]
    if not valid:
        return [], [], '데이터를 못 받았습니다'

    for s in valid:
        # 등락률이 주도, 거래대금은 보정만 (0.76 ~ 1.4배)
        m = s['money'] if s['money'] else 1.0
        m = max(0.4, min(2.0, m))
        s['flow'] = round(s['chg'] * (0.6 + 0.4 * m), 2)
        s['hot'] = bool(s['money'] and s['money'] >= 1.5)  # 거래 폭증 배지

    ups = sorted([s for s in valid if s['chg'] > 0], key=lambda x: -x['flow'])
    downs = sorted([s for s in valid if s['chg'] < 0], key=lambda x: x['flow'])
    avg = sum(s['chg'] for s in valid) / len(valid)
    spread = max(s['chg'] for s in valid) - min(s['chg'] for s in valid)

    top_in = ups[:3]
    top_out = downs[:3]

    # 한 줄 결론
    if spread < 1.0:
        if avg > 0.3:
            line = '오늘은 다 같이 올랐다'
            sub = '특별히 몰린 곳 없음'
        elif avg < -0.3:
            line = '오늘은 다 같이 빠졌다'
            sub = ('그나마 버틴 곳: ' + top_in[0]['name']) if top_in else '전 섹터 약세'
        else:
            line = '오늘은 특별한 흐름 없다'
            sub = '섹터 차이가 작음'
    else:
        if top_in:
            names = ' · '.join(s['name'] for s in top_in[:2])
            line = f'오늘 돈은 {names}로 갔다'
            head = top_in[0]
            bits = []
            if head['streak'] >= 2 and head['streak_sign'] > 0:
                bits.append(f"{head['name']} {head['streak']}일째")
            if head['money'] and head['money'] >= 1.3:
                bits.append('거래 크게 늘어남')
            sub = ' · '.join(bits) if bits else f"{head['name']} 오늘 시작"
        else:
            line = '오늘은 다 빠졌다'
            sub = '유입 섹터 없음'
    return top_in, top_out, (line, sub)


# ─────────────────────────────────────────────
# 이벤트 캘린더
# 뉴스가 아니라 '미리 공표된 날짜'만 담는다.
# 출처: Fed(FOMC), 한국은행(금통위), BLS(CPI·고용), KRX(휴장)
# 2026년 기준. 연말에 다음 해 일정으로 갱신 필요.
# ─────────────────────────────────────────────
FIXED_EVENTS = [
    # (날짜, 분류, 제목, 비고)
    ('2026-09-24', 'off',  '추석 연휴 휴장',      '24일·25일 이틀 휴장'),
    ('2026-09-25', 'off',  '추석 휴장',           '다음 거래일 9월 28일(월)'),
    ('2026-10-02', 'us',   '미국 9월 고용보고서',  '한국시간 밤 9시 30분'),
    ('2026-10-05', 'off',  '개천절 대체 휴장',     ''),
    ('2026-10-09', 'off',  '한글날 휴장',          ''),
    ('2026-10-14', 'us',   '미국 9월 CPI',        '한국시간 밤 9시 30분'),
    ('2026-10-22', 'kr',   '한국은행 금통위',      '기준금리 결정'),
    ('2026-10-28', 'fomc', 'FOMC 결정',           '결과는 한국시간 29일 새벽'),
    ('2026-11-06', 'us',   '미국 10월 고용보고서',  ''),
    ('2026-11-10', 'us',   '미국 10월 CPI',       ''),
    ('2026-11-26', 'kr',   '한국은행 금통위',      '올해 마지막 금리 결정'),
    ('2026-12-04', 'us',   '미국 11월 고용보고서',  ''),
    ('2026-12-09', 'fomc', 'FOMC 결정 (전망치 발표)', '점도표 공개'),
    ('2026-12-10', 'us',   '미국 11월 CPI',       ''),
    ('2026-12-25', 'off',  '성탄절 휴장',          ''),
    ('2026-12-30', 'kr',   '올해 마지막 거래일',    ''),
    ('2026-12-31', 'off',  '연말 휴장',            ''),
]


def nth_weekday(year, month, weekday, n):
    """그 달의 n번째 특정 요일. weekday: 월=0 … 일=6"""
    from datetime import date
    d = date(year, month, 1)
    shift = (weekday - d.weekday()) % 7
    day = 1 + shift + (n - 1) * 7
    try:
        return date(year, month, day)
    except ValueError:
        return None


def rule_events(now, months=4):
    """계산으로 나오는 이벤트 — 옵션 만기는 달력만 있으면 안다."""
    out = []
    y, m = now.year, now.month
    for i in range(months):
        mm = m + i
        yy = y + (mm - 1) // 12
        mm = (mm - 1) % 12 + 1
        kr = nth_weekday(yy, mm, 3, 2)   # 한국 옵션만기: 둘째 목요일
        us = nth_weekday(yy, mm, 4, 3)   # 미국 옵션만기: 셋째 금요일
        quad = mm in (3, 6, 9, 12)
        if kr:
            out.append((kr.isoformat(), 'expiry',
                        '선물·옵션 동시만기' if quad else '옵션 만기일',
                        '네 마녀의 날 · 변동성 큼' if quad else '만기 전후 수급 출렁임'))
        if us:
            out.append((us.isoformat(), 'expiry', '미국 옵션 만기', ''))
    return out


def build_calendar(now, limit=6):
    from datetime import date
    today = now.date()
    items = FIXED_EVENTS + rule_events(now)
    seen, rows = set(), []
    for iso, kind, title, note in sorted(items):
        y, mo, dd = (int(x) for x in iso.split('-'))
        ed = date(y, mo, dd)
        dday = (ed - today).days
        if dday < 0:
            continue
        key = (iso, title)
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            'date': iso, 'kind': kind, 'title': title, 'note': note,
            'dday': dday,
            'label': f"{mo}월 {dd}일 ({'월화수목금토일'[ed.weekday()]})",
            'dtext': '오늘' if dday == 0 else ('내일' if dday == 1 else f'D-{dday}'),
        })
        if len(rows) >= limit:
            break
    return rows


def attach_drivers(sectors, gl):
    """섹터마다 '근거 신호' 한 줄. 뉴스가 아니라 계산된 값만 쓴다."""
    for s in sectors:
        d = g(gl, s.get('driver'))
        if not d or d['chg'] is None:
            s['driver_text'] = None
            continue
        c = d['chg']
        # 지수는 강세/약세, 금리·환율·원자재는 상승/하락으로 쓴다
        if d['kind'] in ('idx', 'kr'):
            word = '강세' if c > 0.3 else ('약세' if c < -0.3 else '보합')
        else:
            word = '상승' if c > 0.3 else ('하락' if c < -0.3 else '보합')
        sign = '+' if c > 0 else ''
        s['driver_text'] = f"{d['name']} {word} ({sign}{c}%)"
        s['driver_chg'] = c
    return sectors


def market_status(now):
    """장 상태: 개장 전 / 장중 / 마감 / 휴장"""
    wd, hm = now.weekday(), now.hour * 60 + now.minute
    if wd >= 5:
        return 'closed', '주말 · 어제 마감 기준'
    if hm < 9 * 60:
        return 'pre', '개장 전 · 어제 마감 기준'
    if hm <= 15 * 60 + 30:
        return 'open', '장중'
    return 'after', '장 마감'


def main():
    now = datetime.now(KST)
    mstat, mlabel = market_status(now)
    sectors, e1 = collect_sectors()
    gl, e2 = collect_globals()
    sectors = attach_drivers(sectors, gl)
    mood = judge_mood(gl)
    top_in, top_out, conclusion = judge_flow(sectors)
    line, sub = conclusion if isinstance(conclusion, tuple) else (conclusion, '')

    payload = {
        'updated': now.strftime('%Y-%m-%d %H:%M'),
        'updated_label': now.strftime('%m월 %d일 %H:%M') + ' 기준',
        'date_label': now.strftime('%m월 %d일'),
        'weekday': ['월','화','수','목','금','토','일'][now.weekday()],
        'market_status': mstat,
        'market_label': mlabel,
        'headline': line,
        'subline': sub,
        'mood': mood,
        'top_in': [s['name'] for s in top_in],
        'top_out': [s['name'] for s in top_out],
        'calendar': build_calendar(now),
        'sectors': sorted([s for s in sectors if s['chg'] is not None],
                          key=lambda x: -x['chg']),
        'globals': gl,
        'errors': e1 + e2,
    }

    with open(os.path.join(DATA, 'latest.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    # 하루치 누적 (2단계 순환매 분석용 씨앗)
    hist_path = os.path.join(DATA, 'history.json')
    hist = []
    if os.path.exists(hist_path):
        try:
            hist = json.load(open(hist_path, encoding='utf-8'))
        except Exception:
            hist = []
    day = now.strftime('%Y-%m-%d')
    hist = [h for h in hist if h.get('date') != day]
    hist.append({'date': day,
                 'sectors': {s['name']: s['chg'] for s in payload['sectors']},
                 'mood': mood['mood']})
    hist = hist[-400:]
    json.dump(hist, open(hist_path, 'w', encoding='utf-8'), ensure_ascii=False)

    print(f"OK {payload['updated']} | {line} | {sub}")
    if payload['errors']:
        print('수집 실패:', ', '.join(payload['errors']))
    return payload


if __name__ == '__main__':
    main()
