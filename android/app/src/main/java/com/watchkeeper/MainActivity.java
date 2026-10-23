package com.watchkeeper;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

/**
 * The app shell.
 *
 * The interface is the same HTML that runs on the web, loaded from assets.
 * What changes is underneath: scheduling, speech and alarms are handed to the
 * platform, so reminders fire with the phone locked.
 */
public class MainActivity extends android.app.Activity {

    public static final String ACTION_WEB_COMMAND = "com.watchkeeper.WEB_COMMAND";

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private VoiceBridge.NativeRecognizer recognizer;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean pageReady = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        Alarms.ensureChannel(this);
        requestRuntimePermissions();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                /* Keep the app inside the app; send real links to the browser. */
                String u = r.getUrl().toString();
                if (u.startsWith("file:///android_asset/")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl()));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                pageReady = true;
                replayPendingActions();
                handleCommandIntent(getIntent());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                /* Nothing in the page needs camera or mic directly — speech
                   goes through the native bridge — so decline quietly. */
                request.deny();
            }
        });

        web.addJavascriptInterface(new Bridge(), "WatchkeeperNative");
        web.loadUrl("file:///android_asset/www/index.html");

        tts = new TextToSpeech(this, status -> {
            ttsReady = (status == TextToSpeech.SUCCESS);
            if (ttsReady && tts != null) tts.setLanguage(Locale.UK);
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (pageReady) handleCommandIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) replayPendingActions();
    }

    /** Done or Snooze tapped in a notification, routed into the page. */
    private void handleCommandIntent(Intent i) {
        if (i == null || !ACTION_WEB_COMMAND.equals(i.getAction())) return;
        String act = i.getStringExtra("act");
        String id = i.getStringExtra("id");
        if (act == null || id == null) return;
        i.setAction(null);
        toPage("window.handleRemoteAction && handleRemoteAction("
                + q(act) + "," + q(id) + ")");
    }

    private void replayPendingActions() {
        List<PendingActions.Item> queued = PendingActions.drain(this);
        for (PendingActions.Item it : queued) {
            toPage("window.handleRemoteAction && handleRemoteAction("
                    + q(it.action) + "," + q(it.id) + ")");
        }
    }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        java.util.ArrayList<String> want = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!want.isEmpty()) requestPermissions(want.toArray(new String[0]), 1);
    }

    private void toPage(final String js) {
        ui.post(() -> {
            if (web != null) {
                try { web.evaluateJavascript(js, null); } catch (Exception ignored) { }
            }
        });
    }

    private static String q(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (recognizer != null) { recognizer.cancel(); recognizer = null; }
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (Exception ignored) { }
            tts = null;
        }
        super.onDestroy();
    }

    /* ======================= the bridge the page sees ======================= */

    public class Bridge {

        @JavascriptInterface
        public boolean isNative() { return true; }

        @JavascriptInterface
        public int apiLevel() { return Build.VERSION.SDK_INT; }

        /** True when reminders really will fire with the phone locked. */
        @JavascriptInterface
        public boolean canScheduleExact() { return Alarms.canScheduleExact(MainActivity.this); }

        @JavascriptInterface
        public void schedule(String id, double atMs, String title, String body) {
            Alarms.schedule(MainActivity.this, id, (long) atMs, title, body);
        }

        @JavascriptInterface
        public void cancel(String id) {
            Alarms.cancel(MainActivity.this, id);
        }

        @JavascriptInterface
        public void cancelAll() {
            for (AlarmStore.Pending p : AlarmStore.all(MainActivity.this)) {
                Alarms.cancel(MainActivity.this, p.id);
            }
        }

        @JavascriptInterface
        public void stopRinging() { Ringer.stop(MainActivity.this); }

        @JavascriptInterface
        public boolean speechAvailable() {
            return android.speech.SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        /** Speaks, then calls window.__nativeSpoken(token). */
        @JavascriptInterface
        public void speak(String text, final String token) {
            if (!ttsReady || tts == null) {
                toPage("window.__nativeSpoken && __nativeSpoken(" + q(token) + ")");
                return;
            }
            ui.post(() -> VoiceBridge.speakOnce(tts, text,
                    () -> toPage("window.__nativeSpoken && __nativeSpoken(" + q(token) + ")")));
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) { try { tts.stop(); } catch (Exception ignored) { } }
        }

        /** Listens once, then calls window.__nativeHeard(token, text, error). */
        @JavascriptInterface
        public void listen(final String token) {
            ui.post(() -> {
                if (recognizer != null) recognizer.cancel();
                recognizer = new VoiceBridge.NativeRecognizer(MainActivity.this);
                recognizer.listen(new VoiceBridge.NativeRecognizer.Callback() {
                    @Override public void onResult(String text) {
                        toPage("window.__nativeHeard && __nativeHeard("
                                + q(token) + "," + q(text) + ",null)");
                    }
                    @Override public void onError(String why) {
                        toPage("window.__nativeHeard && __nativeHeard("
                                + q(token) + ",\"\"," + q(why) + ")");
                    }
                });
            });
        }

        @JavascriptInterface
        public void stopListening() {
            ui.post(() -> { if (recognizer != null) { recognizer.cancel(); recognizer = null; } });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                android.os.Vibrator v;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    android.os.VibratorManager vm =
                            (android.os.VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                    v = vm == null ? null : vm.getDefaultVibrator();
                } else {
                    v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
                }
                if (v != null) v.vibrate(android.os.VibrationEffect.createOneShot(
                        Math.max(20, ms), android.os.VibrationEffect.DEFAULT_AMPLITUDE));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "?";
            }
        }
    }
}
