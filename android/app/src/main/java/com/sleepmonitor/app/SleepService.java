package com.sleepmonitor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Foreground service that monitors sleep sounds with the screen off or while other apps are open.
 *
 * Same logic as the web version (app.js):
 *  - level of each 64 ms frame in relative dB (0 = silence, ~100 = full scale)
 *  - clips: WAV files of sounds above the threshold, with pre-roll
 *  - optional whole-night recording as 10-minute AAC (.m4a) files
 *
 * Data per night lives in files/sleep/<sessionId>/ (session.json + audio files), in the same
 * JSON shape the web app uses, so the History screen can show it.
 */
public class SleepService extends Service {
    private static final String TAG = "SleepService";
    public static final String ACTION_START = "com.sleepmonitor.app.START";
    public static final String ACTION_STOP = "com.sleepmonitor.app.STOP";
    public static final String EXTRA_SETTINGS = "settings";
    private static final String CHANNEL = "sleep_monitor";
    private static final int NOTIF_ID = 42;

    static final int RATE = 16000;
    static final int FRAME = 1024;                       // 64 ms
    static final double FRAME_SEC = FRAME / (double) RATE;
    static final long SEGMENT_MS = 10 * 60 * 1000L;

    static volatile SleepService instance;

    private final Object lock = new Object();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile boolean running = false;
    private Thread worker;
    private PowerManager.WakeLock wakeLock;

    // ---- settings (may change while running)
    volatile double threshold = 60, preRoll = 3, postRoll = 4, maxClip = 60;
    volatile boolean recordAll = true;
    private JSONObject settingsJson = new JSONObject();

    // ---- session (guarded by lock)
    File dir;
    String sessionId;
    long start;
    private final ArrayList<Float> levels = new ArrayList<>();
    private final JSONArray clips = new JSONArray();
    private final JSONArray segments = new JSONArray();

    // ---- live state
    volatile double level = 0;
    volatile boolean clipActive = false;
    volatile long fullBytes = 0;

    // ---- processing state (worker thread only)
    private double secMax = 0;
    private long secSamples = 0, lastSave = 0, lastNotif = 0;
    private final ArrayDeque<short[]> preBuf = new ArrayDeque<>();
    private int preLen = 0;
    private ArrayList<short[]> clipChunks;
    private int clipLen = 0;
    private long clipStart = 0, clipLastLoud = 0;
    private double clipPeak = 0;
    private String clipTag = "loud";
    private AacWriter aac = null;

    static File rootDir(Context c) {
        File d = new File(c.getFilesDir(), "sleep");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            new Thread(this::stopMonitoring).start();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra(EXTRA_SETTINGS)) applySettings(intent.getStringExtra(EXTRA_SETTINGS));
        startInForeground();
        if (!running) startMonitoring();
        return START_NOT_STICKY;
    }

    // ------------------------------------------------------------------ settings
    void applySettings(String json) {
        try {
            JSONObject o = new JSONObject(json);
            threshold = o.optDouble("threshold", threshold);
            preRoll = o.optDouble("preRoll", preRoll);
            postRoll = o.optDouble("postRoll", postRoll);
            maxClip = o.optDouble("maxClip", maxClip);
            recordAll = o.optBoolean("recordAll", recordAll);
            synchronized (lock) {
                // the night keeps the threshold it was started with for its graph, but follows later changes
                settingsJson = o;
            }
        } catch (JSONException e) {
            Log.w(TAG, "bad settings", e);
        }
    }

    // ------------------------------------------------------------------ lifecycle
    private void startMonitoring() {
        long now = System.currentTimeMillis();
        synchronized (lock) {
            sessionId = "n" + now;
            start = now;
            dir = new File(rootDir(this), sessionId);
            dir.mkdirs();
            levels.clear();
            while (clips.length() > 0) clips.remove(0);
            while (segments.length() > 0) segments.remove(0);
        }
        level = 0; clipActive = false; fullBytes = 0;
        secMax = 0; secSamples = 0; lastSave = now; lastNotif = now;
        preBuf.clear(); preLen = 0; clipChunks = null; clipLen = 0;
        aac = null;

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepMonitor:monitor");
        wakeLock.acquire(16 * 60 * 60 * 1000L);

        running = true;
        saveSession();
        worker = new Thread(this::loop, "sleep-audio");
        worker.setPriority(Thread.MAX_PRIORITY);
        worker.start();
    }

    /** Stops monitoring, saves everything and ends the service. Returns the night's summary. */
    JSONObject stopMonitoring() {
        if (!running && worker == null) { stopSelf(); return null; }
        running = false;
        try { if (worker != null) worker.join(5000); } catch (InterruptedException ignored) { }
        worker = null;
        JSONObject summary = summary();
        io.shutdown();
        try { io.awaitTermination(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
        return summary;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        instance = null;
        super.onDestroy();
    }

    boolean isRunning() { return running; }

    // ------------------------------------------------------------------ audio loop
    private void loop() {
        int minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, FRAME * 2 * 16));
        } catch (SecurityException e) {
            Log.e(TAG, "no microphone permission", e);
            running = false;
            return;
        }
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord not initialized");
            rec.release();
            running = false;
            return;
        }
        rec.startRecording();
        short[] buf = new short[FRAME];
        try {
            while (running) {
                int n = rec.read(buf, 0, FRAME);
                if (n <= 0) { try { Thread.sleep(20); } catch (InterruptedException ignored) { } continue; }
                process(buf, n, System.currentTimeMillis());
            }
        } catch (Exception e) {
            Log.e(TAG, "audio loop failed", e);
        } finally {
            try { rec.stop(); } catch (Exception ignored) { }
            rec.release();
            if (clipChunks != null) finishClip();
            if (aac != null) finishSegment();
            saveSession();
        }
    }

    private void process(short[] buf, int n, long now) {
        double sum = 0;
        for (int i = 0; i < n; i++) { double v = buf[i] / 32768.0; sum += v * v; }
        double lv = Math.max(0, 20 * Math.log10(Math.sqrt(sum / n) + 1e-10) + 100);
        level = lv;

        synchronized (lock) {
            // per-second maximum, counted by audio received (a thread hiccup doesn't lose a second); if the audio
            // really stopped (microphone taken by a call, ...) and is > 3 s behind the clock, store the gap as 0
            secMax = Math.max(secMax, lv);
            secSamples += n;
            if (secSamples >= RATE) {
                levels.add(Math.round(secMax * 10) / 10f);
                secSamples -= RATE;
                secMax = 0;
                while (now - (start + levels.size() * 1000L) > 3000) levels.add(0f);
            }
        }

        short[] chunk = Arrays.copyOf(buf, n);
        handleClip(chunk, lv, now);
        handleFullRecording(chunk, now);

        if (now - lastSave > 30000) { lastSave = now; saveSession(); }
        if (now - lastNotif > 60000) { lastNotif = now; updateNotification(); }
    }

    // ---- threshold-triggered clip recording with pre-roll
    private void handleClip(short[] chunk, double lv, long now) {
        boolean loud = lv >= threshold;
        if (clipChunks != null) {
            clipChunks.add(chunk); clipLen += chunk.length;
            clipPeak = Math.max(clipPeak, lv);
            if (loud) clipLastLoud = now;
            double dur = clipLen / (double) RATE;
            if (now - clipLastLoud >= postRoll * 1000 || dur >= maxClip) finishClip();
        } else if (loud) {
            startClip(now, "loud");
            clipChunks.add(chunk); clipLen += chunk.length; clipPeak = lv;
        } else {
            preBuf.addLast(chunk); preLen += chunk.length;
            while (!preBuf.isEmpty() && preLen - preBuf.peekFirst().length >= preRoll * RATE) {
                preLen -= preBuf.removeFirst().length;
            }
        }
    }

    private void startClip(long now, String tag) {
        clipChunks = new ArrayList<>(preBuf);
        clipLen = preLen;
        clipStart = now - Math.round(preLen * 1000.0 / RATE);
        clipLastLoud = now; clipPeak = 0; clipTag = tag;
        preBuf.clear(); preLen = 0;
        clipActive = true;
    }

    private void finishClip() {
        final ArrayList<short[]> chunks = clipChunks;
        final int len = clipLen;
        clipChunks = null; clipLen = 0; clipActive = false;
        if (chunks == null || len == 0) return;
        String id = "c" + clipStart;
        final File f = new File(dir, "clip_" + clipStart + ".wav");
        try {
            JSONObject meta = new JSONObject();
            meta.put("id", id);
            meta.put("start", clipStart);
            meta.put("duration", Math.round(len * 10.0 / RATE) / 10.0);
            meta.put("peak", Math.round(clipPeak));
            meta.put("tag", clipTag);
            meta.put("file", f.getName());
            synchronized (lock) { clips.put(meta); }
        } catch (JSONException ignored) { }
        io.execute(() -> writeWav(f, chunks, len));
        saveSession();
    }

    private static void writeWav(File f, ArrayList<short[]> chunks, int len) {
        ByteBuffer b = ByteBuffer.allocate(44 + len * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + len * 2).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes()).putInt(len * 2);
        for (short[] c : chunks) for (short s : c) b.putShort(s);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(b.array());
        } catch (IOException e) {
            Log.e(TAG, "clip write failed", e);
        }
    }

    // ---- whole-night recording
    private void handleFullRecording(short[] chunk, long now) {
        if (recordAll && aac == null) {
            try {
                File f = new File(dir, "full_" + now + ".m4a");
                aac = new AacWriter(f, now - Math.round(chunk.length * 1000.0 / RATE));
            } catch (IOException e) {
                Log.e(TAG, "AAC encoder failed", e);
                recordAll = false;
                return;
            }
        } else if (!recordAll && aac != null) {
            finishSegment();
            return;
        }
        if (aac == null) return;
        aac.write(chunk, chunk.length);
        if (now - aac.startMs >= SEGMENT_MS) finishSegment(); // the next frame starts a new file
    }

    private void finishSegment() {
        AacWriter w = aac;
        aac = null;
        if (w == null) return;
        long size = w.finish();
        if (size <= 0) return;
        try {
            JSONObject meta = new JSONObject();
            meta.put("id", "g" + w.startMs);
            meta.put("start", w.startMs);
            meta.put("duration", Math.round(w.samples * 10.0 / RATE) / 10.0);
            meta.put("mime", "audio/mp4");
            meta.put("size", size);
            meta.put("file", w.file.getName());
            synchronized (lock) { segments.put(meta); }
        } catch (JSONException ignored) { }
        recalcFullBytes();
        saveSession();
    }

    private void recalcFullBytes() {
        long n = 0;
        synchronized (lock) { for (int i = 0; i < segments.length(); i++) n += segments.optJSONObject(i).optLong("size"); }
        fullBytes = n;
    }

    long currentFullBytes() {
        AacWriter w = aac;
        return fullBytes + (w != null ? w.file.length() : 0);
    }

    // ------------------------------------------------------------------ session data
    /** Full session JSON (same shape as the web app), including levels. */
    JSONObject snapshot(boolean withLevels) {
        JSONObject s = new JSONObject();
        synchronized (lock) {
            try {
                s.put("id", sessionId);
                s.put("start", start);
                s.put("end", System.currentTimeMillis());
                s.put("native", true);
                s.put("settings", new JSONObject(settingsJson.toString()));
                if (withLevels) {
                    JSONArray lv = new JSONArray();
                    for (Float f : levels) lv.put((double) f);
                    s.put("levels", lv);
                }
                s.put("events", new JSONArray()); // breathing pauses are no longer detected
                s.put("clips", new JSONArray(clips.toString()));
                s.put("segments", new JSONArray(segments.toString()));
            } catch (JSONException ignored) { }
        }
        return s;
    }

    JSONObject summary() {
        JSONObject s = new JSONObject();
        synchronized (lock) {
            try {
                s.put("id", sessionId);
                s.put("start", start);
                s.put("end", System.currentTimeMillis());
                s.put("clipCount", clips.length());
            } catch (JSONException ignored) { }
        }
        return s;
    }

    private void saveSession() {
        final JSONObject s = snapshot(true);
        final File d = dir;
        if (d == null || io.isShutdown()) return;
        io.execute(() -> {
            File tmp = new File(d, "session.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(s.toString().getBytes("UTF-8"));
            } catch (IOException e) {
                Log.e(TAG, "session save failed", e);
                return;
            }
            tmp.renameTo(new File(d, "session.json"));
        });
    }

    boolean removeClip(String clipId) {
        synchronized (lock) {
            for (int i = 0; i < clips.length(); i++) {
                JSONObject c = clips.optJSONObject(i);
                if (c != null && clipId.equals(c.optString("id"))) {
                    clips.remove(i);
                    new File(dir, c.optString("file")).delete();
                    break;
                }
            }
        }
        saveSession();
        return true;
    }

    /** Live status for the Monitor screen. */
    JSONObject status() {
        JSONObject o = new JSONObject();
        try {
            o.put("running", running);
            o.put("level", level);
            o.put("clipActive", clipActive);
            o.put("recordAll", recordAll);
            o.put("fullBytes", currentFullBytes());
            synchronized (lock) {
                o.put("sessionId", sessionId);
                o.put("start", start);
                o.put("clipCount", clips.length());
            }
        } catch (JSONException ignored) { }
        return o;
    }

    // ------------------------------------------------------------------ notification
    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Sleep monitoring", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while the microphone is monitoring your sleep");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, piFlags);
        Intent stop = new Intent(this, SleepService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);

        String text;
        synchronized (lock) {
            long el = (System.currentTimeMillis() - start) / 60000;
            text = start == 0 ? "Listening…" : String.format(Locale.US, "%d:%02d · %d loud sounds",
                    el / 60, el % 60, clips.length());
        }
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Monitoring your sleep")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openPi)
                .addAction(0, "Stop", stopPi)
                .build();
    }

    private void startInForeground() {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTIF_ID, n);
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        try { nm.notify(NOTIF_ID, buildNotification()); } catch (SecurityException ignored) { }
    }
}
