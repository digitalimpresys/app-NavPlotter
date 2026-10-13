package it.digitalimpresys.navplotter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Bridge from the web app to the watch service (see navplotter-bridge.js). */
@CapacitorPlugin(name = "NodeWatch", permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class NodeWatchPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Started even without notifications: the alarm sound does not need them, only the banner does
        startService(call);
    }

    private void startService(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, NodeWatchService.class).setAction(NodeWatchService.ACTION_START);
        i.putExtra(NodeWatchService.EXTRA_URL, call.getString("url", NodeWatchService.DEFAULT_URL));
        ContextCompat.startForegroundService(ctx, i);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        send(NodeWatchService.ACTION_STOP);
        call.resolve();
    }

    /** The silence button on the page's alarm banner: same toggle as the page. */
    @PluginMethod
    public void mute(PluginCall call) {
        if (NodeWatchService.running) send(NodeWatchService.ACTION_MUTE_TOGGLE);
        call.resolve();
    }

    private void send(String action) {
        Context ctx = getContext();
        ctx.startService(new Intent(ctx, NodeWatchService.class).setAction(action));
    }

    @SuppressLint("BatteryLife")
    @PluginMethod
    public void ignoreBatteryOptimizations(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (!pm.isIgnoringBatteryOptimizations(ctx.getPackageName())) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
            getActivity().startActivity(i);
        }
        call.resolve();
    }

    /** Downloads a file from the node (the GPX track) and offers it to the share sheet, to save or send. */
    @PluginMethod
    public void shareFromNode(PluginCall call) {
        String url = call.getString("url");
        getBridge().execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "share");
                dir.mkdirs();
                File out = new File(dir, "navplotter-track.gpx");
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(20000);
                String cd = c.getHeaderField("Content-Disposition");
                if (cd != null && cd.contains("filename=\"")) {
                    String name = cd.substring(cd.indexOf("filename=\"") + 10);
                    name = name.substring(0, Math.max(0, name.indexOf('"'))).replaceAll("[^A-Za-z0-9._-]", "");
                    if (!name.isEmpty()) out = new File(dir, name);
                }
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent send = new Intent(Intent.ACTION_SEND).setType("application/gpx+xml").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(Intent.createChooser(send, getContext().getString(R.string.share_gpx)));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.toString());
            }
        });
    }
}
