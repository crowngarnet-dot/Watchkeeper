package com.watchkeeper;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * The sound and the buzz.
 *
 * Plays on the ALARM stream so it is audible when the ringer is silenced,
 * which is the point of an alarm. It stops itself after a few minutes so a
 * reminder nobody answers does not run the battery down.
 */
public class Ringer {

    private static MediaPlayer player;
    private static Vibrator vibrator;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static Runnable autoStop;
    private static String ringingId;

    private static final long MAX_RING_MS = 3 * 60 * 1000L;

    public static synchronized void start(Context c, String id, String title, String body) {
        stop(c);
        ringingId = id;

        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (uri != null) {
                player = new MediaPlayer();
                player.setDataSource(c, uri);
                player.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                player.setLooping(true);
                player.prepare();
                player.start();
            }
        } catch (Exception e) {
            player = null;
        }

        try {
            vibrator = getVibrator(c);
            if (vibrator != null && vibrator.hasVibrator()) {
                long[] pattern = {0, 500, 300, 500, 300, 800, 500};
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0),
                            new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_ALARM)
                                    .build());
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {
        }

        final Context app = c.getApplicationContext();
        autoStop = new Runnable() {
            @Override public void run() { stop(app); }
        };
        handler.postDelayed(autoStop, MAX_RING_MS);
    }

    public static synchronized void stop(Context c) {
        if (autoStop != null) {
            handler.removeCallbacks(autoStop);
            autoStop = null;
        }
        if (player != null) {
            try {
                if (player.isPlaying()) player.stop();
            } catch (Exception ignored) {
            }
            try {
                player.release();
            } catch (Exception ignored) {
            }
            player = null;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {
            }
            vibrator = null;
        }
        ringingId = null;
    }

    /** Quietens the tone so a spoken answer can be heard, without ending it. */
    public static synchronized void duck(boolean quiet) {
        if (player == null) return;
        try {
            float v = quiet ? 0f : 1f;
            player.setVolume(v, v);
        } catch (Exception ignored) {
        }
        if (vibrator != null && quiet) {
            try { vibrator.cancel(); } catch (Exception ignored) {}
        }
    }

    public static synchronized String ringingId() {
        return ringingId;
    }

    private static Vibrator getVibrator(Context c) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = (VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            return vm == null ? null : vm.getDefaultVibrator();
        }
        return (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
    }

    @SuppressWarnings("unused")
    private static AudioManager audioManager(Context c) {
        return (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
    }
}
