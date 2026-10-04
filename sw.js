/**
 * 섹터 흐름판 서비스 워커. 휴대폰 알림(웹 푸시)만 다룬다.
 * 화면을 저장해 두는 일(오프라인 캐시)은 하지 않는다. 숫자가 늘 새것이어야 해서다.
 *
 * 알림 내용 { title, body, url, tag, hot }
 *   hot  아주 큰 큰손 공시. 진동을 길게 주고, 누를 때까지 화면에 남긴다(안드로이드)
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try {
    m = e.data ? e.data.json() : {};
  } catch (err) {
    m = { body: e.data ? e.data.text() : '' };
  }
  const opt = {
    body: m.body || '',
    icon: '/assets/icon-192.png',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    data: { url: m.url || '/' },
    requireInteraction: !!m.hot,
    vibrate: m.hot ? [220, 120, 220, 120, 220] : [160],
  };
  e.waitUntil(self.registration.showNotification(m.title || '섹터 흐름판', opt));
});

/**
 * 알림을 누르면 사이트로 간다.
 *   사이트가 이미 열려 있으면 그 창을 앞으로 가져오고, 어디로 갈지(#whale · #s=업종번호)를 메시지로 알린다.
 *   닫혀 있으면 그 주소로 새로 연다. 화면은 주소의 # 를 보고 그 칸으로 내려간다.
 */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    (async () => {
      if (url.startsWith(self.location.origin)) {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const w = wins.find((c) => c.url.startsWith(self.location.origin));
        if (w) {
          try {
            await w.focus();
            w.postMessage({ type: 'go', url });
            return;
          } catch (err) {}
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});
