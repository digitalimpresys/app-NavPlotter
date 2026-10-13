package it.digitalimpresys.navplotter;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps watching the node while the screen is off: asks /api/state every two seconds, sounds the collision alarm on
 * the alarm stream (it plays even in silent mode) and posts a notification for every new chat message.
 * The alarm itself is worked out by the node; this only reads the "alarm" flag of each target.
 */
public class NodeWatchService extends Service {

    static final String TAG = "NodeWatch";
    static final String DEFAULT_URL = "http://192.168.4.1";
    static final String ACTION_START = "start", ACTION_STOP = "stop", ACTION_MUTE = "mute", ACTION_MUTE_TOGGLE = "muteToggle";
    static final String EXTRA_URL = "url", EXTRA_ALARM = "alarm";
    static final String CH_WATCH = "watch", CH_ALARM = "alarm2", CH_MSG = "messages", CH_LINK = "link";
    static final int ID_WATCH = 1, ID_ALARM = 2, ID_LINK = 3, ID_MSG = 10;
    static final long POLL_MS = 2000, LINK_LOST_MS = 30000;

    static volatile boolean running = false;

    private String base = DEFAULT_URL;
    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback netCallback;
    private Network boundTo;
    private NotificationManager nm;
    private MediaPlayer player;
    private boolean sounding = false;
    private Vibrator vibrator;

    // State, only touched on the handler thread
    private final Set<String> alarmIds = new HashSet<>(), mutedIds = new HashSet<>();
    private final Set<String> seenMsgs = new HashSet<>();
    private boolean soundOn = true, online = false, linkLostShown = false, firstMsgs = true;
    private long lastOk = 0, msgStamp = -1;
    private int msgNotifId = ID_MSG;
    private String watchText = "";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        createChannels();
        thread = new HandlerThread("NodeWatch");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null && intent.getAction() != null ? intent.getAction() : ACTION_START;
        switch (action) {
            case ACTION_STOP:
                stopSelf();
                return START_NOT_STICKY;
        }
        if (!running && !action.equals(ACTION_START)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        switch (action) {
            case ACTION_MUTE:
                handler.post(() -> { mutedIds.addAll(alarmIds); updateAlarm(null, 0); });
                return START_STICKY;
            case ACTION_MUTE_TOGGLE:
                handler.post(() -> {
                    if (!alarmIds.isEmpty() && mutedIds.containsAll(alarmIds)) mutedIds.clear(); else mutedIds.addAll(alarmIds);
                    updateAlarm(null, 0);
                });
                return START_STICKY;
        }
        // The address is kept, so a restart by the system (null intent) watches the same node
        SharedPreferences prefs = getSharedPreferences("watch", MODE_PRIVATE);
        String url = intent != null ? intent.getStringExtra(EXTRA_URL) : null;
        if (url != null && !url.isEmpty()) prefs.edit().putString(EXTRA_URL, url).apply();
        base = prefs.getString(EXTRA_URL, DEFAULT_URL);
        watchText = getString(R.string.watch_wait, base);
        try {
            ServiceCompat.startForeground(this, ID_WATCH, watchNotification(),
                Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE : 0);
        } catch (Exception e) {
            Log.w(TAG, "cannot start in foreground: " + e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) {
            running = true;
            acquireLocks();
            watchWifi();
            handler.post(this::poll);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        handler.post(() -> { stopSound(); nm.cancel(ID_ALARM); nm.cancel(ID_LINK); });
        thread.quitSafely();
        if (netCallback != null) try { cm.unregisterNetworkCallback(netCallback); } catch (Exception ignored) {}
        cm.bindProcessToNetwork(null);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    // ---------- keeping CPU and WiFi awake, and talking to the node over WiFi ----------

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NavPlotter:watch");
        wakeLock.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "NavPlotter:watch");
        wifiLock.acquire();
    }

    // The node's WiFi has no internet, so Android sends traffic over mobile data and the node cannot be reached.
    // While on a WiFi without internet, the whole app (web view included) is bound to it.
    private void watchWifi() {
        NetworkRequest req = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                boolean validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                Network want = validated ? null : network;
                if (want == null ? boundTo != null : !want.equals(boundTo)) {
                    boundTo = want;
                    cm.bindProcessToNetwork(want);
                    Log.i(TAG, "bound to " + want);
                }
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(boundTo)) {
                    boundTo = null;
                    cm.bindProcessToNetwork(null);
                }
            }
        };
        cm.requestNetwork(req, netCallback);
    }

    // ---------- polling ----------

    private void poll() {
        if (!running) return;
        try {
            JSONObject st = new JSONObject(get("/api/state"));
            if (!online) {
                online = true;
                readConfig();
            }
            lastOk = System.currentTimeMillis();
            if (linkLostShown) { nm.cancel(ID_LINK); linkLostShown = false; }
            JSONArray targets = st.optJSONArray("targets");
            int n = targets == null ? 0 : targets.length();
            List<JSONObject> alarms = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                JSONObject t = targets.getJSONObject(i);
                if (t.optBoolean("alarm")) alarms.add(t);
            }
            alarms.sort((a, b) -> Double.compare(a.optDouble("tcpa"), b.optDouble("tcpa")));
            alarmIds.clear();
            for (JSONObject t : alarms) alarmIds.add(t.optString("id"));
            mutedIds.retainAll(alarmIds);
            updateAlarm(alarms.isEmpty() ? null : alarms.get(0), alarms.size());
            setWatchText(getString(R.string.watch_ok, base, n));
            long stamp = st.optLong("msgStamp", -1);
            if (stamp != -1 && stamp != msgStamp) {
                msgStamp = stamp;
                checkMessages();
            }
        } catch (Exception e) {
            if (online) Log.w(TAG, "node not reachable: " + e);
            online = false;
            setWatchText(getString(R.string.watch_wait, base));
            // A collision alarm that cannot arrive is worth telling, once
            if (lastOk > 0 && !linkLostShown && System.currentTimeMillis() - lastOk > LINK_LOST_MS) {
                linkLostShown = true;
                nm.notify(ID_LINK, new NotificationCompat.Builder(this, CH_LINK)
                    .setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setContentTitle(getString(R.string.link_lost_title))
                    .setContentText(getString(R.string.link_lost_text))
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(getString(R.string.link_lost_text)))
                    .setContentIntent(openApp(false))
                    .setAutoCancel(true)
                    .build());
            }
            if (!alarmIds.isEmpty()) { alarmIds.clear(); mutedIds.clear(); updateAlarm(null, 0); }
        }
        handler.postDelayed(this::poll, POLL_MS);
    }

    private void readConfig() {
        try {
            JSONObject cfg = new JSONObject(get("/api/config"));
            soundOn = cfg.optBoolean("sound", true);
        } catch (Exception ignored) {}
    }

    private String get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(2500);
        c.setReadTimeout(4000);
        c.setUseCaches(false);
        try (InputStream in = c.getInputStream()) {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int r; (r = in.read(buf)) > 0; ) out.write(buf, 0, r);
            return out.toString("UTF-8");
        } finally {
            c.disconnect();
        }
    }

    // ---------- collision alarm ----------

    private void updateAlarm(JSONObject worst, int count) {
        if (alarmIds.isEmpty()) {
            stopSound();
            nm.cancel(ID_ALARM);
            return;
        }
        boolean silenced = mutedIds.containsAll(alarmIds);
        if (silenced || !soundOn) stopSound(); else startSound();
        if (worst == null) return; // only the sound changed: the notification is refreshed at the next poll
        String title = getString(R.string.alarm_title, worst.optString("name"));
        String text = getString(R.string.alarm_text, String.format(Locale.ROOT, "%.2f", worst.optDouble("cpa")), fmtTime(worst.optDouble("tcpa")));
        if (count > 1) text += " · " + getString(R.string.alarm_more, count - 1);
        if (silenced) text += " · " + getString(R.string.alarm_muted);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CH_ALARM)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setColor(0xFFE5383B)
            .setContentIntent(openApp(true))
            .setFullScreenIntent(openApp(true), true);
        if (!silenced) b.addAction(0, getString(R.string.act_mute), serviceIntent(ACTION_MUTE, 1));
        nm.notify(ID_ALARM, b.build());
    }

    private static String fmtTime(double s) {
        if (s < 0) s = 0;
        int m = (int) (s / 60), sec = (int) (s % 60);
        return String.format(Locale.ROOT, "%d:%02d", m, sec);
    }

    private void startSound() {
        if (sounding) return;
        sounding = true;
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            player.setDataSource(this, uri);
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception e) {
            Log.w(TAG, "alarm sound: " + e);
            if (player != null) { player.release(); player = null; }
        }
        long[] pattern = { 0, 400, 250, 400, 250, 400, 900 };
        if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        else vibrator.vibrate(pattern, 0);
    }

    private void stopSound() {
        if (!sounding) return;
        sounding = false;
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
            player.release();
            player = null;
        }
        vibrator.cancel();
    }

    // ---------- chat messages ----------

    private void checkMessages() {
        try {
            JSONArray list = new JSONObject(get("/api/messages")).optJSONArray("messages");
            if (list == null) return;
            Set<String> now = new HashSet<>();
            for (int i = 0; i < list.length(); i++) {
                JSONObject m = list.getJSONObject(i);
                if (m.optBoolean("mine") || !m.optBoolean("unread")) continue;
                String key = m.optString("peer") + "|" + m.optBoolean("all") + "|" + m.optString("text");
                now.add(key);
                if (firstMsgs || seenMsgs.contains(key)) continue;
                String who = m.optString("name");
                if (m.optBoolean("all")) who = getString(R.string.msg_all, who);
                nm.notify(msgNotifId++, new NotificationCompat.Builder(this, CH_MSG)
                    .setSmallIcon(android.R.drawable.sym_action_chat)
                    .setContentTitle(getString(R.string.msg_title, who))
                    .setContentText(m.optString("text"))
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setContentIntent(openApp(false))
                    .setAutoCancel(true)
                    .build());
                if (msgNotifId > ID_MSG + 50) msgNotifId = ID_MSG;
            }
            // Messages unread when the watch starts are not announced again
            firstMsgs = false;
            seenMsgs.clear();
            seenMsgs.addAll(now);
        } catch (Exception e) {
            msgStamp = -1; // try again at the next poll
        }
    }

    // ---------- notifications ----------

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel watch = new NotificationChannel(CH_WATCH, getString(R.string.ch_watch), NotificationManager.IMPORTANCE_LOW);
        watch.setShowBadge(false);
        // The alarm sound is played by the service on the alarm stream, so the channel itself is silent
        NotificationChannel alarm = new NotificationChannel(CH_ALARM, getString(R.string.ch_alarm), NotificationManager.IMPORTANCE_HIGH);
        alarm.setSound(null, null);
        alarm.enableVibration(false);
        alarm.setBypassDnd(true);
        alarm.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel msg = new NotificationChannel(CH_MSG, getString(R.string.ch_msg), NotificationManager.IMPORTANCE_HIGH);
        msg.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationChannel link = new NotificationChannel(CH_LINK, getString(R.string.ch_link), NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(watch);
        nm.createNotificationChannel(alarm);
        nm.createNotificationChannel(msg);
        nm.createNotificationChannel(link);
    }

    private Notification watchNotification() {
        return new NotificationCompat.Builder(this, CH_WATCH)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle(getString(R.string.watch_title))
            .setContentText(watchText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(false))
            .addAction(0, getString(R.string.act_stop), serviceIntent(ACTION_STOP, 2))
            .build();
    }

    private void setWatchText(String text) {
        if (text.equals(watchText)) return;
        watchText = text;
        nm.notify(ID_WATCH, watchNotification());
    }

    private PendingIntent openApp(boolean alarm) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        i.putExtra(EXTRA_ALARM, alarm);
        return PendingIntent.getActivity(this, alarm ? 11 : 10, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent serviceIntent(String action, int code) {
        Intent i = new Intent(this, NodeWatchService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
