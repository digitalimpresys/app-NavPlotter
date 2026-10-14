package it.digitalimpresys.navplotter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
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
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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

    /** The silence button on the page's alarm banner: on=true silences the boats now in alarm, on=false lets them sound. */
    @PluginMethod
    public void mute(PluginCall call) {
        if (NodeWatchService.running) send(call.getBoolean("on", true) ? NodeWatchService.ACTION_MUTE : NodeWatchService.ACTION_UNMUTE);
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
        boolean ignoring = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        // ask=false only reports the state, for the App card
        if (!ignoring && call.getBoolean("ask", true)) {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
            getActivity().startActivity(i);
        }
        JSObject r = new JSObject();
        r.put("ignoring", ignoring);
        call.resolve(r);
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

    /** The NavPlotter nodes announced on the current network (mDNS _navplotter._tcp), with their id. */
    @PluginMethod
    public void discover(PluginCall call) {
        NsdManager nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        List<NsdServiceInfo> found = new ArrayList<>();
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onServiceLost(NsdServiceInfo info) {}
            @Override public void onStartDiscoveryFailed(String type, int error) {}
            @Override public void onStopDiscoveryFailed(String type, int error) {}
            @Override public void onServiceFound(NsdServiceInfo info) { synchronized (found) { found.add(info); } }
        };
        try {
            nsd.discoverServices("_navplotter._tcp", NsdManager.PROTOCOL_DNS_SD, listener);
        } catch (Exception e) {
            call.reject(e.toString());
            return;
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) {}
            List<NsdServiceInfo> list;
            synchronized (found) { list = new ArrayList<>(found); }
            resolveNext(nsd, list, 0, new JSArray(), call);
        }, Math.max(1000, call.getInt("timeout", 3000)));
    }

    // Services are resolved one at a time (older Android versions refuse parallel resolves)
    @SuppressWarnings("deprecation")
    private void resolveNext(NsdManager nsd, List<NsdServiceInfo> list, int i, JSArray out, PluginCall call) {
        if (i >= list.size()) {
            JSObject r = new JSObject();
            r.put("nodes", out);
            call.resolve(r);
            return;
        }
        nsd.resolveService(list.get(i), new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int error) {
                resolveNext(nsd, list, i + 1, out, call);
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
                JSObject o = new JSObject();
                if (info.getHost() != null) o.put("host", info.getHost().getHostAddress());
                o.put("port", info.getPort());
                Map<String, byte[]> attrs = info.getAttributes();
                if (attrs.get("id") != null) o.put("id", new String(attrs.get("id"), StandardCharsets.UTF_8));
                if (attrs.get("name") != null) o.put("name", new String(attrs.get("name"), StandardCharsets.UTF_8));
                out.put(o);
                resolveNext(nsd, list, i + 1, out, call);
            }
        });
    }
}
