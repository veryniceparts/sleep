package com.sleepmonitor.app;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;

/**
 * Recognises sounds while the night is being recorded, with the same model (YAMNet) and the same rules as
 * the JavaScript analysis after a night (app.js: activeSpans, pickCategory, mergeRuns), so a native night
 * already has its "analysis" when it ends and the app doesn't have to analyse it again.
 *
 * The audio thread only copies samples into 0.975 s windows ({@link #feed}) and reports the level of each
 * second ({@link #second}). A low-priority thread loads the model, skips windows that are only room
 * background, classifies the rest and merges the labels into runs. If the model can't be loaded, the
 * recognizer switches itself off and the night is analysed by the app afterwards, as before.
 */
final class SoundRecognizer {
    private static final String TAG = "SoundRecognizer";
    static final int VERSION = 2;                 // ANALYSIS_VERSION in app.js
    static final int WIN = 15600;                 // YAMNet input: 0.975 s at 16 kHz
    static final double WIN_MS = WIN * 1000.0 / SleepService.RATE;
    private static final int MAX_QUEUE = 96;      // ~1.5 min of audio (3 MB) waiting for the classifier
    // which seconds are worth classifying (activeSpans in app.js): above background + GATE_DB, +- PAD_S
    private static final double GATE_DB = 2;
    private static final int PAD_S = 2;
    private static final int GATE_HISTORY_S = 600; // background = 10th percentile of the last 10 minutes
    private static final int GATE_MIN_S = 60;      // levels needed for a background estimate (the first minute
                                                   // waits for it, then uses it)
    // like the app's MediaPipe AudioClassifier options (maxResults: 8, scoreThreshold: 0.05)
    private static final int MAX_RESULTS = 8;
    private static final float SCORE_THRESHOLD = 0.05f;

    // our categories (CATS / CAT_ORDER / CAT_WEIGHT in app.js; 'other' has no pattern)
    static final String[] CAT_ORDER = { "snore", "gasp", "cough", "talk", "breath", "move", "other" };
    // exact YAMNet label names per category, in CAT_ORDER (same lists as CATS[k].labels in app.js)
    private static java.util.Set<String> set(String... names) { return new java.util.HashSet<>(java.util.Arrays.asList(names)); }
    private static final java.util.List<java.util.Set<String>> CAT_LABELS = java.util.Arrays.asList(
            set("Snoring", "Snort"),
            set("Gasp", "Wheeze", "Pant"),
            set("Cough", "Throat clearing", "Sneeze", "Sniff", "Hiccup"),
            set("Speech", "Child speech, kid speaking", "Conversation", "Narration, monologue", "Babbling", "Whispering", "Shout", "Yell", "Laughter", "Crying, sobbing", "Whimper", "Wail, moan", "Groan", "Grunt", "Singing", "Humming", "Hubbub, speech noise, speech babble"),
            set("Breathing", "Sigh"),
            set("Rustle", "Rustling leaves", "Shuffle", "Walk, footsteps", "Door", "Sliding door", "Knock", "Slam", "Tap", "Thump, thud", "Bang", "Creak", "Squeak", "Zipper (clothing)", "Scratch", "Rub", "Clatter", "Writing"),
            null // other: any label that isn't Silence and scores >= 0.3
    );
    private static final double[] CAT_WEIGHT = { 1.4, 1.5, 1.3, 1.1, 1, 1, 1 };
    private static final int OTHER = 6;

    /** The classifier: one window of {@link #WIN} samples in [-1, 1] -> one score per label. */
    interface Model {
        String[] labels();
        float[] classify(float[] window) throws Exception;
        void close();
    }

    interface Loader { Model load() throws Exception; }

    private static final class Win {
        final short[] pcm; final int len; final double t; final double peak;
        Win(short[] pcm, int len, double t, double peak) { this.pcm = pcm; this.len = len; this.t = t; this.peak = peak; }
    }

    /** One classified window, as chosen by pickCategory. */
    static final class Pick {
        final int c; final double p; final String l;
        Pick(int c, double p, String l) { this.c = c; this.p = p; this.l = l; }
    }

    private static final class Run {
        double s, e, p; final int c; String l; int n = 1;
        Run(double s, double e, int c, double p, String l) { this.s = s; this.e = e; this.c = c; this.p = p; this.l = l; }
    }

    private final long start;
    private final Loader loader;
    private final Object lock = new Object();
    private Thread thread;

    // ---- audio thread only
    private short[] cur;
    private int curLen;
    private double curT, curPeak, expectT = Double.NaN;

    // ---- shared, guarded by lock
    private final ArrayDeque<Win> queue = new ArrayDeque<>();
    private final ArrayDeque<short[]> pool = new ArrayDeque<>();
    private float[] secLevel = new float[1024];   // per second since start: its level
    private float[] secGate = new float[1024];    // and the gate (background + GATE_DB) at that time
    private int firstGate = -1;                   // first second with a background estimate
    private int seconds = 0;
    private final float[] recent = new float[GATE_HISTORY_S];
    private int recentN = 0, recentPos = 0;
    private final int[] hist = new int[1201];      // recent levels in 0.1 dB steps
    private double gate = Double.NEGATIVE_INFINITY;
    private boolean finishing = false, abort = false;
    private final ArrayList<Run> runs = new ArrayList<>();

    // ---- state for status / logs
    volatile boolean ready = false, failed = false, done = false;
    volatile int classified = 0, skipped = 0, dropped = 0;
    /** Some audio was not classified (queue overflow, finish timed out, classifier error): stays "partial". */
    volatile boolean incomplete = false;

    SoundRecognizer(long start, Loader loader) {
        this.start = start;
        this.loader = loader;
    }

    void start() {
        thread = new Thread(this::work, "sleep-recognizer");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.start();
    }

    // ------------------------------------------------------------------ audio thread
    /**
     * Adds audio. t = time of buf[0] in ms on the night's timeline (start + seconds of audio received, plus
     * gaps); lv = level of this frame in dB. Never blocks for long: only copies samples.
     */
    void feed(short[] buf, int n, double t, double lv) {
        if (failed || done) return;
        // the audio jumped (microphone taken away, ...): start a new window where it continues
        if (cur != null && Math.abs(t - expectT) > 50) cur = null;
        int i = 0;
        while (i < n) {
            if (cur == null) {
                synchronized (lock) { cur = pool.pollFirst(); }
                if (cur == null) cur = new short[WIN];
                curLen = 0;
                curT = t + i * 1000.0 / SleepService.RATE;
                curPeak = 0;
            }
            int k = Math.min(n - i, WIN - curLen);
            System.arraycopy(buf, i, cur, curLen, k);
            curLen += k;
            i += k;
            curPeak = Math.max(curPeak, lv);
            if (curLen == WIN) { enqueue(new Win(cur, WIN, curT, curPeak)); cur = null; }
        }
        expectT = t + n * 1000.0 / SleepService.RATE;
    }

    /** Level of the next second of the night (as stored in the session's levels; 0 = no audio). */
    void second(float lv) {
        synchronized (lock) {
            if (lv > 0) {
                if (recentN == GATE_HISTORY_S) hist[bin(recent[recentPos])]--; else recentN++;
                recent[recentPos] = lv;
                recentPos = (recentPos + 1) % GATE_HISTORY_S;
                hist[bin(lv)]++;
                gate = recentN >= GATE_MIN_S ? percentile10() + GATE_DB : Double.NEGATIVE_INFINITY;
            }
            if (seconds == secLevel.length) {
                secLevel = java.util.Arrays.copyOf(secLevel, seconds * 2);
                secGate = java.util.Arrays.copyOf(secGate, seconds * 2);
            }
            if (firstGate < 0 && gate > Double.NEGATIVE_INFINITY) firstGate = seconds;
            secLevel[seconds] = lv;
            secGate[seconds] = (float) gate;
            seconds++;
            lock.notifyAll();
        }
    }

    private static int bin(float lv) { return Math.max(0, Math.min(1200, Math.round(lv * 10))); }

    /** 10th percentile of the recent levels (vals[floor(n * 0.1)] of the sorted values, as in activeSpans). */
    private double percentile10() {
        int rank = (int) Math.floor(recentN * 0.1), seen = 0;
        for (int b = 0; b < hist.length; b++) {
            seen += hist[b];
            if (seen > rank) return b / 10f; // levels are stored rounded to 0.1 dB, so this is the exact value
        }
        return 0;
    }

    private void enqueue(Win w) {
        synchronized (lock) {
            if (queue.size() >= MAX_QUEUE) {
                // the classifier is behind: drop the oldest window that sounds like background, else the oldest
                Win drop = null;
                for (Win q : queue) if (q.peak < gate) { drop = q; break; }
                if (drop == null) drop = queue.peekFirst();
                queue.remove(drop);
                pool.addLast(drop.pcm);
                incomplete = true;
                if (dropped++ % 100 == 0) {
                    Log.w(TAG, "recognition is behind, dropped " + dropped + " windows (last at "
                            + Math.round(drop.t - start) + " ms, " + (drop.peak < gate ? "background" : "not background") + ")");
                }
            }
            queue.addLast(w);
            lock.notifyAll();
        }
    }

    /**
     * End of the night (call from the audio thread after the last feed): classifies the last part and what
     * is still queued, waiting at most timeoutMs. Afterwards {@link #toJson} gives the final result.
     */
    void finish(long timeoutMs) {
        if (!failed && cur != null && curLen >= WIN / 2) {
            // last part of the night: zero-padded like MediaPipe does with the end of a recording
            java.util.Arrays.fill(cur, curLen, WIN, (short) 0);
            enqueue(new Win(cur, curLen, curT, curPeak));
        }
        cur = null;
        synchronized (lock) { finishing = true; lock.notifyAll(); }
        Thread th = thread;
        if (th != null) {
            try { th.join(timeoutMs); } catch (InterruptedException ignored) { }
            if (th.isAlive()) {
                synchronized (lock) {
                    Log.w(TAG, "recognition not finished in time, " + queue.size() + " windows left out");
                    abort = true;
                    incomplete = true;
                    queue.clear();
                    lock.notifyAll();
                }
            }
        }
        done = true;
        Log.i(TAG, "night recognised: " + classified + " windows classified, " + skipped + " background skipped, "
                + dropped + " dropped, " + runs.size() + " runs");
    }

    // ------------------------------------------------------------------ classifier thread
    private void work() {
        try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); } catch (Throwable ignored) { }
        Model model;
        int[] labelCat;
        String[] labels;
        try {
            model = loader.load();
            labels = model.labels();
            labelCat = categorize(labels);
        } catch (Throwable e) { // missing model, native library not loadable on this phone, ...
            Log.w(TAG, "sound recognition unavailable, the app will analyse the night afterwards", e);
            failed = true;
            synchronized (lock) { queue.clear(); pool.clear(); }
            return;
        }
        ready = true;
        float[] in = new float[WIN];
        try {
            while (true) {
                Win w;
                boolean active;
                synchronized (lock) {
                    while (true) {
                        if (abort) return;
                        w = queue.peekFirst();
                        if (w == null) {
                            if (finishing) return;
                        } else {
                            // seconds needed to decide: up to PAD_S + 1 (gap filling) after the window
                            // (and, in the first minute, the first background estimate)
                            int need = (int) Math.ceil((w.t + WIN_MS - start) / 1000) + PAD_S + 1;
                            if ((seconds >= need && (firstGate >= 0 || seconds >= GATE_MIN_S)) || finishing) break;
                        }
                        try { lock.wait(); } catch (InterruptedException e) { return; }
                    }
                    queue.removeFirst();
                    active = isActive(w);
                    if (!active) { pool.addLast(w.pcm); skipped++; continue; }
                }
                for (int i = 0; i < WIN; i++) in[i] = w.pcm[i] / 32768f;
                synchronized (lock) { pool.addLast(w.pcm); }
                float[] scores;
                try {
                    scores = model.classify(in);
                } catch (Exception e) {
                    Log.w(TAG, "classification failed", e);
                    incomplete = true;
                    continue;
                }
                Pick pick = pickCategory(scores, labels, labelCat);
                synchronized (lock) {
                    if (pick != null) addWindow(w.t, WIN_MS, pick);
                    classified++;
                }
            }
        } finally {
            try { model.close(); } catch (Throwable ignored) { }
        }
    }

    /** Whether a window touches a second that activeSpans in app.js would analyse. Call with lock held. */
    private boolean isActive(Win w) {
        double r0 = w.t - start, r1 = r0 + w.len * 1000.0 / SleepService.RATE;
        int a = (int) Math.floor(r0 / 1000), b = (int) Math.ceil(r1 / 1000);
        for (int s = a; s < b; s++) {
            // a loud second i covers seconds i-2 .. i+2; spans 1 s apart are joined (loud i-3 and i+3 cover i)
            for (int i = s - PAD_S; i <= s + PAD_S; i++) if (isLoud(i)) return true;
            if (isLoud(s - PAD_S - 1) && isLoud(s + PAD_S + 1)) return true;
        }
        return false;
    }

    private boolean isLoud(int i) {
        if (i < 0) return false;
        if (i >= seconds) return false; // after the last full second (end of the night): no level, as in the app
        float lv = secLevel[i];
        // before the first background estimate, the first estimate is used; without one, everything counts
        // (activeSpans: a night with less than a minute of levels is analysed completely)
        double g = firstGate < 0 ? Double.NEGATIVE_INFINITY : secGate[Math.max(i, firstGate)];
        // same test as activeSpans: no level data (0) is classified to be safe
        return !(lv > 0 && lv < g);
    }

    static int[] categorize(String[] labels) {
        int[] out = new int[labels.length];
        for (int i = 0; i < labels.length; i++) {
            out[i] = -1;
            for (int k = 0; k < CAT_LABELS.size(); k++) {
                if (CAT_LABELS.get(k) != null && CAT_LABELS.get(k).contains(labels[i])) { out[i] = k; break; }
            }
        }
        return out;
    }

    /**
     * pickCategory in app.js, applied to MediaPipe's result for the window: the 8 best labels with
     * score >= 0.05, best first (equal scores: lower label index first).
     */
    static Pick pickCategory(float[] scores, String[] labels, int[] labelCat) {
        int[] top = new int[MAX_RESULTS];
        int n = 0;
        for (int i = 0; i < scores.length && i < labels.length; i++) {
            float s = scores[i];
            if (!(s >= SCORE_THRESHOLD)) continue;
            if (n == MAX_RESULTS && s <= scores[top[n - 1]]) continue;
            int j = n < MAX_RESULTS ? n++ : n - 1;
            while (j > 0 && scores[top[j - 1]] < s) { top[j] = top[j - 1]; j--; }
            top[j] = i;
        }
        if (n == 0) return null;
        String topName = labels[top[0]];
        if ("Silence".equals(topName) && scores[top[0]] > 0.5) return null;
        Pick best = null;
        double bestW = 0;
        for (int k = 0; k < n; k++) {
            int i = top[k];
            double s = scores[i];
            if (s < 0.1) continue;
            int c = labelCat[i];
            if (c < 0) continue;
            double w = s * CAT_WEIGHT[c];
            if (best == null || w > bestW) { best = new Pick(c, s, labels[i]); bestW = w; }
        }
        if (best != null) return best;
        if (!"Silence".equals(topName) && scores[top[0]] >= 0.3) return new Pick(OTHER, scores[top[0]], topName);
        return null;
    }

    /** mergeRuns in app.js, incrementally (windows arrive in time order). Call with lock held. */
    private void addWindow(double t, double d, Pick w) {
        Run last = runs.isEmpty() ? null : runs.get(runs.size() - 1);
        if (last != null && last.c == w.c && t - last.e <= 1500) {
            last.e = t + d;
            last.n++;
            if (w.p > last.p) { last.p = w.p; last.l = w.l; }
        } else runs.add(new Run(t, t + d, w.c, w.p, w.l));
    }

    /**
     * The night's "analysis" in the app's format ({ v, at, runs: [{ s, e, c, p, l }] }), or null while the
     * model isn't loaded or if recognition is unavailable. "partial" is set while the night is recorded,
     * so a night whose recording was cut off (app killed) is still analysed by the app afterwards, and stays
     * set when some audio was not classified (windows dropped, finish timed out), so the app analyses it again.
     */
    JSONObject toJson() {
        if (!ready || failed) return null;
        JSONObject o = new JSONObject();
        try {
            JSONArray arr = new JSONArray();
            synchronized (lock) {
                for (Run r : runs) {
                    // drop single uncertain seconds of background-ish sounds
                    if (!(r.n > 1 || r.p >= 0.3 || r.c <= 2)) continue; // 0..2 = snore, gasp, cough
                    JSONObject j = new JSONObject();
                    j.put("s", Math.round(r.s));
                    j.put("e", Math.round(r.e));
                    j.put("c", CAT_ORDER[r.c]);
                    j.put("p", Math.round(r.p * 100) / 100.0);
                    j.put("l", r.l);
                    arr.put(j);
                }
            }
            o.put("v", VERSION);
            o.put("at", System.currentTimeMillis());
            if (!done || incomplete) o.put("partial", true);
            o.put("runs", arr);
        } catch (JSONException e) {
            return null;
        }
        return o;
    }

    /** Number of windows classified so far (for the live status), or -1 if recognition is off. */
    int progress() { return failed ? -1 : classified; }
}
