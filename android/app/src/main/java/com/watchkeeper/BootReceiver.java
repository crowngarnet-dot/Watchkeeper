package com.watchkeeper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Alarms do not survive a restart on their own, so every pending one is put
 * back here. Also re-run after an app update and after the clock or time zone
 * changes, since a stored instant can land on a different wall time.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (a == null) return;

        switch (a) {
            case Intent.ACTION_BOOT_COMPLETED:
            case "android.intent.action.LOCKED_BOOT_COMPLETED":
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_TIME_CHANGED:
            case Intent.ACTION_TIMEZONE_CHANGED:
                Alarms.restoreAll(context.getApplicationContext());
                break;
            default:
                break;
        }
    }
}
