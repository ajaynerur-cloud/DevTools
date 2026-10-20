package __PKG__;

import android.annotation.SuppressLint;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.text.DateFormat;
import java.util.Calendar;
import java.util.Date;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Toolbox+'s own reminder engine (Insurance renewals), fully native so it works while the app is closed:
 *  - each reminder is an exact AlarmManager alarm (allowed while idle / Doze) → ReminderReceiver shows the notification;
 *  - the notification has Snooze 15 min / Snooze 1 hour / Tomorrow buttons that are handled IN THE BACKGROUND by
 *    ReminderReceiver: the notification is cleared, a new alarm is set and the snoozed reminder appears again in the
 *    notification bar — the app is not opened;
 *  - reminders are kept in SharedPreferences, so they are set again after a restart or an app update (BootReceiver).
 * The web app (notify.js) hands over the full list with DevHubPower.setReminders() and reads back the snoozes with takeState().
 */
public final class Reminders {
    static final String PREFS = "devhub_reminders";
    static final String CHANNEL = "devhub-reminders";
    static final String ACTION_FIRE = "devhub.reminder.FIRE";
    static final String ACTION_SNOOZE = "devhub.reminder.SNOOZE";
    static final String EXTRA_ROUTE = "devhub_route";

    private Reminders() { }

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static JSONArray list(Context c) {
        try { return new JSONArray(prefs(c).getString("list", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    static void saveList(Context c, JSONArray a) { prefs(c).edit().putString("list", a.toString()).apply(); }

    private static PendingIntent fireIntent(Context c, int id) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_FIRE).setData(Uri.parse("devhub://reminder/" + id));
        i.putExtra("id", id);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressLint({"MissingPermission", "ScheduleExactAlarm"})
    static void setAlarm(Context c, int id, long at) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = fireIntent(c, id);
        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else if (Build.VERSION.SDK_INT >= 23) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            else am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) {
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    static void cancelAlarm(Context c, int id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(fireIntent(c, id));
    }

    /** Replace every scheduled reminder with this list: [{ id, at (ms), title, body, ref, route }]. */
    static synchronized void replaceAll(Context c, JSONArray next) {
        JSONArray old = list(c);
        for (int i = 0; i < old.length(); i++) { JSONObject o = old.optJSONObject(i); if (o != null) cancelAlarm(c, o.optInt("id")); }
        long now = System.currentTimeMillis();
        JSONArray keep = new JSONArray();
        for (int i = 0; i < next.length(); i++) {
            JSONObject o = next.optJSONObject(i);
            if (o == null || o.optLong("at") <= now) continue;
            setAlarm(c, o.optInt("id"), o.optLong("at"));
            keep.put(o);
        }
        saveList(c, keep);
    }

    /** After a restart / app update: set the alarms again (AlarmManager forgets them). */
    static synchronized void restore(Context c) {
        JSONArray a = list(c), keep = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i); if (o == null) continue;
            long at = o.optLong("at");
            if (at <= now) { if (now - at < 6 * 3600000L) show(c, o); continue; }   // missed while the phone was off: show it now
            setAlarm(c, o.optInt("id"), at); keep.put(o);
        }
        saveList(c, keep);
    }

    static synchronized JSONObject take(Context c, int id) {
        JSONArray a = list(c), keep = new JSONArray(); JSONObject found = null;
        for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o == null) continue; if (o.optInt("id") == id && found == null) found = o; else keep.put(o); }
        saveList(c, keep);
        return found;
    }

    static synchronized void add(Context c, JSONObject o) {
        JSONArray a = list(c); a.put(o); saveList(c, a);
        setAlarm(c, o.optInt("id"), o.optLong("at"));
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Insurance renewals, task reminders and your daily summary");
        ch.enableVibration(true);
        ch.setLockscreenVisibility(NotificationCompat.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    private static PendingIntent snoozeIntent(Context c, int id, String how) {
        Intent i = new Intent(c, ReminderReceiver.class).setAction(ACTION_SNOOZE).setData(Uri.parse("devhub://snooze/" + id + "/" + how));
        i.putExtra("id", id); i.putExtra("how", how);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openIntent(Context c, int id, String route) {
        Intent i = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (i == null) i = new Intent(c, MainActivity.class);
        i.setData(Uri.parse("devhub://open/" + id));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(EXTRA_ROUTE, route == null || route.isEmpty() ? "insurance" : route);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Show one reminder in the notification bar, with the Snooze buttons. */
    @SuppressLint("MissingPermission")
    static void show(Context c, JSONObject o) {
        ensureChannel(c);
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (!nm.areNotificationsEnabled()) return;
        int id = o.optInt("id");
        String body = o.optString("body");
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(o.optString("title", "Toolbox+ reminder"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(openIntent(c, id, o.optString("route")))
            .addAction(0, "Snooze 15 min", snoozeIntent(c, id, "snooze15"))
            .addAction(0, "Snooze 1 hour", snoozeIntent(c, id, "snooze60"))
            .addAction(0, "Tomorrow", snoozeIntent(c, id, "tomorrow"));
        try { nm.notify(id, b.build()); } catch (SecurityException ignored) { }
        // remember what was shown, so a Snooze button can bring the same text back
        try { prefs(c).edit().putString("shown:" + id, o.toString()).apply(); } catch (Exception ignored) { }
    }

    /** A Snooze button was pressed: clear the notification and bring it back later — all in the background. */
    static void snooze(Context c, int id, String how) {
        NotificationManagerCompat.from(c).cancel(id);
        JSONObject o;
        try { o = new JSONObject(prefs(c).getString("shown:" + id, "{}")); } catch (Exception e) { o = new JSONObject(); }
        long now = System.currentTimeMillis(), until;
        if ("snooze15".equals(how)) until = now + 15 * 60000L;
        else if ("snooze60".equals(how)) until = now + 3600000L;
        else {   // tomorrow, at the same time of day as the original reminder (or 09:00)
            Calendar cal = Calendar.getInstance();
            long orig = o.optLong("at", 0);
            Calendar t = Calendar.getInstance(); if (orig > 0) t.setTimeInMillis(orig); else { t.set(Calendar.HOUR_OF_DAY, 9); t.set(Calendar.MINUTE, 0); }
            cal.add(Calendar.DAY_OF_YEAR, 1);
            cal.set(Calendar.HOUR_OF_DAY, t.get(Calendar.HOUR_OF_DAY)); cal.set(Calendar.MINUTE, t.get(Calendar.MINUTE)); cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0);
            until = cal.getTimeInMillis();
        }
        String ref = o.optString("ref", "");
        int nid = (int) (Math.abs((long) (ref + ":" + until).hashCode()) % 2000000000L) + 1000;
        try {
            JSONObject n = new JSONObject();
            n.put("id", nid); n.put("at", until); n.put("ref", ref); n.put("route", o.optString("route", "insurance"));
            n.put("title", o.optString("title", "Toolbox+ reminder"));
            String body = o.optString("body", "");
            n.put("body", body.endsWith(" · snoozed") ? body : body + " · snoozed");
            add(c, n);
            // tell the web app the next time it opens, so the policy shows "Snoozed until …" and the schedule respects it
            JSONArray s = new JSONArray(prefs(c).getString("snoozes", "[]"));
            JSONObject e = new JSONObject(); e.put("ref", ref); e.put("until", until); e.put("how", how); s.put(e);
            prefs(c).edit().putString("snoozes", s.toString()).apply();
        } catch (Exception ignored) { }
        try {
            String when = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(until));
            android.widget.Toast.makeText(c, "Snoozed until " + ("tomorrow".equals(how) ? "tomorrow " : "") + when, android.widget.Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) { }
    }
}
