/**
 * 휴대폰 알림 · ntfy (https://ntfy.sh)
 *
 * 휴대폰에 ntfy 앱을 깔고 '주제(topic)' 하나를 구독하면, 여기서 그 주제로 보낸 글이 휴대폰에서 울린다.
 * 계정도 개발자 등록도 필요 없다. 대신 주제 이름이 비밀번호 역할을 한다.
 * 그래서 이름을 코드(공개 저장소)에 적지 않고 저장소(KV) 'push' 키에 둔다.
 *   push = { "topic": "lucent-…", "server": "https://ntfy.sh", "on": true }
 *
 * 우선순위  3 보통(소리 한 번)  ·  4 높음(소리와 진동, 잠금 화면에 크게)
 */

export async function pushCfg(env) {
  try {
    const c = await env.FLOW.get('push', 'json');
    return c && c.topic && c.on !== false ? c : null;
  } catch (e) {
    return null;
  }
}

export async function push(cfg, { title, body, priority = 3, click, tags }) {
  const r = await fetch(cfg.server || 'https://ntfy.sh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      topic: cfg.topic,
      title: String(title || '').slice(0, 120),
      message: String(body || '').slice(0, 3000),
      priority,
      click: click || undefined,
      tags: tags || undefined,
    }),
  });
  if (!r.ok) throw new Error('ntfy ' + r.status + ' ' + (await r.text()).slice(0, 120));
}
