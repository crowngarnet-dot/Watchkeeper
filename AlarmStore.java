package com.watchkeeper;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The small native mirror of what the web app has scheduled.
 *
 * The reminder list itself stays in the WebView's own storage. This holds only
 * what AlarmManager needs — id, time, title, body — so alarms can be put back
 * after a reboot, when no WebView is running to tell us about them.
 */
public class AlarmStore {

    private static final String PREFS = "watchkeeper_alarms";
    private static final String KEY = "pending";

    public static class Pending {
        public final String id;
        public final long at;
        public final String title;
        public final String body;
        /** When this reminder was last announced; 0 means never. */
        public final long fired;

        Pending(String id, long at, String title, String body, long fired) {
            this.id = id;
            this.at = at;
            this.title = title == null ? "Reminder" : title;
            this.body = body == null ? "" : body;
            this.fired = fired;
        }

        /** AlarmManager and notifications need an int; ids are short strings. */
        public int numericId() {
            return Math.abs(id.hashCode());
        }
    }

    private static SharedPreferences prefs(Context c) {
        Context dc = c.createDeviceProtectedStorageContext();
        return dc.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized List<Pending> all(Context c) {
        List<Pending> out = new ArrayList<>();
        String raw = prefs(c).getString(KEY, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                out.add(new Pending(
                        o.getString("id"),
                        o.getLong("at"),
                        o.optString("title", "Reminder"),
                        o.optString("body", ""),
                        o.optLong("fired", 0L)));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static synchronized void write(Context c, List<Pending> list) {
        JSONArray arr = new JSONArray();
        for (Pending p : list) {
            try {
                JSONObject o = new JSONObject();
                o.put("id", p.id);
                o.put("at", p.at);
                o.put("title", p.title);
                o.put("body", p.body);
                o.put("fired", p.fired);
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        prefs(c).edit().putString(KEY, arr.toString()).apply();
    }

    public static synchronized void put(Context c, String id, long at, String title, String body) {
        List<Pending> list = all(c);
        List<Pending> next = new ArrayList<>();
        long fired = 0L;
        for (Pending p : list) {
            if (p.id.equals(id)) {
                /* Moving a reminder to a new time makes it ringable again;
                   re-storing it at the same time does not. */
                if (p.at == at) fired = p.fired;
            } else {
                next.add(p);
            }
        }
        next.add(new Pending(id, at, title, body, fired));
        write(c, next);
    }

    /** Records that this reminder has just been announced. */
    public static synchronized void markFired(Context c, String id) {
        List<Pending> next = new ArrayList<>();
        for (Pending p : all(c)) {
            next.add(p.id.equals(id)
                    ? new Pending(p.id, p.at, p.title, p.body, System.currentTimeMillis())
                    : p);
        }
        write(c, next);
    }

    /**
     * Backstop against any path that tries to ring the same reminder twice.
     * Even if some caller misbehaves, the phone stays quiet.
     */
    public static synchronized boolean recentlyFired(Context c, String id, long withinMs) {
        Pending p = find(c, id);
        if (p == null || p.fired == 0L) return false;
        long since = System.currentTimeMillis() - p.fired;
        return since >= 0 && since < withinMs;
    }

    public static synchronized void remove(Context c, String id) {
        List<Pending> next = new ArrayList<>();
        for (Pending p : all(c)) {
            if (!p.id.equals(id)) next.add(p);
        }
        write(c, next);
    }

    public static synchronized void clear(Context c) {
        write(c, new ArrayList<Pending>());
    }

    public static synchronized Pending find(Context c, String id) {
        for (Pending p : all(c)) {
            if (p.id.equals(id)) return p;
        }
        return null;
    }

    /** Drops anything whose time has long passed, so the store cannot grow forever. */
    public static synchronized void prune(Context c, long olderThan) {
        List<Pending> next = new ArrayList<>();
        for (Pending p : all(c)) {
            if (p.at > olderThan) next.add(p);
        }
        write(c, next);
    }
}
