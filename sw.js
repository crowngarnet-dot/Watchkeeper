/* Watchkeeper service worker.
   Two jobs: let the page show real Android notifications, and bring the app
   back to the front when one is tapped. */

const CACHE = 'watchkeeper-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html']).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Serve from network, fall back to cache so the app opens with no signal. */
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

/* Tapping the notification (or its Open button) focuses the app. */
self.addEventListener('notificationclick', e => {
  const action = e.action;
  const data = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    const msg = {type:'notification-action', action, id:data.id};
    for(const c of all){
      if('focus' in c){
        c.postMessage(msg);
        return c.focus();
      }
    }
    const url = new URL('./', self.location.href).href + (data.id ? '#r' : '');
    const w = await self.clients.openWindow(url);
    if(w) w.postMessage(msg);
  })());
});
