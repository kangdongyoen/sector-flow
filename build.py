#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""수집 데이터를 화면에 주입해서 index.html 생성"""
import json, os, sys

BASE = os.path.dirname(os.path.abspath(__file__))

def build():
    data = json.load(open(os.path.join(BASE, 'data', 'latest.json'), encoding='utf-8'))
    tpl = open(os.path.join(BASE, 'template.html'), encoding='utf-8').read()
    blob = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    out = tpl.replace('const DATA = null; /*__DATA__*/', 'const DATA = ' + blob + ';')
    if 'const DATA = {' not in out:
        print('ERROR: 데이터 주입 실패', file=sys.stderr); sys.exit(1)
    path = os.path.join(BASE, 'index.html')
    open(path, 'w', encoding='utf-8').write(out)
    print(f'BUILD OK {len(out)//1024}KB | {data["headline"]}')
    return path

if __name__ == '__main__':
    build()
