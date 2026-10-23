/* ============================================================
   Native bridge.

   Loaded by the same index.html that runs on the web. On a plain browser
   every call here is inert and the page behaves exactly as before. Inside the
   Android app it routes scheduling, speech and listening to the platform,
   which is what lets a reminder fire with the phone locked.
   ============================================================ */

(function (global) {
  'use strict';

  const N = global.WatchkeeperNative || null;
  const isNative = !!(N && typeof N.isNative === 'function' && N.isNative());

  /* ---------------------------------------------------------- speech out --- */

  let speakSeq = 0;
  const speakWaiters = new Map();

  global.__nativeSpoken = function (token) {
    const fn = speakWaiters.get(token);
    if (fn) { speakWaiters.delete(token); fn(); }
  };

  function nativeSay(text) {
    return new Promise(resolve => {
      if (!isNative || !text) { resolve(false); return; }
      const token = 'u' + (++speakSeq);
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(true); } };
      speakWaiters.set(token, done);
      /* The engine occasionally fails to report completion; cap the wait so
         the conversation never stalls. */
      setTimeout(() => { speakWaiters.delete(token); done(); },
        Math.min(22000, 1800 + String(text).length * 80));
      try { N.speak(String(text), token); }
      catch (e) { speakWaiters.delete(token); done(); }
    });
  }

  /* ---------------------------------------------------------- speech in --- */

  let listenSeq = 0;
  let listenWaiter = null;

  global.__nativeHeard = function (token, text, error) {
    if (!listenWaiter || listenWaiter.token !== token) return;
    const w = listenWaiter;
    listenWaiter = null;
    w.resolve({text: text || '', error: error || null});
  };

  function nativeListen(timeoutMs) {
    return new Promise(resolve => {
      if (!isNative) { resolve({text:'', error:'not-native'}); return; }
      const token = 'l' + (++listenSeq);
      let settled = false;
      const finish = v => { if (!settled) { settled = true; resolve(v); } };
      listenWaiter = {token, resolve: finish};
      setTimeout(() => {
        if (listenWaiter && listenWaiter.token === token) {
          listenWaiter = null;
          try { N.stopListening(); } catch (e) {}
          finish({text:'', error:'timeout'});
        }
      }, timeoutMs || 9000);
      try { N.listen(token); }
      catch (e) { listenWaiter = null; finish({text:'', error:'start-failed'}); }
    });
  }

  /* ---------------------------------------------------------- alarms --- */

  function schedule(id, atMs, title, body) {
    if (!isNative) return false;
    try { N.schedule(String(id), Number(atMs), String(title || ''), String(body || '')); return true; }
    catch (e) { return false; }
  }
  function cancel(id) {
    if (!isNative) return false;
    try { N.cancel(String(id)); return true; } catch (e) { return false; }
  }

  /* ---------------------------------------------------------- surface --- */

  global.Native = {
    available: isNative,
    apiLevel: isNative && N.apiLevel ? safe(() => N.apiLevel(), 0) : 0,
    version: isNative && N.version ? safe(() => N.version(), '') : '',
    /* False only when the user has actively withheld exact-alarm permission
       on Android 12; the page says so rather than quietly degrading. */
    exactAlarms: isNative && N.canScheduleExact ? safe(() => N.canScheduleExact(), false) : false,
    speechAvailable: isNative && N.speechAvailable ? safe(() => N.speechAvailable(), false) : false,
    say: nativeSay,
    listen: nativeListen,
    stopSpeaking() { if (isNative) safe(() => N.stopSpeaking(), null); },
    stopListening() { if (isNative) safe(() => N.stopListening(), null); },
    stopRinging() { if (isNative) safe(() => N.stopRinging(), null); },
    schedule,
    cancel,
    vibrate(ms) { if (isNative) safe(() => N.vibrate(ms | 0), null); },

    /* Hands a URL to Android so Teams, Outlook or the browser can claim it.
       Returns false when nothing on the phone can open it. */
    openExternal(url) {
      if (!isNative || !N.openExternal) return false;
      return safe(() => N.openExternal(String(url)), false);
    },

    /* A WebView cannot save a file, so the .ics goes to Android and the
       chooser offers Outlook and the calendar apps. */
    shareCalendar(filename, text) {
      if (!isNative || !N.shareCalendar) return false;
      return safe(() => N.shareCalendar(String(filename), String(text)), false);
    }
  };

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }
})(window);
