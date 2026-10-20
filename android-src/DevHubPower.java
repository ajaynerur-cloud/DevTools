package __PKG__;

import android.app.ActivityManager;
import android.app.AlarmManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DevHubPower: what Android needs so reminders fire while Toolbox+ is closed, and shortcuts to the screens that change it.
 *   status()                    → { notifications, exactAlarms, batteryUnrestricted, backgroundRestricted, manufacturer, autostart, sdk }
 *   requestBatteryExemption()   → system dialog "Let app always run in background?" (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
 *   openAppSettings()           → App info (Battery → Unrestricted, background usage, permissions)
 *   openNotificationSettings()  → this app's notification settings
 *   openExactAlarmSettings()    → "Alarms & reminders" (Android 12+)
 *   openAutostart()             → the phone maker's auto-start / background launch screen (Xiaomi, Oppo, Vivo, Huawei, …);
 *                                 on OnePlus / Oppo / Realme (Android 13+) App info, where "Battery usage" holds Allow auto launch,
 *                                 Allow background activity and Optimise battery usage
 *   setReminders({ reminders })  → native reminders with background Snooze buttons (see Reminders.java)
 *   showNow({ title, body, ref }) → show one reminder immediately (test)
 *   takeState()                 → { snoozes: [{ ref, until, how }], route } since the last call (and clears them)
 */
@CapacitorPlugin(name = "DevHubPower")
public class DevHubPower extends Plugin {

    private static final ComponentName[] AUTOSTART = new ComponentName[] {
        new ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
        new ComponentName("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity"),
        new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
        new ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
        new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
        new ComponentName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
        new ComponentName("com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity"),
        new ComponentName("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
        new ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
        new ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
        new ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
        new ComponentName("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
        new ComponentName("com.asus.mobilemanager", "com.asus.mobilemanager.entry.FunctionActivity"),
        new ComponentName("com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"),
        new ComponentName("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
        new ComponentName("com.transsion.phonemanager", "com.itel.autobootmanager.activity.AutoBootMgrActivity"),
        new ComponentName("com.evenwell.powersaving.g3", "com.evenwell.powersaving.g3.exception.PowerSaverExceptionActivity")
    };
    private static final String[] AUTOSTART_MAKERS = new String[] { "xiaomi", "redmi", "poco", "letv", "huawei", "honor", "oppo", "realme", "oneplus", "vivo", "iqoo", "asus", "samsung", "infinix", "tecno", "itel", "nokia" };

    private String pkg() { return getContext().getPackageName(); }

    private boolean open(Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean openAppDetails() {
        return open(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg())));
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        JSObject r = new JSObject();
        boolean notif = true;
        try { notif = NotificationManagerCompat.from(ctx).areNotificationsEnabled(); } catch (Exception ignored) { }
        boolean exact = true;
        if (Build.VERSION.SDK_INT >= 31) {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            exact = am == null || am.canScheduleExactAlarms();
        }
        boolean battery = true;
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            battery = pm == null || pm.isIgnoringBatteryOptimizations(pkg());
        }
        boolean bgRestricted = false;
        if (Build.VERSION.SDK_INT >= 28) {
            ActivityManager act = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            bgRestricted = act != null && act.isBackgroundRestricted();
        }
        r.put("nativeReminders", true);
        String maker = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        boolean autostart = false;
        for (String m : AUTOSTART_MAKERS) if (maker.contains(m)) { autostart = true; break; }
        r.put("notifications", notif);
        r.put("exactAlarms", exact);
        r.put("batteryUnrestricted", battery);
        r.put("backgroundRestricted", bgRestricted);
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("autostart", autostart);
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= 23) {
            ok = open(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg())));
            if (!ok) ok = open(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
        if (!ok) ok = openAppDetails();
        JSObject r = new JSObject(); r.put("opened", ok); call.resolve(r);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        JSObject r = new JSObject(); r.put("opened", openAppDetails()); call.resolve(r);
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            i.putExtra(Settings.EXTRA_APP_PACKAGE, pkg());
            ok = open(i);
        }
        if (!ok) ok = openAppDetails();
        JSObject r = new JSObject(); r.put("opened", ok); call.resolve(r);
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        boolean ok = false;
        if (Build.VERSION.SDK_INT >= 31) ok = open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + pkg())));
        if (!ok) ok = openAppDetails();
        JSObject r = new JSObject(); r.put("opened", ok); call.resolve(r);
    }

    @PluginMethod
    public void setReminders(PluginCall call) {
        JSArray list = call.getArray("reminders");
        JSONArray a = new JSONArray();
        if (list != null) for (int i = 0; i < list.length(); i++) { JSONObject o = list.optJSONObject(i); if (o != null) a.put(o); }
        Reminders.ensureChannel(getContext());
        Reminders.replaceAll(getContext(), a);
        JSObject r = new JSObject(); r.put("scheduled", Reminders.list(getContext()).length()); call.resolve(r);
    }

    @PluginMethod
    public void showNow(PluginCall call) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", 999); o.put("at", System.currentTimeMillis());
            o.put("title", call.getString("title", "Toolbox+ reminder")); o.put("body", call.getString("body", ""));
            o.put("ref", call.getString("ref", "")); o.put("route", call.getString("route", "insurance"));
            Reminders.show(getContext(), o);
        } catch (Exception ignored) { }
        call.resolve();
    }

    @PluginMethod
    public void takeState(PluginCall call) {
        android.content.SharedPreferences p = Reminders.prefs(getContext());
        JSObject r = new JSObject();
        try { r.put("snoozes", new JSArray(p.getString("snoozes", "[]"))); } catch (Exception e) { r.put("snoozes", new JSArray()); }
        r.put("route", p.getString("route", ""));
        p.edit().remove("snoozes").remove("route").apply();
        call.resolve(r);
    }

    @PluginMethod
    public void openAutostart(PluginCall call) {
        boolean ok = false;
        String maker = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        // OnePlus (OxygenOS 13+), Oppo, Realme: Auto launch + background activity live under App info → Battery usage
        if (Build.VERSION.SDK_INT >= 33 && (maker.contains("oneplus") || maker.contains("oppo") || maker.contains("realme"))) {
            ok = openAppDetails();
            JSObject r = new JSObject(); r.put("opened", ok); r.put("fallback", false); r.put("appInfo", true); call.resolve(r);
            return;
        }
        for (ComponentName c : AUTOSTART) {
            Intent i = new Intent();
            i.setComponent(c);
            if (open(i)) { ok = true; break; }
        }
        boolean fallback = false;
        if (!ok) { ok = openAppDetails(); fallback = true; }
        JSObject r = new JSObject(); r.put("opened", ok); r.put("fallback", fallback); call.resolve(r);
    }
}
