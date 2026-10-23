package com.watchkeeper;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import java.util.List;

/**
 * Scheduling, in one place.
 *
 * setAlarmClock() is deliberate: it is the only API Android treats as a real
 * alarm, so it fires through Doze and battery saver with the device locked.
 * setExactAndAllowWhileIdle, by contrast, is rate limited when the phone has
 * been idle for a while — which is exactly when a morning reminder matters.
 */
public class Alarms {

    public static final String CHANNEL_ID = "watchkeeper.reminders";
    public static final String ACTION_FIRE = "com.watchkeeper.FIRE";
    public static final String EXTRA_ID = "id";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    public static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Reminders you set by voice");
        ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        ch.setBypassDnd(true);
        /* Sound and vibration are driven by Ringer so they can keep going
           until the reminder is answered. A channel sound would play once and
           then overlap with it. */
        ch.enableVibration(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    private static PendingIntent firePending(Context c, String id, String title, String body) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION_FIRE);
        i.putExtra(EXTRA_ID, id);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_BODY, body);
        /* A distinct data URI keeps one reminder's PendingIntent from
           replacing another's. */
        i.setData(Uri.parse("watchkeeper://alarm/" + id));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, Math.abs(id.hashCode()), i, flags);
    }

    public static boolean canScheduleExact(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    public static void schedule(Context c, String id, long at, String title, String body) {
        if (id == null || id.length() == 0) return;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;

        ensureChannel(c);
        cancelOnly(c, id);
        AlarmStore.put(c, id, at, title, body);

        /* Rescheduling a ringing reminder — a snooze — silences it first. */
        if (id.equals(Ringer.ringingId())) {
            Ringer.stop(c);
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm != null) nm.cancel(Math.abs(id.hashCode()));
        }

        if (at <= System.currentTimeMillis()) {
            /* Already due — announce it now rather than scheduling the past. */
            AlarmReceiver.fire(c, id, title, body);
            return;
        }

        PendingIntent pi = firePending(c, id, title, body);

        /* Tapping the alarm-clock icon in the status bar opens the app. */
        Intent open = new Intent(c, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent show = PendingIntent.getActivity(c, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        try {
            if (canScheduleExact(c)) {
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
            } else {
                /* Permission withheld: still the most accurate option left. */
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    /** Cancels the system alarm but leaves the stored record alone. */
    private static void cancelOnly(Context c, String id) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        try {
            am.cancel(firePending(c, id, "", ""));
        } catch (Exception ignored) {
        }
    }

    public static void cancel(Context c, String id) {
        if (id == null) return;
        cancelOnly(c, id);
        AlarmStore.remove(c, id);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(Math.abs(id.hashCode()));
        /* Cancelling a reminder that is ringing right now must silence it.
           Without this the tone outlives the thing that caused it. */
        if (id.equals(Ringer.ringingId())) Ringer.stop(c);
    }

    /** Called after a reboot, a clock change, or an app update. */
    public static void restoreAll(Context c) {
        ensureChannel(c);
        long now = System.currentTimeMillis();
        AlarmStore.prune(c, now - 7L * 24 * 60 * 60 * 1000);
        List<AlarmStore.Pending> list = AlarmStore.all(c);
        for (AlarmStore.Pending p : list) {
            if (p.at > now) {
                schedule(c, p.id, p.at, p.title, p.body);
            } else {
                /* Missed while the phone was off — show it once, now. */
                AlarmReceiver.fire(c, p.id, p.title, p.body);
            }
        }
    }
}
