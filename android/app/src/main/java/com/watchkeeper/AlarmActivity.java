package com.watchkeeper;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import java.util.Locale;

/**
 * The screen that appears over the lock screen when a reminder is due.
 *
 * It reads the reminder aloud and then listens, so it can be answered without
 * unlocking the phone. The buttons do the same thing for a noisy deck or a
 * failed microphone.
 */
public class AlarmActivity extends Activity {

    private String id, title, body;
    private TextToSpeech tts;
    private VoiceBridge.NativeRecognizer recognizer;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean answered = false;
    private int listenRound = 0;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        showOverLockScreen();
        setContentView(R.layout.activity_alarm);

        readIntent(getIntent());
        bind();

        /* Give the screen a moment to come up before speaking. */
        handler.postDelayed(new Runnable() {
            @Override public void run() { speakAndListen(); }
        }, 900);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readIntent(intent);
        bind();
    }

    private void readIntent(Intent i) {
        if (i == null) return;
        id = i.getStringExtra(Alarms.EXTRA_ID);
        title = i.getStringExtra(Alarms.EXTRA_TITLE);
        body = i.getStringExtra(Alarms.EXTRA_BODY);
    }

    private void bind() {
        TextView t = findViewById(R.id.alarmTitle);
        TextView b = findViewById(R.id.alarmBody);
        t.setText(title == null || title.isEmpty() ? "Reminder" : title);
        if (body == null || body.isEmpty()) {
            b.setVisibility(View.GONE);
        } else {
            b.setVisibility(View.VISIBLE);
            b.setText(body);
        }

        Button done = findViewById(R.id.btnDone);
        Button snooze = findViewById(R.id.btnSnooze);
        Button open = findViewById(R.id.btnOpen);

        done.setOnClickListener(v -> answer("done", 0));
        snooze.setOnClickListener(v -> answer("snooze", 10));
        open.setOnClickListener(v -> {
            stopEverything();
            Intent go = new Intent(this, MainActivity.class);
            go.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(go);
            finish();
        });
    }

    private void showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = getSystemService(KeyguardManager.class);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /* ---------------- voice ---------------- */

    private void speakAndListen() {
        if (answered) return;
        final String line = (title == null ? "Reminder" : title) + ". Say done, or say snooze.";
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS && tts != null) {
                tts.setLanguage(Locale.UK);
                Ringer.duck(true);
                VoiceBridge.speakOnce(tts, line, () -> handler.post(this::listen));
            } else {
                handler.post(this::listen);
            }
        });
    }

    private void listen() {
        if (answered) return;
        if (listenRound++ >= 3) { Ringer.duck(false); return; }

        recognizer = new VoiceBridge.NativeRecognizer(this);
        recognizer.listen(new VoiceBridge.NativeRecognizer.Callback() {
            @Override public void onResult(String text) {
                if (answered) return;
                String s = text == null ? "" : text.toLowerCase(Locale.UK);
                if (s.matches(".*\\b(done|did it|finished|complete|completed|dismiss|clear|yes|ok|okay)\\b.*")) {
                    answer("done", 0);
                } else if (s.matches(".*\\b(snooze|later|wait|postpone|not now|delay)\\b.*")) {
                    answer("snooze", snoozeFrom(s));
                } else {
                    Ringer.duck(false);
                    handler.postDelayed(AlarmActivity.this::retry, 1200);
                }
            }
            @Override public void onError(String why) {
                Ringer.duck(false);
                handler.postDelayed(AlarmActivity.this::retry, 1500);
            }
        });
    }

    private void retry() {
        if (answered) return;
        if (listenRound >= 3) { Ringer.duck(false); return; }
        final String line = "Still waiting. Say done, or say snooze.";
        if (tts != null) {
            Ringer.duck(true);
            VoiceBridge.speakOnce(tts, line, () -> handler.post(this::listen));
        } else {
            listen();
        }
    }

    private int snoozeFrom(String s) {
        if (s.contains("tomorrow")) return 1440;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(\\d{1,4})\\s*(minute|minutes|min|mins|hour|hours|hr|hrs)").matcher(s);
        if (m.find()) {
            int n = Integer.parseInt(m.group(1));
            return m.group(2).startsWith("h") ? n * 60 : n;
        }
        if (s.contains("an hour") || s.contains("one hour")) return 60;
        if (s.contains("half an hour")) return 30;
        return 10;
    }

    /* ---------------- answering ---------------- */

    private void answer(String what, int minutes) {
        if (answered) return;
        answered = true;
        stopEverything();

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && id != null) nm.cancel(Math.abs(id.hashCode()));

        if ("snooze".equals(what) && id != null) {
            long at = System.currentTimeMillis() + Math.max(1, minutes) * 60_000L;
            Alarms.schedule(this, id, at, title, body);
        } else if (id != null) {
            Alarms.cancel(this, id);
        }

        /* Record it for the web layer; MainActivity replays it on next open. */
        if (id != null) PendingActions.add(this, what, id);
        finish();
    }

    private void stopEverything() {
        Ringer.stop(this);
        if (recognizer != null) { recognizer.cancel(); recognizer = null; }
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
        }
        handler.removeCallbacksAndMessages(null);
    }

    @Override
    protected void onDestroy() {
        stopEverything();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        /* A reminder should be answered, not dismissed by reflex. */
        answer("snooze", 10);
    }

    @SuppressWarnings("unused")
    private Context self() { return this; }
}
