#!/usr/bin/env python3
"""섹터 흐름판 · 카카오톡 '나에게 보내기'

개장 전과 마감 뒤에 한 줄 요약을 카카오톡 '나와의 채팅'으로 보낸다.
장중 갱신 때는 보내지 않는다. 하루 두 번이면 충분하다.

필요한 것 (GitHub Secrets):
  KAKAO_REST_KEY       카카오 개발자 앱의 REST API 키
  KAKAO_REFRESH_TOKEN  /kakao 페이지에서 받은 리프레시 토큰

둘 중 하나라도 없으면 아무 일도 하지 않고 조용히 끝낸다.
알림을 안 쓴다고 해서 갱신이 실패하면 안 되기 때문이다.
"""

import json, os, sys, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
SITE = os.environ.get('SITE', 'https://lucent-sector.pages.dev')
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')


def post(url, data, headers=None):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers or {})
    req.add_header('content-type', 'application/x-www-form-urlencoded;charset=utf-8')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def access_token(key, refresh):
    j = post('https://kauth.kakao.com/oauth/token', {
        'grant_type': 'refresh_token',
        'client_id': key,
        'refresh_token': refresh,
    })
    if not j.get('access_token'):
        raise RuntimeError('토큰 갱신 실패: ' + json.dumps(j, ensure_ascii=False)[:200])
    # 리프레시 토큰이 새로 오면 만료가 가까웠다는 뜻이다. 로그에 남겨 둔다.
    if j.get('refresh_token'):
        print('알림: 새 리프레시 토큰이 발급됐습니다. GitHub Secrets 를 갱신해 두세요.')
    return j['access_token']


def build_text(d):
    when = '마감' if d.get('market_status') in ('after', 'closed') else '개장 전'
    S = [s for s in d.get('sectors', []) if s.get('chg') is not None]
    up = len([s for s in S if s['chg'] > 0])
    dn = len([s for s in S if s['chg'] < 0])
    lines = [f"[섹터 흐름판] {d.get('date_label','')} {when}", d.get('headline', '')]
    mood = (d.get('mood') or {}).get('mood')
    why = ' · '.join((d.get('mood') or {}).get('why', [])[:2])
    if mood:
        lines.append(f"분위기 {mood}" + (f" · {why}" if why else ''))
    if S:
        lines.append(f"오른 업종 {up} · 빠진 업종 {dn} (전체 {len(S)})")
        top = sorted(S, key=lambda x: -(x.get('flow') or x['chg']))[0]
        bit = f"{top['total']}개 중 {top['rise']}개 상승" if top.get('total') else ''
        lines.append(f"가장 센 곳 {top['name']} {top['chg']:+.2f}%" + (f" ({bit})" if bit else ''))
    text = '\n'.join(x for x in lines if x)
    return text[:190]


def main():
    key = os.environ.get('KAKAO_REST_KEY', '').strip()
    refresh = os.environ.get('KAKAO_REFRESH_TOKEN', '').strip()
    if not key or not refresh:
        print('카카오 알림 설정이 없습니다. 건너뜁니다.')
        return 0

    now = datetime.now(KST)
    mins = now.hour * 60 + now.minute
    force = os.environ.get('FORCE_NOTIFY') == '1'
    # 08:00~09:00 개장 전, 15:30~16:30 마감 뒤. 그 밖에는 보내지 않는다.
    window = (8 * 60 <= mins < 9 * 60) or (15 * 60 + 30 <= mins < 16 * 60 + 30)
    if not (window or force):
        print('알림 시간대가 아닙니다. 건너뜁니다.')
        return 0
    if now.weekday() >= 5 and not force:
        print('주말입니다. 건너뜁니다.')
        return 0

    try:
        with open(os.path.join(DATA, 'latest.json'), encoding='utf-8') as f:
            d = json.load(f)
    except Exception as e:
        print('latest.json 을 못 읽었습니다 ·', e)
        return 0

    text = build_text(d)
    try:
        tok = access_token(key, refresh)
        tpl = {
            'object_type': 'text',
            'text': text,
            'link': {'web_url': SITE, 'mobile_web_url': SITE},
            'button_title': '열어보기',
        }
        r = post('https://kapi.kakao.com/v2/api/talk/memo/default/send',
                 {'template_object': json.dumps(tpl, ensure_ascii=False)},
                 {'Authorization': 'Bearer ' + tok})
        if r.get('result_code') == 0:
            print('카카오톡으로 보냈습니다.')
        else:
            print('응답:', json.dumps(r, ensure_ascii=False)[:200])
    except Exception as e:
        # 알림이 실패해도 갱신 자체는 성공으로 둔다.
        print('카카오톡 전송 실패 ·', str(e)[:200])
    return 0


if __name__ == '__main__':
    sys.exit(main())
