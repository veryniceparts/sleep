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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Foreground service that monitors sleep sounds with the screen off or while other apps are open.
 *
 * Same logic as the web version (app.js):
 *  - level of each 64 ms frame in relative dB (0 = silence, ~100 = full scale)
 *  - clips: WAV files of sounds above the threshold, with pre-roll
 *  - optional whole-night recording as 10-minute AAC (.m4a) files
 *  - sound recognition (YAMNet) while recording, stored as the night's "analysis" (see SoundRecognizer)
 *
 * Data per night lives in files/sleep/<sessionId>/ (session.json + audio files), in the same
 * JSON shape the web app uses, so the History screen can show it.
 *
 * Each night is a {@link Night} with its own state, file writer thread, recognizer, encoder and wake lock.
 * Stopping a night takes a few seconds (last clip and segment, final analysis, session.json); meanwhile the
 * night is "stopping" (see {@link #status}) and a new night can already be started, without the two mixing.
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
    private static final long AAC_RETRY_MS = 30_000;     // encoder failed: retry after 30 s, doubling up to SEGMENT_MS
    private static final int MAX_READ_ERRORS = 10;       // consecutive failed reads before the recorder is recreated
    private static final long MIC_RETRY_MAX_MS = 30_000;

    static volatile SleepService instance;
    /** Why the last night ended by itself (microphone unavailable, audio failure), or null. Cleared at start. */
    static volatile String lastError;

    private final Object svcLock = new Object();
    private Night active;                                  // the night being recorded (guarded by svcLock)
    private final ArrayList<Night> nights = new ArrayList<>(); // recording or still being saved (guarded by svcLock)
    private volatile Night latest;                         // most recent night
    private int lastStartId = 0;                           // guarded by svcLock

    // ---- settings (may change while running)
    volatile double threshold = 60, preRoll = 3, postRoll = 4, maxClip = 60;
    volatile boolean recordAll = true;
    private JSONObject settingsJson = new JSONObject();    // guarded by svcLock

    /** Id of the most recent night (recording, stopping or done). */
    volatile String sessionId;

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
        synchronized (svcLock) { lastStartId = startId; }
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            // detach the night right away (a Start that follows starts a new one), save it in the background
            final Night n = detachForStop();
            if (n != null) new Thread(n::stop, "sleep-stop").start();
            else stopIfIdle();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra(EXTRA_SETTINGS)) applySettings(intent.getStringExtra(EXTRA_SETTINGS));
        startInForeground();
        synchronized (svcLock) {
            if (active == null) startMonitoring();
        }
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
            synchronized (svcLock) {
                // the night keeps the threshold it was started with for its graph, but follows later changes
                settingsJson = o;
                if (active != null) active.setSettings(o);
            }
        } catch (JSONException e) {
            Log.w(TAG, "bad settings", e);
        }
    }

    // ------------------------------------------------------------------ lifecycle
    /** Call with svcLock held and no active night. */
    private void startMonitoring() {
        long now = System.currentTimeMillis();
        Night prev = latest;
        String id = "n" + now;
        if (prev != null && id.equals(prev.id)) { now++; id = "n" + now; }
        lastError = null;
        // recognise sounds while recording; if the model can't run here, the app analyses the night afterwards
        SoundRecognizer r = new SoundRecognizer(now, () -> YamnetModel.load(getAssets()));
        Night n = new Night(now, new File(rootDir(this), id), r, settingsJson, prev != null ? prev.micReleased : null);
        active = n;
        nights.add(n);
        latest = n;
        sessionId = n.id;
        n.begin();
    }

    /** Takes the night to stop: the active one, else the one that is already stopping. Marks it stopping. */
    private Night detachForStop() {
        synchronized (svcLock) {
            Night n = active;
            active = null;
            if (n == null && !nights.isEmpty()) n = nights.get(nights.size() - 1);
            if (n != null) n.requestStop();
            return n;
        }
    }

    /** Stops monitoring, saves everything and ends the service. Returns the night's summary. */
    JSONObject stopMonitoring() {
        Night n = detachForStop();
        if (n == null) { stopIfIdle(); return null; }
        return n.stop();
    }

    /** Ends the foreground state and the service if no night is recorded or being saved. */
    private void stopIfIdle() {
        synchronized (svcLock) {
            if (active != null || !nights.isEmpty()) return;
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
            stopSelf(lastStartId); // not if a Start arrived meanwhile
        }
    }

    private void nightDone(Night n) {
        synchronized (svcLock) {
            nights.remove(n);
            if (active == n) active = null;
        }
        stopIfIdle();
        boolean busy;
        synchronized (svcLock) { busy = active != null || !nights.isEmpty(); }
        if (busy) updateNotification();
    }

    @Override
    public void onDestroy() {
        Night n;
        synchronized (svcLock) {
            n = active;
            active = null;
            if (n != null) n.requestStop();
        }
        if (n != null) new Thread(n::stop, "sleep-stop").start(); // saves it; its wake lock is released when done
        instance = null;
        super.onDestroy();
    }

    /** Whether a night is being recorded or still being saved. */
    boolean isRunning() {
        synchronized (svcLock) { return active != null || !nights.isEmpty(); }
    }

    /** Whether a night is being recorded (not just saved). */
    boolean isRecording() {
        synchronized (svcLock) { return active != null; }
    }

    /** The night with this id while it is in memory (recording or being saved), else null. */
    private Night find(String id) {
        if (id == null) return null;
        synchronized (svcLock) {
            for (Night n : nights) if (id.equals(n.id)) return n;
        }
        return null;
    }

    /** Whether this night is recorded or being saved right now (its files are still being written). */
    boolean isLive(String id) { return find(id) != null; }

    /** Whether this night has been stopped and is still being saved. */
    boolean isStopping(String id) {
        Night n = find(id);
        return n != null && n.stopRequested;
    }

    /** Session JSON of a night in memory, or null if it isn't (anymore): then read its session.json. */
    JSONObject snapshot(String id, boolean withLevels) {
        Night n = find(id);
        return n != null ? n.snapshot(withLevels) : null;
    }

    /** Session JSON of the most recent night. */
    JSONObject snapshot(boolean withLevels) {
        Night n = latest;
        return n != null ? n.snapshot(withLevels) : new JSONObject();
    }

    /** Deletes a clip of a night in memory. False if the night isn't in memory (anymore): edit its files then. */
    boolean removeClip(String id, String clipId) {
        Night n = find(id);
        if (n == null) return false;
        n.removeClip(clipId);
        return true;
    }

    long currentFullBytes() {
        Night n = latest;
        return n != null ? n.currentFullBytes() : 0;
    }

    /**
     * Live status for the Monitor screen.
     *  running:    true while a night is recorded or still being saved
     *  stopping:   true when the reported night (sessionId) was stopped and its last files and final analysis
     *              are still being written; its session.json is final once stopping/running become false
     *  finalizing: ids of all nights still being saved (also when a new night is already recording)
     */
    JSONObject status() {
        Night n;
        JSONArray fin = new JSONArray();
        synchronized (svcLock) {
            n = active;
            if (n == null && !nights.isEmpty()) n = nights.get(nights.size() - 1);
            if (n == null) n = latest;
            for (Night x : nights) if (x.stopRequested) fin.put(x.id);
        }
        JSONObject o = new JSONObject();
        try {
            boolean live = n != null && !n.finished;
            boolean stopping = live && n.stopRequested;
            o.put("running", live);
            o.put("stopping", stopping);
            o.put("finalizing", fin);
            o.put("level", live && !stopping ? n.level : 0);
            o.put("clipActive", live && !stopping && n.clipActive);
            o.put("recordAll", recordAll);
            o.put("fullBytes", n != null ? n.currentFullBytes() : 0);
            if (!live && lastError != null) o.put("error", lastError);
            if (n != null) {
                SoundRecognizer r = n.recog;
                if (r != null) o.put("recognized", r.progress()); // windows classified so far (-1: unavailable)
                o.put("sessionId", n.id);
                o.put("start", n.start);
                o.put("clipCount", n.clipCount());
            }
        } catch (JSONException ignored) { }
        return o;
    }

    // ------------------------------------------------------------------ one night
    final class Night {
        final String id;
        final long start;
        final File dir;
        final SoundRecognizer recog;
        private final Object lock = new Object();
        private final ExecutorService io = Executors.newSingleThreadExecutor(); // file writes of this night
        private final CountDownLatch prevMic;          // released when the previous night's microphone is closed
        final CountDownLatch micReleased = new CountDownLatch(1);
        private final CountDownLatch finalized = new CountDownLatch(1);
        private final AtomicBoolean finalizing = new AtomicBoolean();
        private Thread worker;
        private PowerManager.WakeLock wakeLock;

        private volatile boolean running = true;   // the audio loop keeps going
        volatile boolean stopRequested = false;    // stopped (by the user or by an error), being saved
        volatile boolean finished = false;         // everything is written
        private volatile boolean micFailed = false;
        private volatile long endMs = 0;

        // ---- session data (guarded by lock)
        private final ArrayList<Float> levels = new ArrayList<>();
        private final JSONArray clips = new JSONArray();
        private final JSONArray segments = new JSONArray();
        private JSONObject settings;

        // ---- live state
        volatile double level = 0;
        volatile boolean clipActive = false;
        volatile long fullBytes = 0;
        private volatile AacWriter aac = null;

        // ---- processing state (worker thread only)
        private double secMax = 0;
        private long secSamples = 0, lastSave, lastNotif;
        private final ArrayDeque<short[]> preBuf = new ArrayDeque<>();
        private int preLen = 0;
        private ArrayList<short[]> clipChunks;
        private int clipLen = 0;
        private long clipStart = 0, clipLastLoud = 0;
        private double clipPeak = 0;
        private String clipTag = "loud";
        private long aacRetryAt = 0, aacBackoff = AAC_RETRY_MS;

        Night(long start, File dir, SoundRecognizer recog, JSONObject settings, CountDownLatch prevMic) {
            this.start = start;
            this.id = dir.getName();
            this.dir = dir;
            this.recog = recog;
            this.settings = settings;
            this.prevMic = prevMic;
            this.lastSave = start;
            this.lastNotif = start;
            dir.mkdirs();
        }

        void setSettings(JSONObject o) { synchronized (lock) { settings = o; } }

        void begin() {
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepMonitor:monitor");
                wakeLock.acquire(16 * 60 * 60 * 1000L);
            } catch (RuntimeException e) {
                Log.w(TAG, "no wake lock", e);
            }
            if (recog != null) recog.start();
            saveSession();
            worker = new Thread(this::loop, "sleep-audio");
            worker.setPriority(Thread.MAX_PRIORITY);
            worker.start();
        }

        void requestStop() {
            if (!stopRequested) endMs = System.currentTimeMillis();
            stopRequested = true;
            running = false;
        }

        /** Stops the night and waits until everything is saved. Returns its summary. Safe to call twice. */
        JSONObject stop() {
            requestStop();
            if (finalizing.compareAndSet(false, true)) finalizeNight();
            else {
                try { finalized.await(45, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            }
            return summary();
        }

        private void finalizeNight() {
            try {
                Thread w = worker;
                if (w != null && w != Thread.currentThread()) {
                    try { w.join(20000); } catch (InterruptedException ignored) { }
                    if (w.isAlive()) Log.w(TAG, "audio thread did not end in time");
                }
                io.shutdown(); // runs what the audio thread queued: last clip, last segment, final session.json
                try {
                    if (!io.awaitTermination(15, TimeUnit.SECONDS)) Log.w(TAG, "files not written in time");
                } catch (InterruptedException ignored) { }
                if (micFailed && levelCount() == 0) deleteRecursive(dir); // never recorded: no empty night
            } finally {
                try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (RuntimeException ignored) { }
                finished = true;
                finalized.countDown();
                nightDone(this);
            }
        }

        // -------------------------------------------------------------- audio loop
        private void loop() {
            AudioRecord rec = null;
            String error = null;
            try {
                if (prevMic != null) {
                    try { prevMic.await(2, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                }
                rec = openMic();
                if (rec == null) {
                    micFailed = true;
                    error = "microphone unavailable";
                    return;
                }
                short[] buf = new short[FRAME];
                int errors = 0;
                long retry = 1000;
                while (running) {
                    int n = rec.read(buf, 0, FRAME);
                    long now = System.currentTimeMillis();
                    if (n > 0) {
                        errors = 0;
                        retry = 1000;
                        process(buf, n, now);
                        continue;
                    }
                    noAudio(now);
                    if (++errors < MAX_READ_ERRORS) { pause(20); continue; }
                    // the recorder is dead (ERROR_DEAD_OBJECT after an audio server restart, ...): recreate it
                    Log.w(TAG, "microphone read failed " + errors + " times (" + n + "), reopening it");
                    closeMic(rec);
                    rec = null;
                    endContinuous(); // the audio has a gap: close the clip and the AAC file
                    while (running && rec == null) {
                        long until = System.currentTimeMillis() + retry;
                        while (running && System.currentTimeMillis() < until) { pause(200); noAudio(System.currentTimeMillis()); }
                        if (!running) break;
                        rec = openMic();
                        retry = Math.min(retry * 2, MIC_RETRY_MAX_MS);
                    }
                    errors = 0; // the delay grows until the reopened recorder delivers audio again
                }
            } catch (SecurityException e) {
                Log.e(TAG, "no microphone permission", e);
                micFailed = levelCount() == 0;
                error = "no microphone permission";
            } catch (Throwable e) {
                Log.e(TAG, "audio loop failed", e);
                error = "recording failed: " + e;
            } finally {
                closeMic(rec);
                micReleased.countDown();
                try { if (clipChunks != null) finishClip(); } catch (Throwable e) { Log.e(TAG, "last clip failed", e); }
                try { finishSegment(); } catch (Throwable e) { Log.e(TAG, "last segment failed", e); }
                try {
                    if (recog != null) recog.finish(8000); // classify what is still queued, then the analysis is final
                } catch (Throwable e) { Log.e(TAG, "recognizer finish failed", e); }
                saveSession();
                if (!stopRequested) {
                    // ended by itself: stop the night and the service, so the app's status shows it
                    lastError = error != null ? error : "recording ended unexpectedly";
                    Log.e(TAG, "night ended by itself: " + lastError);
                    synchronized (svcLock) {
                        if (active == this) active = null;
                        requestStop();
                    }
                    if (finalizing.compareAndSet(false, true)) finalizeNight(); // never waits for itself
                }
            }
        }

        private AudioRecord openMic() {
            AudioRecord r = null;
            try {
                int minBuf = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                r = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, FRAME * 2 * 16));
                if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                    Log.e(TAG, "AudioRecord not initialized");
                    closeMic(r);
                    return null;
                }
                r.startRecording();
                return r;
            } catch (SecurityException e) {
                closeMic(r);
                throw e;
            } catch (RuntimeException e) {
                Log.e(TAG, "could not open the microphone", e);
                closeMic(r);
                return null;
            }
        }

        private void closeMic(AudioRecord r) {
            if (r == null) return;
            try { r.stop(); } catch (Exception ignored) { }
            try { r.release(); } catch (Exception ignored) { }
        }

        private void pause(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

        private void process(short[] buf, int n, long now) {
            double sum = 0;
            for (int i = 0; i < n; i++) { double v = buf[i] / 32768.0; sum += v * v; }
            double lv = Math.max(0, 20 * Math.log10(Math.sqrt(sum / n) + 1e-10) + 100);
            level = lv;
            SoundRecognizer r = recog;
            double t;

            synchronized (lock) {
                t = start + levels.size() * 1000.0 + secSamples * 1000.0 / RATE; // time of buf[0] on the levels timeline
                // per-second maximum, counted by audio received (a thread hiccup doesn't lose a second); if the audio
                // really stopped (microphone taken by a call, ...) and is > 3 s behind the clock, store the gap as 0
                secMax = Math.max(secMax, lv);
                secSamples += n;
                if (secSamples >= RATE) {
                    float sec = Math.round(secMax * 10) / 10f;
                    levels.add(sec);
                    if (r != null) r.second(sec);
                    secSamples -= RATE;
                    secMax = 0;
                    fillGap(now, r);
                }
            }
            if (r != null) r.feed(buf, n, t, lv);

            short[] chunk = Arrays.copyOf(buf, n);
            handleClip(chunk, lv, now);
            handleFullRecording(chunk, now);

            if (now - lastSave > 30000) { lastSave = now; saveSession(); }
            if (now - lastNotif > 60000) { lastNotif = now; updateNotification(); }
        }

        /** Stores seconds without audio as 0 while the timeline is > 3 s behind the clock. Call with lock held. */
        private void fillGap(long now, SoundRecognizer r) {
            while (now - (start + levels.size() * 1000L) > 3000) {
                levels.add(0f);
                if (r != null) r.second(0f);
            }
        }

        /** No audio came (read error, recorder being reopened): keep the levels timeline in step with the clock. */
        private void noAudio(long now) {
            SoundRecognizer r = recog;
            synchronized (lock) {
                // the second in progress would have ended > 3 s ago: close it, then fill the gap with 0
                if (now - (start + (levels.size() + 1) * 1000L) <= 3000) return;
                float sec = secSamples > 0 ? Math.round(secMax * 10) / 10f : 0f;
                levels.add(sec);
                if (r != null) r.second(sec);
                secSamples = 0;
                secMax = 0;
                fillGap(now, r);
            }
            level = 0;
            if (now - lastSave > 30000) { lastSave = now; saveSession(); }
            if (now - lastNotif > 60000) { lastNotif = now; updateNotification(); }
        }

        /** The audio is interrupted: end the clip and the AAC file (they must not span the gap). */
        private void endContinuous() {
            if (clipChunks != null) finishClip();
            preBuf.clear(); preLen = 0;
            finishSegment();
        }

        private int levelCount() { synchronized (lock) { return levels.size(); } }

        int clipCount() { synchronized (lock) { return clips.length(); } }

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
                startClip(now, "loud", chunk.length);
                clipChunks.add(chunk); clipLen += chunk.length; clipPeak = lv;
            } else {
                preBuf.addLast(chunk); preLen += chunk.length;
                while (!preBuf.isEmpty() && preLen - preBuf.peekFirst().length >= preRoll * RATE) {
                    preLen -= preBuf.removeFirst().length;
                }
            }
        }

        /** now = time the current buffer (of bufLen samples, not yet in the clip) was read, i.e. its end. */
        private void startClip(long now, String tag, int bufLen) {
            clipChunks = new ArrayList<>(preBuf);
            clipLen = preLen;
            clipStart = now - Math.round((preLen + bufLen) * 1000.0 / RATE);
            clipLastLoud = now; clipPeak = 0; clipTag = tag;
            preBuf.clear(); preLen = 0;
            clipActive = true;
        }

        private void finishClip() {
            final ArrayList<short[]> chunks = clipChunks;
            final int len = clipLen;
            clipChunks = null; clipLen = 0; clipActive = false;
            if (chunks == null || len == 0) return;
            final String cid = "c" + clipStart;
            final File f = new File(dir, "clip_" + clipStart + ".wav");
            try {
                JSONObject meta = new JSONObject();
                meta.put("id", cid);
                meta.put("start", clipStart);
                meta.put("duration", Math.round(len * 10.0 / RATE) / 10.0);
                meta.put("peak", Math.round(clipPeak));
                meta.put("tag", clipTag);
                meta.put("file", f.getName());
                synchronized (lock) { clips.put(meta); }
            } catch (JSONException ignored) { }
            run(() -> {
                if (!hasClip(cid)) return; // deleted before it was written
                if (!writeWav(f, chunks, len)) {
                    // no file: don't list it (the History screen would point to a missing file)
                    f.delete();
                    dropClip(cid);
                    writeSessionFile();
                }
            });
            saveSession();
        }

        private boolean hasClip(String cid) {
            synchronized (lock) {
                for (int i = 0; i < clips.length(); i++) {
                    JSONObject c = clips.optJSONObject(i);
                    if (c != null && cid.equals(c.optString("id"))) return true;
                }
            }
            return false;
        }

        /** Removes a clip from the list. Returns its file name, or null if it isn't listed. */
        private String dropClip(String cid) {
            synchronized (lock) {
                for (int i = 0; i < clips.length(); i++) {
                    JSONObject c = clips.optJSONObject(i);
                    if (c != null && cid.equals(c.optString("id"))) {
                        clips.remove(i);
                        return c.optString("file");
                    }
                }
            }
            return null;
        }

        void removeClip(String clipId) {
            String file = dropClip(clipId);
            final File f = file != null && !file.isEmpty() ? new File(dir, file) : null;
            Runnable del = () -> {
                if (f != null) f.delete();
                writeSessionFile();
            };
            // on the file thread, so it runs after a still queued write of that clip (which then sees it's gone)
            if (!run(del)) {
                // the night is being saved and its file thread is closing: wait for it, then delete
                try { io.awaitTermination(20, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
                del.run();
            }
        }

        // ---- whole-night recording
        private void handleFullRecording(short[] chunk, long now) {
            if (!recordAll) {
                if (aac != null) finishSegment();
                return;
            }
            if (aac == null) {
                if (now < aacRetryAt) return;
                try {
                    File f = new File(dir, "full_" + now + ".m4a");
                    aac = new AacWriter(f, now - Math.round(chunk.length * 1000.0 / RATE));
                } catch (IOException | RuntimeException e) {
                    aacFailed("AAC encoder could not start", e, now);
                    return;
                }
            }
            try {
                aac.write(chunk, chunk.length);
            } catch (RuntimeException e) { // MediaCodec.CodecException, IllegalStateException, ...
                aacFailed("AAC encoder failed", e, now);
                return;
            }
            if (now - aac.startMs >= SEGMENT_MS) { // the next frame starts a new file
                finishSegment();
                aacBackoff = AAC_RETRY_MS;
            }
        }

        /** The encoder failed: keep what it wrote, continue with clips only and try again later. */
        private void aacFailed(String what, Exception e, long now) {
            Log.e(TAG, what + ", recording continues with clips only, retry in " + aacBackoff / 1000 + " s", e);
            finishSegment();
            aacRetryAt = now + aacBackoff;
            aacBackoff = Math.min(aacBackoff * 2, SEGMENT_MS);
        }

        /** Closes the current AAC file on the file thread (finishing it can take a while), the next one starts now. */
        private void finishSegment() {
            final AacWriter w = aac;
            aac = null;
            if (w == null) return;
            Runnable close = () -> {
                long size;
                try {
                    size = w.finish();
                } catch (RuntimeException e) {
                    Log.e(TAG, "AAC file could not be finished", e);
                    w.file.delete();
                    size = 0;
                }
                if (size > 0) {
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
                }
                recalcFullBytes();
                writeSessionFile();
            };
            if (!run(close)) close.run();
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

        // -------------------------------------------------------------- session data
        /** Full session JSON (same shape as the web app), including levels. */
        JSONObject snapshot(boolean withLevels) {
            JSONObject s = new JSONObject();
            SoundRecognizer r = recog;
            JSONObject analysis = r != null ? r.toJson() : null; // outside our lock (the recognizer has its own)
            synchronized (lock) {
                try {
                    s.put("id", id);
                    s.put("start", start);
                    s.put("end", stopRequested ? endMs : System.currentTimeMillis());
                    s.put("native", true);
                    s.put("settings", new JSONObject(settings.toString()));
                    if (withLevels) {
                        JSONArray lv = new JSONArray();
                        for (Float f : levels) lv.put(Math.round(f * 10) / 10.0); // 86.4, not 86.4000015258789
                        s.put("levels", lv);
                    }
                    s.put("events", new JSONArray()); // breathing pauses are no longer detected
                    s.put("clips", new JSONArray(clips.toString()));
                    s.put("segments", new JSONArray(segments.toString()));
                    if (analysis != null) s.put("analysis", analysis);
                } catch (JSONException ignored) { }
            }
            return s;
        }

        JSONObject summary() {
            JSONObject s = new JSONObject();
            synchronized (lock) {
                try {
                    s.put("id", id);
                    s.put("start", start);
                    s.put("end", stopRequested ? endMs : System.currentTimeMillis());
                    s.put("clipCount", clips.length());
                } catch (JSONException ignored) { }
            }
            return s;
        }

        /** Runs a task on this night's file thread. False if that thread no longer takes tasks. */
        private boolean run(Runnable task) {
            try {
                io.execute(task);
                return true;
            } catch (RejectedExecutionException e) {
                return false;
            }
        }

        /** Writes session.json on the file thread, with the data as it is then (after queued clip/segment work). */
        private void saveSession() { run(this::writeSessionFile); }

        /** Writes session.json now. File thread only (or after it ended). */
        private void writeSessionFile() {
            if (!dir.isDirectory()) return;
            JSONObject s = snapshot(true);
            File tmp = new File(dir, "session.json.tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(s.toString().getBytes("UTF-8"));
            } catch (IOException e) {
                Log.e(TAG, "session save failed", e);
                return;
            }
            tmp.renameTo(new File(dir, "session.json"));
        }
    }

    private static boolean writeWav(File f, ArrayList<short[]> chunks, int len) {
        ByteBuffer b = ByteBuffer.allocate(44 + len * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + len * 2).put("WAVE".getBytes());
        b.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes()).putInt(len * 2);
        for (short[] c : chunks) for (short s : c) b.putShort(s);
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(b.array());
            return true;
        } catch (IOException e) {
            Log.e(TAG, "clip write failed", e);
            return false;
        }
    }

    private static void deleteRecursive(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
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

        Night n;
        boolean saving;
        synchronized (svcLock) {
            n = active;
            saving = n == null && !nights.isEmpty();
        }
        String text;
        if (n != null) {
            long el = (System.currentTimeMillis() - n.start) / 60000;
            text = String.format(Locale.US, "%d:%02d · %d loud sounds", el / 60, el % 60, n.clipCount());
        } else text = saving ? "Saving the night…" : "Listening…";
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
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.notify(NOTIF_ID, buildNotification());
        } catch (RuntimeException ignored) { } // SecurityException (no permission), ...
    }
}
