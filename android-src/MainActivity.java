package __PKG__;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

// Copied into the generated Android project by .github/workflows/android.yml (package name filled in there).
// Registers Toolbox+'s own plugin (permissions + native reminders) and remembers which page a tapped reminder should open.
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(DevHubPower.class);
        super.onCreate(savedInstanceState);
        keepRoute(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        keepRoute(intent);
    }

    private void keepRoute(Intent i) {
        if (i == null || !i.hasExtra(Reminders.EXTRA_ROUTE)) return;
        Reminders.prefs(this).edit().putString("route", i.getStringExtra(Reminders.EXTRA_ROUTE)).apply();
        i.removeExtra(Reminders.EXTRA_ROUTE);
    }
}
