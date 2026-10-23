package com.watchkeeper;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Answers given while the app was not running.
 *
 * Tapping Done in the notification shade settles the alarm immediately, but
 * the web layer keeps the reminder list and may not be loaded yet. The action
 * is parked here and replayed the next time the page is ready, so the two
 * never disagree.
 */
public class PendingActions {

    private static final String PREFS = "watchkeeper_actions";
    private static final String KEY = "queue";

    public static class Item {
        public final String action;
        public final String id;
        Item(String action, String id) { this.action = action; this.id = id; }
    }

    private static SharedPreferences prefs(Context c) {
        return c.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized void add(Context c, String action, String id) {
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
            JSONObject o = new JSONObject();
            o.put("action", action);
            o.put("id", id);
            arr.put(o);
            prefs(c).edit().putString(KEY, arr.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** Returns everything queued and empties the queue in the same step. */
    public static synchronized List<Item> drain(Context c) {
        List<Item> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(c).getString(KEY, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                out.add(new Item(o.getString("action"), o.getString("id")));
            }
        } catch (Exception ignored) {
        }
        prefs(c).edit().putString(KEY, "[]").apply();
        return out;
    }
}
