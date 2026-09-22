#!/usr/bin/env python3
"""섹터 흐름판 · 하루치 기록 보관

이 파일은 더 이상 시세를 직접 받지 않는다.
시세 판정은 전부 Cloudflare 의 /api/live 에서 실시간으로 이뤄진다.
여기서 하는 일은 두 가지뿐이다.

  1. 그 결과를 받아 data/latest.json 에 담는다.
     화면이 처음 열릴 때 보여줄 값이고, 통신이 막혔을 때의 예비값이다.
  2. 하루치 업종 등락률을 data/history.json 에 쌓는다.
     업종 단위로 바꾸면서 과거가 없어졌다. 여기서부터 다시 모은다.
     5거래일이 모이면 상세 화면에 캔들이 그려진다.

일정(달력)은 미리 공표된 날짜만 담는다. 뉴스는 넣지 않는다.
"""

import json, os, sys
import urllib.request
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
SITE = os.environ.get('SITE', 'https://lucent-sector.pages.dev')
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

# 기록은 이만큼만 들고 간다. 캔들 5개와 누적 계산에 충분하다.
KEEP_DAYS = 60


def get_live():
    """실시간 판정 결과를 받아 온다. 몇 번 튕겨도 다시 시도한다."""
    last = None
    for i in range(4):
        try:
            req = urllib.request.Request(
                SITE + '/api/live',
                headers={'user-agent': 'sector-flow-archiver', 'accept': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=45) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('sectors'):
                return d
            last = RuntimeError('빈 응답')
        except Exception as e:
            last = e
        if i < 3:
            import time
            time.sleep(4 * (i + 1))
    raise last


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


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

def upsert_history(payload, now):
    """오늘 자리에 덮어쓴다. 그래서 그날 마지막 실행값이 종가로 남는다."""
    path = os.path.join(DATA, 'history.json')
    hist = load(path, {})
    if not isinstance(hist, dict) or 'days' not in hist:
        # ETF 시절 기록은 업종과 이름이 맞지 않는다. 여기서부터 새로 쌓는다.
        hist = {'unit': 'industry', 'days': []}

    # 개장 전(자정 ~ 09시)에 보이는 값은 아직 어제 장의 마감치다.
    # 그래서 그 시간대 기록은 전 거래일 자리에 넣는다.
    day = now.date() if now.hour >= 9 else (now - timedelta(days=1)).date()
    today = day.strftime('%Y-%m-%d')
    row = {
        'd': today,
        'closed': payload.get('market_status') in ('after', 'closed'),
        's': {s['name']: s['chg'] for s in payload['sectors'] if s.get('chg') is not None},
    }
    days = [x for x in hist['days'] if x.get('d') != today]
    days.append(row)
    days.sort(key=lambda x: x['d'])
    hist['days'] = days[-KEEP_DAYS:]

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(hist, f, ensure_ascii=False, separators=(',', ':'))
    return len(hist['days'])


def main():
    now = datetime.now(KST)
    os.makedirs(DATA, exist_ok=True)

    try:
        payload = get_live()
    except Exception as e:
        print('실패: /api/live 를 못 받았습니다 ·', e)
        return 1

    payload['calendar'] = build_calendar(now)
    payload['archived_at'] = now.strftime('%Y-%m-%d %H:%M')

    with open(os.path.join(DATA, 'latest.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    n = upsert_history(payload, now)

    print('OK', payload['updated'], '|', payload['headline'])
    print('   업종', len(payload['sectors']), '· 해외 지표', len(payload.get('globals', [])),
          '· 쌓인 날짜', n)
    if payload.get('errors'):
        print('   빠진 것:', ', '.join(payload['errors']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
