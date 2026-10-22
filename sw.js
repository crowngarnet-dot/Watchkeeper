/* Watchkeeper service worker.
   Three jobs:
     1. Let the page show notifications at all (Android Chrome refuses the
        plain `new Notification()` constructor and requires this).
     2. Route a tapped notification action back into the app, whether the app
        is already open or has to be started.
     3. Cache the app so it opens without a connection.

   It does NOT run timers. A service worker is not kept alive by the browser
   between events, so it cannot wake the phone for a reminder on its own.
   Reliable background delivery would need Web Push from a server. */

const CACHE = 'watchkeeper-v3';
const ASSETS = ['./', './index.html', './core.js'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          /* Only this app's own caches — never touch another site's. */
          .filter(k => k.startsWith('watchkeeper-') && k !== CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Network first so an updated app is picked up, cache as the fallback. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  if(new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

/* A tapped notification must reach the app even if the app is not running.
   An open window gets a message; otherwise the action travels in the URL so
   the page can apply it as soon as it has loaded its data. */
self.addEventListener('notificationclick', e => {
  const action = e.action || 'open';
  const id = (e.notification.data || {}).id || '';
  e.notification.close();

  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for(const c of all){
      if('focus' in c){
        c.postMessage({type:'notification-action', action, id});
        return c.focus();
      }
    }
    const base = new URL('./', self.location.href).href;
    return self.clients.openWindow(base + '#act=' + action + '&id=' + id);
  })());
});
