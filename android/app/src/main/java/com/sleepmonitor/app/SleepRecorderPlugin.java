package com.sleepmonitor.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
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

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/** JavaScript bridge (window.Capacitor.Plugins.SleepRecorder) to the background SleepService. */
@CapacitorPlugin(
        name = "SleepRecorder",
        permissions = {
                @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
                @Permission(strings = { "android.permission.POST_NOTIFICATIONS" }, alias = "notifications"),
        }
)
public class SleepRecorderPlugin extends Plugin {

    // ------------------------------------------------------------------ monitoring
    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micCallback");
            return;
        }
        askNotificationsThenStart(call);
    }

    @PermissionCallback
    private void micCallback(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission was denied. Allow it in Android Settings > Apps > Sleep Monitor > Permissions.");
            return;
        }
        askNotificationsThenStart(call);
    }

    private void askNotificationsThenStart(PluginCall call) {
        // Android 13+: the "monitoring" notification needs permission to be visible (monitoring works either way)
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void notifCallback(PluginCall call) { doStart(call); }

    private void doStart(PluginCall call) {
        JSObject settings = call.getObject("settings", new JSObject());
        Context ctx = getContext();
        Intent i = new Intent(ctx, SleepService.class)
                .setAction(SleepService.ACTION_START)
                .putExtra(SleepService.EXTRA_SETTINGS, settings.toString());
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (Exception e) {
            call.reject("Could not start monitoring: " + e.getMessage());
            return;
        }
        // wait (max 3 s) until the service records so the first status is meaningful
        new Thread(() -> {
            for (int t = 0; t < 60; t++) {
                SleepService s = SleepService.instance;
                if (s != null && s.isRecording()) break;
                try { Thread.sleep(50); } catch (InterruptedException ignored) { }
            }
            call.resolve(statusObject());
        }).start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        SleepService s = SleepService.instance;
        if (s == null) { call.resolve(new JSObject()); return; }
        new Thread(() -> {
            JSONObject summary = s.stopMonitoring();
            JSObject r = new JSObject();
            if (summary != null) r.put("session", toJS(summary));
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(statusObject()); }

    private JSObject statusObject() {
        SleepService s = SleepService.instance;
        if (s == null || !s.isRunning()) {
            JSObject r = new JSObject();
            r.put("running", false);
            r.put("stopping", false);
            String err = SleepService.lastError; // why the last night ended by itself, if it did
            if (err != null) r.put("error", err);
            return r;
        }
        return toJS(s.status());
    }

    @PluginMethod
    public void update(PluginCall call) {
        SleepService s = SleepService.instance;
        JSObject settings = call.getObject("settings");
        if (s != null && settings != null) s.applySettings(settings.toString());
        call.resolve();
    }

    // ------------------------------------------------------------------ saved nights
    /** The service while this night is in memory: being recorded or still being saved (files not final yet). */
    private static SleepService liveService(String id) {
        SleepService s = SleepService.instance;
        return s != null && id != null && s.isLive(id) ? s : null;
    }

    private static String busyMessage(SleepService live, String id) {
        return live.isStopping(id) ? "The night is still being saved, try again in a few seconds." : "Stop monitoring first.";
    }

    @PluginMethod
    public void listSessions(PluginCall call) {
        JSArray list = new JSArray();
        File[] dirs = SleepService.rootDir(getContext()).listFiles();
        if (dirs != null) {
            for (File d : dirs) {
                if (!d.isDirectory()) continue;
                try {
                    SleepService live = liveService(d.getName());
                    JSONObject s = live != null ? live.snapshot(d.getName(), true) : null;
                    boolean isLive = s != null;
                    if (s == null) s = readSession(d);
                    if (s == null) continue;
                    s.put("spark", spark(s.optJSONArray("levels"), 60)); // small graph for the week grid
                    s.remove("levels");
                    s.put("live", isLive);
                    s.put("stopping", isLive && live.isStopping(d.getName()));
                    s.put("bytes", dirSize(d));
                    list.put(s);
                } catch (Exception ignored) { }
            }
        }
        JSObject r = new JSObject();
        r.put("sessions", list);
        call.resolve(r);
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        String id = call.getString("id");
        File d = sessionDir(id);
        if (d == null) { call.reject("not found"); return; }
        try {
            SleepService live = liveService(id);
            JSONObject s = live != null ? live.snapshot(id, true) : null;
            boolean isLive = s != null;
            if (s == null) s = readSession(d);
            if (s == null) { call.reject("not found"); return; }
            s.put("live", isLive);
            s.put("stopping", isLive && live.isStopping(id));
            addPaths(s.optJSONArray("clips"), d);
            addPaths(s.optJSONArray("segments"), d);
            JSObject r = new JSObject();
            r.put("session", toJS(s));
            call.resolve(r);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void deleteSession(PluginCall call) {
        String id = call.getString("id");
        SleepService live = liveService(id);
        if (live != null) { call.reject(busyMessage(live, id)); return; }
        File d = sessionDir(id);
        if (d != null) deleteRecursive(d);
        call.resolve();
    }

    @PluginMethod
    public void deleteClip(PluginCall call) {
        String id = call.getString("sessionId"), clipId = call.getString("clipId");
        SleepService live = liveService(id);
        if (live != null && live.removeClip(id, clipId)) { call.resolve(); return; } // else: saved meanwhile
        File d = sessionDir(id);
        try {
            JSONObject s = d == null ? null : readSession(d);
            if (s == null) { call.reject("not found"); return; }
            JSONArray clips = s.optJSONArray("clips");
            for (int i = 0; clips != null && i < clips.length(); i++) {
                JSONObject c = clips.optJSONObject(i);
                if (c != null && clipId.equals(c.optString("id"))) {
                    new File(d, c.optString("file")).delete();
                    clips.remove(i);
                    break;
                }
            }
            writeSession(d, s);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void deleteFull(PluginCall call) {
        String id = call.getString("sessionId");
        SleepService live = liveService(id);
        if (live != null) { call.reject(busyMessage(live, id)); return; }
        File d = sessionDir(id);
        try {
            JSONObject s = d == null ? null : readSession(d);
            if (s == null) { call.reject("not found"); return; }
            JSONArray segs = s.optJSONArray("segments");
            for (int i = 0; segs != null && i < segs.length(); i++) {
                new File(d, segs.optJSONObject(i).optString("file")).delete();
            }
            s.put("segments", new JSONArray());
            writeSession(d, s);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Stores the sound-recognition result of a finished night in its session.json. */
    @PluginMethod
    public void saveAnalysis(PluginCall call) {
        String id = call.getString("sessionId");
        JSObject analysis = call.getObject("analysis");
        SleepService live = liveService(id);
        if (live != null) {
            call.reject(live.isStopping(id) ? "Night is still being saved" : "Night is still being recorded");
            return;
        }
        File d = sessionDir(id);
        try {
            JSONObject s = d == null ? null : readSession(d);
            if (s == null || analysis == null) { call.reject("not found"); return; }
            s.put("analysis", new JSONObject(analysis.toString()));
            writeSession(d, s);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Opens Android's share sheet for recordings (save to Files/Drive, send by email, ...). */
    @PluginMethod
    public void share(PluginCall call) {
        JSArray files = call.getArray("files");
        Context ctx = getContext();
        File outDir = new File(ctx.getCacheDir(), "share");
        deleteRecursive(outDir);
        outDir.mkdirs();
        ArrayList<Uri> uris = new ArrayList<>();
        try {
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                File src = new File(f.getString("path"));
                if (!src.getCanonicalPath().startsWith(ctx.getFilesDir().getCanonicalPath())) continue;
                File dst = new File(outDir, new File(f.optString("name", src.getName())).getName());
                copy(src, dst);
                uris.add(FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", dst));
            }
        } catch (Exception e) {
            call.reject("Could not prepare files: " + e.getMessage());
            return;
        }
        if (uris.isEmpty()) { call.reject("No files"); return; }
        Intent send;
        if (uris.size() == 1) {
            send = new Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris.get(0));
        } else {
            send = new Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        }
        send.setType("audio/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, "Save or send recordings");
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(chooser);
        call.resolve();
    }

    // ------------------------------------------------------------------ battery optimisation
    @PluginMethod
    public void batteryStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("ignoring", isIgnoringBattery());
        call.resolve(r);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
            getActivity().startActivity(i);
        } catch (Exception e) {
            try { getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
            catch (Exception ignored) { }
        }
        call.resolve();
    }

    private boolean isIgnoringBattery() {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    // ------------------------------------------------------------------ helpers
    private File sessionDir(String id) {
        if (id == null || id.contains("/") || id.contains("..")) return null;
        File d = new File(SleepService.rootDir(getContext()), id);
        return d.isDirectory() ? d : null;
    }

    private static JSONObject readSession(File d) throws IOException, JSONException {
        File f = new File(d, "session.json");
        if (!f.exists()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONObject(out.toString("UTF-8"));
        }
    }

    private static void writeSession(File d, JSONObject s) throws IOException {
        File tmp = new File(d, "session.json.tmp");
        try (OutputStream out = new FileOutputStream(tmp)) { out.write(s.toString().getBytes("UTF-8")); }
        tmp.renameTo(new File(d, "session.json"));
    }

    private static void addPaths(JSONArray arr, File d) throws JSONException {
        for (int i = 0; arr != null && i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            o.put("path", new File(d, o.optString("file")).getAbsolutePath());
        }
    }

    /** Downsamples the per-second levels to at most n points (max of each bucket). */
    private static JSONArray spark(JSONArray lv, int n) {
        JSONArray out = new JSONArray();
        if (lv == null || lv.length() == 0) return out;
        int len = lv.length(), buckets = Math.min(n, len);
        for (int b = 0; b < buckets; b++) {
            int from = (int) ((long) b * len / buckets), to = Math.max(from + 1, (int) ((long) (b + 1) * len / buckets));
            double m = 0;
            for (int i = from; i < to && i < len; i++) m = Math.max(m, lv.optDouble(i, 0));
            out.put(Math.round(m));
        }
        return out;
    }

    private static long dirSize(File d) {
        long n = 0;
        File[] fs = d.listFiles();
        if (fs != null) for (File f : fs) n += f.length();
        return n;
    }

    private static void deleteRecursive(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }

    private static void copy(File src, File dst) throws IOException {
        try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static JSObject toJS(JSONObject o) {
        try { return new JSObject(o.toString()); } catch (JSONException e) { return new JSObject(); }
    }
}
