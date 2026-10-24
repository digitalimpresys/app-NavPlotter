package it.digitalimpresys.navplotter;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NodeWatchPlugin.class);
        super.onCreate(savedInstanceState);
        wakeForAlarm(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        wakeForAlarm(intent);
    }

    // Opened by the collision alarm: show over the lock screen and turn the screen on
    private void wakeForAlarm(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(NodeWatchService.EXTRA_ALARM, false)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
    }
}
