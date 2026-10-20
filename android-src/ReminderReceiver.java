package __PKG__;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

/** Alarm → show the reminder; Snooze button → snooze it (no app window opens). Not exported: only Toolbox+'s own alarms and buttons reach it. */
public class ReminderReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (a == null) return;
        Context c = context.getApplicationContext();
        if (Reminders.ACTION_FIRE.equals(a)) {
            JSONObject o = Reminders.take(c, intent.getIntExtra("id", 0));
            if (o != null) Reminders.show(c, o);
        } else if (Reminders.ACTION_SNOOZE.equals(a)) {
            Reminders.snooze(c, intent.getIntExtra("id", 0), intent.getStringExtra("how"));
        }
    }
}
