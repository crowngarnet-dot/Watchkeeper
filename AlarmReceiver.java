package com.watchkeeper;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

/**
 * Where a reminder actually arrives.
 *
 * Two things happen together: a high-importance notification with a
 * full-screen intent, and — on a locked or sleeping phone — the alarm screen
 * itself. The notification is the fallback for when the system declines to
 * launch the activity, so the reminder is never lost silently.
 */
public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_DONE = "com.watchkeeper.DONE";
    public static final String ACTION_SNOOZE = "com.watchkeeper.SNOOZE";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        String id = intent.getStringExtra(Alarms.EXTRA_ID);
        if (id == null) return;

        if (ACTION_DONE.equals(action) || ACTION_SNOOZE.equals(action)) {
            handleAction(context, id, ACTION_DONE.equals(action) ? "done" : "snooze");
            return;
        }

        String title = intent.getStringExtra(Alarms.EXTRA_TITLE);
        String body = intent.getStringExtra(Alarms.EXTRA_BODY);
        fire(context, id, title, body);
    }

    /** Answering from the notification shade, without opening the app first. */
    private static void handleAction(Context c, String id, String what) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(Math.abs(id.hashCode()));
        Ringer.stop(c);

        if ("snooze".equals(what)) {
            AlarmStore.Pending p = AlarmStore.find(c, id);
            long at = System.currentTimeMillis() + 10 * 60 * 1000L;
            if (p != null) Alarms.schedule(c, id, at, p.title, p.body);
        } else {
            Alarms.cancel(c, id);
        }

        /* Hand the same action to the web layer so its own list agrees. The
           page already understands this, from the service-worker version. */
        Intent open = new Intent(c, MainActivity.class);
        open.setAction(MainActivity.ACTION_WEB_COMMAND);
        open.putExtra("act", what);
        open.putExtra("id", id);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            c.startActivity(open);
        } catch (Exception ignored) {
            /* Android 10+ may refuse a background launch; MainActivity picks
               the action up from the store next time it opens. */
            PendingActions.add(c, what, id);
        }
    }

    public static void fire(Context c, String id, String title, String body) {
        /* The last line of defence against a ring loop: whatever asked for
           this, the same reminder is never announced twice in quick
           succession. */
        if (AlarmStore.recentlyFired(c, id, 60_000L)) return;
        AlarmStore.markFired(c, id);

        Alarms.ensureChannel(c);

        Intent full = new Intent(c, AlarmActivity.class);
        full.putExtra(Alarms.EXTRA_ID, id);
        full.putExtra(Alarms.EXTRA_TITLE, title);
        full.putExtra(Alarms.EXTRA_BODY, body);
        full.setData(Uri.parse("watchkeeper://ring/" + id));
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NO_USER_ACTION);

        PendingIntent fullPi = PendingIntent.getActivity(c, Math.abs(id.hashCode()), full,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        PendingIntent donePi = actionIntent(c, id, ACTION_DONE, 1);
        PendingIntent snoozePi = actionIntent(c, id, ACTION_SNOOZE, 2);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(c, Alarms.CHANNEL_ID);
        } else {
            b = new Notification.Builder(c);
        }
        b.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title == null || title.isEmpty() ? "Reminder" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_MAX)
                .setAutoCancel(false)
                .setOngoing(false)
                .setContentIntent(fullPi)
                .setFullScreenIntent(fullPi, true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(null, "Done", donePi).build())
                .addAction(new Notification.Action.Builder(null, "Snooze 10m", snoozePi).build());

        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) {
            try {
                nm.notify(Math.abs(id.hashCode()), b.build());
            } catch (Exception ignored) {
            }
        }

        /* Ring and buzz regardless of whether the activity was allowed up. */
        Ringer.start(c, id, title, body);
    }

    private static PendingIntent actionIntent(Context c, String id, String action, int slot) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(action);
        i.putExtra(Alarms.EXTRA_ID, id);
        i.setData(Uri.parse("watchkeeper://" + action + "/" + id));
        return PendingIntent.getBroadcast(c, Math.abs(id.hashCode()) + slot, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
