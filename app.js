'use strict';
/*
 * Sleep Monitor
 * - Live sound level (relative dB) as soon as the app opens.
 * - Records the whole night (compressed, 10-minute files) plus a WAV clip of every sound above the threshold.
 * - After the night, recognises sounds (snoring, cough, talking, ...) on the phone with YAMNet.
 * - Browser: everything in IndexedDB. Android app: a native background service records (see android/).
 */

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  threshold: 60,     // dB (relative) above which clips are saved
  preRoll: 3,        // s of audio kept before the trigger
  postRoll: 4,       // s of quiet before a clip ends
  maxClip: 60,       // s max clip length
  maxGap: 600,       // s: snores at most this far apart belong to the same snoring session
  recordAll: true,   // record the whole night (compressed)
};
const CLIP_RATE = 16000;     // saved audio sample rate (Hz)
const LIVE_SECONDS = 60;     // live chart window (s)
const SEGMENT_MS = 10 * 60 * 1000; // whole-night recording is saved in 10-minute files
const FULL_BITRATE = 32000;  // bits/s for whole-night recording (~14 MB per hour)

// best compressed format this browser can record (webm/opus on Chrome/Android, mp4/aac on Safari)
const FULL_MIME = (() => {
  if (!window.MediaRecorder) return null;
  const opts = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  return opts.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
})();
const fmtMB = (bytes) => { const mb = bytes / 1e6; return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`; };
const extFor = (mime) => (/mp4|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm');
// Running inside the Android app (Capacitor) rather than a browser?
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const plugin = (name) => (NATIVE && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null);
// Android app: a native background service records, so monitoring continues with the screen off / in other apps
const SR = plugin('SleepRecorder');
const USE_NATIVE = !!SR;
const FULL_OK = USE_NATIVE || FULL_MIME !== null; // whole-night recording available

let settings = loadSettings();
function loadSettings() {
  let st;
  try { st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sleepmon.settings') || '{}') }; }
  catch { st = { ...DEFAULTS }; }
  st.recordAll = true; // the whole night is always recorded (needed for replay and sound recognition)
  return st;
}
function saveSettings() {
  try { localStorage.setItem('sleepmon.settings', JSON.stringify(settings)); } catch {}
  if (typeof openViews !== 'undefined') openViews.forEach((v) => { v.recalc(); v.rowMark = null; if (v.onDataChanged) v.onDataChanged(); v.requestDraw(); });
  if (USE_NATIVE && NativeMonitor.running) SR.update({ settings: { ...settings } }).catch(() => {});
}

// ---------------------------------------------------------------- storage (IndexedDB)
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('sleepmon', 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('sessions', { keyPath: 'id' });
          const clips = db.createObjectStore('clips', { keyPath: 'id' });
          clips.createIndex('sessionId', 'sessionId');
        }
        if (e.oldVersion < 2) {
          const segs = db.createObjectStore('segments', { keyPath: 'id' });
          segs.createIndex('sessionId', 'sessionId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const p = Promise.resolve(fn(s));
      t.oncomplete = () => p.then(resolve, reject);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    putSession: (s) => tx('sessions', 'readwrite', (st) => { st.put(s); }),
    putClip: (c) => tx('clips', 'readwrite', (st) => { st.put(c); }),
    getSessions: () => tx('sessions', 'readonly', (st) => reqP(st.getAll())),
    getClips: (sessionId) => tx('clips', 'readonly', (st) => reqP(st.index('sessionId').getAll(sessionId))),
    deleteClip: (id) => tx('clips', 'readwrite', (st) => { st.delete(id); }),
    putSegment: (g) => tx('segments', 'readwrite', (st) => { st.put(g); }),
    getSegments: (sessionId) => tx('segments', 'readonly', (st) => reqP(st.index('sessionId').getAll(sessionId))),
    async deleteSegments(sessionId) {
      const keys = await tx('segments', 'readonly', (st) => reqP(st.index('sessionId').getAllKeys(sessionId)));
      await tx('segments', 'readwrite', (st) => keys.forEach((k) => st.delete(k)));
    },
    async deleteSession(id) {
      const clips = await this.getClips(id);
      await this.deleteSegments(id);
      await tx('clips', 'readwrite', (st) => clips.forEach((c) => st.delete(c.id)));
      await tx('sessions', 'readwrite', (st) => { st.delete(id); });
    },
  };
})();

// ---------------------------------------------------------------- audio helpers
function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // average over the source window (cheap low-pass) to avoid aliasing
    const start = i * ratio, end = Math.min(input.length, start + ratio);
    let sum = 0, n = 0;
    for (let j = Math.floor(start); j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function encodeWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, total * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// RMS -> relative dB: 0 = silence, ~100 = full scale
const toDb = (rms) => Math.max(0, 20 * Math.log10(rms + 1e-10) + 100);

// ---------------------------------------------------------------- monitor
const WebMonitor = {
  running: false,
  ctx: null, stream: null, src: null, proc: null, sink: null,
  session: null,
  level: 0,
  preBuf: [], preLen: 0,      // pre-roll audio kept before a clip starts
  clip: null,                 // clip being recorded: { start, chunks, len, peak, lastLoud, tag }
  secMax: 0, secSamples: 0,  // per-second level aggregation for the night graph
  saveTimer: null,
  seg: null, segTimer: null,  // whole-night recording

  async start({ record = settings.recordAll } = {}) {
    if (this.running) return;
    try {
      await this.startInner(record);
    } catch (e) {
      // undo a half-started recorder (e.g. storage full): release the microphone and audio engine
      this.running = false;
      clearInterval(this.saveTimer); clearInterval(this.segTimer);
      if (this.seg) { try { this.seg.rec.stop(); } catch {} this.seg = null; }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close().catch(() => {});
      this.session = null; this.live = null;
      throw e;
    }
  },

  getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  },

  // Microphone lost (another app took it, device unplugged, iOS interruption): try to get it back and
  // continue the same night; meanwhile the status shows a warning and the missing seconds become gaps.
  watchMic(stream) {
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => { if (this.running && this.stream === stream) this.recoverMic(); };
      t.onmute = () => { if (this.stream === stream) this.micMuted = true; };
      t.onunmute = () => { if (this.stream === stream) this.micMuted = false; };
    });
  },

  async recoverMic() {
    if (this.recovering) return;
    this.recovering = true; this.micLost = true;
    for (let i = 0; this.running && i < 30; i++) {
      try {
        const stream = await this.getMic();
        if (!this.running) { stream.getTracks().forEach((t) => t.stop()); break; }
        try { this.src.disconnect(); } catch {}
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = stream;
        this.src = this.ctx.createMediaStreamSource(stream);
        this.src.connect(this.proc); this.src.connect(this.analyser);
        this.watchMic(stream);
        if (this.seg) this.rotateSegment(); // the old recorder died with the old stream
        this.micLost = false;
        break;
      } catch { await new Promise((r) => setTimeout(r, 2000 * Math.min(5, i + 1))); }
    }
    this.recovering = false;
  },

  async startInner(record) {
    this.micLost = false; this.micMuted = false;
    this.stream = await this.getMic();
    this.watchMic(this.stream);
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but works on every browser incl. iOS Safari.
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.proc); this.proc.connect(this.sink); this.sink.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser(); // lets the meter read the level every screen frame
    this.analyser.fftSize = 2048;
    this.src.connect(this.analyser);
    this.proc.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0), this.ctx.sampleRate);
    // iPhone: a call, Siri or another app can suspend audio; resume as soon as possible
    this.ctx.onstatechange = () => { if (this.running && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };

    const now = Date.now();
    this.session = {
      id: 's' + now, start: now, end: now,
      settings: { ...settings },
      levels: [],      // one value per second: max dB in that second (0 = no data)
      events: [],      // (kept for older app versions)
      clips: [],       // { id, start, duration, peak, tag } (audio is in the clips store)
      segments: [],    // whole-night recording: { id, start, duration, mime, size } (audio in segments store)
    };
    Object.assign(this, { preBuf: [], preLen: 0, clip: null, secMax: 0, secSamples: 0 });
    await DB.putSession(this.session); // fails early (e.g. storage full) before anything is running
    this.running = true;
    this.live = LiveRecog.start(this.session);
    this.saveTimer = setInterval(() => this.persist(), 30000);
    if (record) this.setRecordAll(true);
  },

  // ---- whole-night recording, saved as consecutive files of SEGMENT_MS
  setRecordAll(on) {
    if (!this.running || FULL_MIME === null) return Promise.resolve();
    if (on && !this.seg) {
      this.startSegment();
      this.segTimer = setInterval(() => this.rotateSegment(), SEGMENT_MS);
    } else if (!on && this.seg) {
      clearInterval(this.segTimer);
      const g = this.seg; this.seg = null;
      return this.endSegment(g);
    }
    return Promise.resolve();
  },

  startSegment() {
    let rec;
    try {
      rec = new MediaRecorder(this.stream, FULL_MIME ? { mimeType: FULL_MIME, audioBitsPerSecond: FULL_BITRATE } : { audioBitsPerSecond: FULL_BITRATE });
    } catch (e) { console.error('MediaRecorder failed', e); this.seg = null; return; }
    const start = Date.now();
    const g = { rec, chunks: [], size: 0, start, end: 0, mime: rec.mimeType || FULL_MIME || 'audio/webm', session: this.session, live: this.live,
      meta: { id: 'g' + start, start, duration: 0, mime: rec.mimeType || FULL_MIME || 'audio/webm', size: 0, partial: true } };
    g.done = new Promise((res) => { rec.onstop = () => this.saveSegment(g).then(res, res); });
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      g.chunks.push(e.data); g.size += e.data.size;
      // store what we have so far (every 10 s), so a reload or crash loses at most 10 s of audio
      if (g.saved) return;
      g.meta.duration = +((Date.now() - g.start) / 1000).toFixed(1); g.meta.size = g.size;
      if (!g.session.segments.includes(g.meta)) g.session.segments.push(g.meta);
      DB.putSegment({ ...g.meta, sessionId: g.session.id, blob: new Blob(g.chunks, { type: g.mime }) }).catch(() => {});
    };
    rec.onstart = () => { g.start = g.meta.start = Date.now(); };
    rec.onerror = (e) => { console.warn('recorder error', e); if (this.seg === g && this.running) this.rotateSegment(); };
    rec.start(10000);
    this.seg = g;
  },

  rotateSegment() {
    const old = this.seg;
    this.startSegment(); // start the next file before stopping the old one so nothing is missed
    if (old) this.endSegment(old);
  },

  endSegment(g) {
    g.end = Date.now();
    try { g.rec.stop(); } catch { return this.saveSegment(g); }
    return g.done;
  },

  async saveSegment(g) {
    if (g.saved || !g.chunks.length) return;
    g.saved = true;
    const blob = new Blob(g.chunks, { type: g.mime });
    const end = g.end || Date.now();
    const meta = g.meta; // the same entry that was stored while recording, now complete
    Object.assign(meta, { start: g.start, duration: +((end - g.start) / 1000).toFixed(1), size: blob.size });
    delete meta.partial;
    if (!g.session.segments.includes(meta)) g.session.segments.push(meta);
    try {
      await DB.putSegment({ ...meta, sessionId: g.session.id, blob });
      await DB.putSession(g.session);
    } catch (e) { console.error('segment save failed', e); meta.saveError = true; }
    if (g.live) LiveRecog.add(g.live, meta, blob); // (also after Stop, if this file finished late)
  },

  fullBytes() {
    if (!this.session) return 0;
    return this.session.segments.reduce((n, g) => n + (g === (this.seg && this.seg.meta) ? 0 : g.size), 0) + (this.seg ? this.seg.size : 0);
  },

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.saveTimer);
    clearInterval(this.segTimer);
    // Save the clip in progress first, and never let a slow/stuck browser API block Stop
    // (Safari can fail to confirm MediaRecorder stops or IndexedDB writes).
    const capped = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    if (this.clip) await capped(this.finishClip(), 4000);
    if (this.seg) { const g = this.seg; this.seg = null; await capped(this.endSegment(g), 4000); }
    if (this.live) { LiveRecog.finish(this.live); this.live = null; } // completes in the background
    try { this.proc.disconnect(); this.src.disconnect(); this.sink.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    capped(this.ctx.close(), 2000).catch(() => {});
    this.session.end = Date.now();
    await capped(this.persist(), 4000);
    const s = this.session;
    this.session = null;
    return s;
  },

  persist() {
    if (!this.session) return Promise.resolve();
    this.session.end = Date.now();
    return DB.putSession(this.session).catch((e) => console.error('save failed', e));
  },

  process(input, rate) {
    if (!this.running) return; // stopping: don't start new clips or levels
    const now = Date.now();
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const level = toDb(Math.sqrt(sum / input.length));
    this.level = level;

    // per-second maximum for the night graph, counted by audio received (a late callback still belongs to
    // its own second); if audio really stopped (> 3 s behind the clock), the missing seconds are stored as 0
    this.secMax = Math.max(this.secMax, level);
    this.secSamples += input.length;
    if (this.secSamples >= rate) {
      const lv = this.session.levels;
      lv.push(Math.round(this.secMax * 10) / 10);
      this.secSamples -= rate;
      this.secMax = 0;
      while (now - (this.session.start + lv.length * 1000) > 3000) lv.push(0);
    }

    this.handleClip(resample(input, rate, CLIP_RATE), level, now);
  },

  // ---- threshold-triggered clip recording with pre-roll
  handleClip(chunk, level, now) {
    const s = settings;
    const loud = level >= s.threshold;
    if (this.clip) {
      this.clip.chunks.push(chunk); this.clip.len += chunk.length;
      this.clip.peak = Math.max(this.clip.peak, level);
      if (loud) this.clip.lastLoud = now;
      const dur = this.clip.len / CLIP_RATE;
      if (now - this.clip.lastLoud >= s.postRoll * 1000 || dur >= s.maxClip) this.finishClip();
    } else if (loud) {
      this.startClip(now, 'loud', chunk.length);
      this.clip.chunks.push(chunk); this.clip.len += chunk.length; this.clip.peak = level;
    } else {
      this.preBuf.push(chunk); this.preLen += chunk.length;
      while (this.preBuf.length && this.preLen - this.preBuf[0].length >= s.preRoll * CLIP_RATE) {
        this.preLen -= this.preBuf.shift().length;
      }
    }
  },

  // `curLen`: samples of the buffer that triggered the clip (it ends at `now`)
  startClip(now, tag, curLen = 0) {
    const preSec = (this.preLen + curLen) / CLIP_RATE;
    this.clip = { start: now - preSec * 1000, chunks: this.preBuf, len: this.preLen, peak: 0, lastLoud: now, tag };
    this.preBuf = []; this.preLen = 0;
  },

  finishClip() {
    const c = this.clip;
    this.clip = null;
    if (!c || !this.session) return Promise.resolve();
    const blob = encodeWav(c.chunks, CLIP_RATE);
    const id = 'c' + Math.round(c.start) + '-' + Math.random().toString(36).slice(2, 6);
    const meta = { id, start: Math.round(c.start), duration: +(c.len / CLIP_RATE).toFixed(1), peak: Math.round(c.peak), tag: c.tag };
    this.session.clips.push(meta);
    const session = this.session;
    this.persist(); // record the clip in the night right away, even if storing its audio is slow
    return DB.putClip({ ...meta, sessionId: session.id, blob })
      .catch((e) => {
        console.error('clip save failed', e);
        meta.saveError = true;
      })
      .then(() => DB.putSession(session).catch(() => {}));
  },
};

// ---------------------------------------------------------------- native monitor (Android app)
// Same interface as WebMonitor, but the work happens in the native SleepService; this only polls its status.
const NativeMonitor = {
  native: true,
  running: false, level: 0, session: null, clip: false, seg: false, bytes: 0, pollTimer: null,

  async start({ record = settings.recordAll } = {}) {
    const st = await SR.start({ settings: { ...settings, recordAll: !!record } });
    if (!st.running) throw new Error('the background recorder did not start');
    this.apply(st);
    this.poll();
  },
  async stop() {
    clearInterval(this.pollTimer); this.pollTimer = null;
    const r = await SR.stop();
    this.apply({ running: false });
    const s = r.session;
    return s ? { id: s.id, start: s.start, end: s.end, clips: { length: s.clipCount } } : null;
  },
  // re-attach to a service that kept running while the app was closed or in the background
  async resume() {
    const st = await SR.status();
    this.apply(st);
    if (st.running) this.poll();
    return st.running;
  },
  poll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const st = await SR.status();
        const was = this.running;
        this.apply(st);
        if (was && !st.running) { clearInterval(this.pollTimer); this.pollTimer = null; onStoppedElsewhere(); }
      } catch {}
    }, 120);
  },
  apply(st) {
    this.running = !!st.running;
    if (!st.running) { this.session = null; this.clip = false; this.seg = false; return; }
    this.level = st.level; this.clip = st.clipActive; this.seg = st.recordAll; this.bytes = st.fullBytes;
    this.session = { id: st.sessionId, start: st.start, clips: { length: st.clipCount } };
  },
  fullBytes() { return this.bytes; },
  setRecordAll(on) {
    if (this.running) SR.update({ settings: { ...settings, recordAll: on } }).catch(() => {});
    return Promise.resolve();
  },
  persist() {},
};

const Monitor = USE_NATIVE ? NativeMonitor : WebMonitor;

// ---------------------------------------------------------------- UI helpers
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const rate = (n, ms) => (ms >= 600000 ? (n / (ms / 3600000)).toFixed(1) : '–');
const fileStamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };


const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Save files: browser download, or in the Android app write them to a temp file and open the share sheet
// (save to Files / Drive, send by email, WhatsApp, ...).
async function downloadMany(items) {
  const fs = plugin('Filesystem'), share = plugin('Share');
  if (fs && share) {
    try {
      const files = [];
      for (const { blob, name } of items) {
        const r = await fs.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
        files.push(r.uri);
      }
      await share.share({ title: items.length === 1 ? items[0].name : `${items.length} recordings`, files });
    } catch (e) {
      if (!/cancel/i.test(e && e.message)) alert('Could not save: ' + (e && e.message));
    }
    return;
  }
  for (const { blob, name } of items) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if (items.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}
const download = (blob, name) => downloadMany([{ blob, name }]);

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = cv.clientHeight || +cv.getAttribute('height');
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
// theme colors, read once (getComputedStyle is too slow to call every frame)
const COLORS = {};
const css = (v) => COLORS[v] || (COLORS[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim());
const DB_MIN = 20, DB_MAX = 100;
const yOf = (db, h) => h - ((Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * h;

// ---------------------------------------------------------------- live level preview
// The meter works as soon as the app opens (before Start). Nothing is recorded: the microphone only feeds
// an analyser that the meter reads every screen frame.
const Preview = {
  on: false, starting: null,
  start() {
    if (this.on || this.starting || Monitor.running || document.visibilityState !== 'visible') return this.starting || Promise.resolve();
    this.starting = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      if (Monitor.running || document.visibilityState !== 'visible') { stream.getTracks().forEach((t) => t.stop()); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      Object.assign(this, { ctx, stream, src, analyser, on: true });
      if (ctx.state === 'suspended') {
        // browsers only allow audio after a tap
        ctx.resume().catch(() => {});
        const resume = () => { ctx.resume().catch(() => {}); window.removeEventListener('pointerdown', resume, true); };
        window.addEventListener('pointerdown', resume, true);
      }
    })().finally(() => { this.starting = null; });
    return this.starting;
  },
  stop() {
    if (!this.on) return;
    this.on = false;
    try { this.src.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    this.ctx.close().catch(() => {});
  },
};

function startPreview() {
  Preview.start().catch((e) => {
    if (Monitor.running) return;
    $('stState').textContent = 'Microphone blocked';
    $('stInfo').textContent = e && e.name === 'NotAllowedError' ? 'Allow microphone access to see the level' : 'Microphone not available here';
  });
}

// ---------------------------------------------------------------- monitor UI
let wakeLock = null;
async function keepAwake() {
  if (USE_NATIVE) return; // the native service keeps running with the screen off
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function allowSleep() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function updateThresholdUI() {
  $('thresholdVal').textContent = settings.threshold;
  $('thresholdQuick').value = settings.threshold;
  $('setThreshold').value = settings.threshold;
  $('meterThreshold').style.left = `${((settings.threshold - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
}

const levelSource = () => (Monitor.running ? Monitor : Preview);

// Smooth meter: the dB number, bar and live graph are redrawn every screen frame (~60 fps).
// In the browser the level is read straight from the microphone each frame; in the Android app the
// background recorder's level (polled ~8x/s) is eased so it moves smoothly.
const Meter = {
  shown: null, raw: null, hist: [], h0: 0, lastPush: 0, buf: null, lastText: 0, lastStatus: 0, barW: '',
  target(m) {
    if (!(Monitor.running || Preview.on)) return null;
    const an = m.analyser;
    if (an && m.ctx && m.ctx.state === 'running') {
      if (!this.buf || this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      return toDb(Math.sqrt(sum / this.buf.length));
    }
    return Number.isFinite(m.level) ? m.level : null;
  },
  frame(now, draw) {
    const m = levelSource(), t = this.target(m);
    this.raw = t;
    if (t !== null) {
      // rise quickly, fall gently
      this.shown = this.shown === null ? t : this.shown + (t - this.shown) * (t > this.shown ? 0.5 : 0.12);
      if (now - this.lastPush >= 33) { this.hist.push(now, this.shown); this.lastPush = now; }
    }
    // drop points older than the window (in batches: shifting a big array every frame is slow)
    while (this.h0 < this.hist.length && now - this.hist[this.h0] > LIVE_SECONDS * 1000) this.h0 += 2;
    if (this.h0 > 600) { this.hist.splice(0, this.h0); this.h0 = 0; }
    if (now - this.lastStatus > 150) { this.lastStatus = now; updateStatus(); }
    if (!draw) return;
    const v = this.shown;
    if (v !== null) {
      if (now - this.lastText > 150) { $('levelNow').textContent = Math.round(v); this.lastText = now; }
      const bw = `${(((Math.min(DB_MAX, Math.max(DB_MIN, v)) - DB_MIN) / (DB_MAX - DB_MIN)) * 100).toFixed(1)}%`;
      if (bw !== this.barW) { $('meterBar').style.width = bw; this.barW = bw; }
    }
    this.draw(now);
  },
  draw(now = performance.now()) {
    const { g, w, h } = setupCanvas($('liveChart'));
    g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath();
    const ty = yOf(settings.threshold, h); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
    const pts = this.hist, i0 = this.h0;
    if (pts.length - i0 < 4) return;
    // scrolls continuously: x is based on time, not on sample count
    const span = LIVE_SECONDS * 1000;
    g.beginPath();
    for (let i = i0; i < pts.length; i += 2) {
      const x = w - ((now - pts[i]) / span) * w, y = yOf(pts[i + 1], h);
      if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = Monitor.running ? css('--accent') : css('--muted'); g.lineWidth = 1.5; g.lineJoin = 'round';
    g.stroke();
    // soft fill under the line
    g.lineTo(w, h); g.lineTo(w - ((now - pts[i0]) / span) * w, h); g.closePath();
    g.fillStyle = Monitor.running ? 'rgba(143,180,255,.14)' : 'rgba(138,148,168,.10)';
    g.fill();
  },
  start() {
    const step = (now) => {
      requestAnimationFrame(step);
      if (document.visibilityState !== 'visible') return;
      // the graph is hidden behind night mode or an open night: keep the status, skip drawing
      this.frame(now, $('nightOverlay').hidden && $('nightSheet').hidden);
    };
    requestAnimationFrame(step);
  },
};
const drawLive = () => Meter.draw();

let calib = null, lastSaved = '';
function updateStatus() {
  const s = Monitor.running ? Monitor.session : null;
  if (calib && Meter.raw !== null) calib.push(Meter.raw);
  let state, info;
  if (calib) { state = 'Stay quiet…'; info = 'Measuring the room for 10 s'; }
  else if (s) {
    state = Monitor.micLost ? '⚠ Microphone lost, reconnecting…' : Monitor.micMuted ? '⚠ Microphone paused by the system' : Monitor.clip ? '● Recording sound' : 'Monitoring';
    info = `${fmtDur(Date.now() - s.start)} · ${s.clips.length} loud sounds`;
    setText('nightInfo', `${s.clips.length} loud sounds`);
  } else if (Preview.on || Preview.starting) { state = 'Live level'; info = lastSaved || 'Not recording · tap Start'; }
  else return; // keep the "microphone blocked" message
  setText('stState', state);
  $('stState').style.color = s && Monitor.clip ? css('--danger') : '';
  setText('stInfo', info);
  updateRecordAllInfo();
}
// only touch the DOM when the text actually changes
function setText(id, text) { setTextEl($(id), text); }
function setTextEl(el, text) { if (el && el.textContent !== text) el.textContent = text; }

function setRunningUI(on) {
  const b = $('btnToggle');
  b.textContent = on ? 'Stop' : 'Start';
  b.classList.toggle('running', on);
  $('btnNight').disabled = !on;
}

$('btnToggle').onclick = async () => {
  const b = $('btnToggle');
  b.disabled = true;
  try {
    if (!Monitor.running) {
      Preview.stop(); // free the microphone for the recorder
      Recog.cancelAll(); // and the CPU
      try {
        await Monitor.start();
      } catch (e) {
        alert('Could not start monitoring: ' + e.message + (USE_NATIVE ? '' : '\n\nThe page must be opened over https and microphone access allowed.'));
        startPreview();
        return;
      }
      lastSaved = '';
      keepAwake();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      setRunningUI(true);
      if (USE_NATIVE) checkBattery(true);
      renderWeek();
    } else {
      let s = null;
      try { s = await Monitor.stop(); } catch (e) { alert('Stop failed: ' + e.message); }
      setRunningUI(false);
      allowSleep();
      if (s) lastSaved = `Saved ${fmtDur(s.end - s.start)} · ${s.clips.length} loud sounds`;
      startPreview();
      await renderWeek();
      autoRecognise();
    }
  } finally {
    b.disabled = false;
  }
};

// monitoring was stopped from the notification's Stop button
async function onStoppedElsewhere() {
  setRunningUI(false);
  startPreview();
  await renderWeek();
  autoRecognise();
}

$('btnCalibrate').onclick = async () => {
  closeSheets();
  if (!Monitor.running && !Preview.on) {
    try { await Preview.start(); } catch (e) { alert('Microphone error: ' + e.message); return; }
  }
  if (Preview.ctx && Preview.ctx.state !== 'running') await Preview.ctx.resume().catch(() => {});
  calib = [];
  await new Promise((r) => setTimeout(r, 10000));
  const vals = calib.sort((a, b) => a - b);
  calib = null;
  if (!vals.length) return;
  settings.threshold = Math.min(100, Math.max(20, Math.round(vals[Math.floor(vals.length * 0.9)] + 15)));
  saveSettings(); updateThresholdUI();
  lastSaved = `Threshold set to ${settings.threshold} dB (room + 15)`;
};

function updateRecordAllInfo() {
  const el = $('recordAllInfo');
  if (!FULL_OK) { el.textContent = 'Not supported by this browser.'; return; }
  if (!Monitor.running) { el.textContent = ''; return; }
  const bytes = Monitor.fullBytes();
  el.textContent = Monitor.seg ? `● Recording${bytes ? ` · ${fmtMB(bytes)} so far` : ''}`
    : (bytes ? `Paused · ${fmtMB(bytes)} saved` : '');
}
$('recordAll').onchange = (e) => {
  settings.recordAll = e.target.checked; saveSettings();
  Monitor.setRecordAll(settings.recordAll);
  updateRecordAllInfo();
};

$('thresholdQuick').oninput = (e) => { settings.threshold = +e.target.value; saveSettings(); updateThresholdUI(); drawLive(); };

// night mode: black screen, double-tap to exit
let nightClockTimer;
$('btnNight').onclick = () => {
  closeSheets();
  $('nightOverlay').hidden = false;
  const tick = () => { $('nightClock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  tick(); nightClockTimer = setInterval(tick, 10000);
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
};
let lastTap = 0;
$('nightOverlay').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastTap < 400) {
    $('nightOverlay').hidden = true; clearInterval(nightClockTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  lastTap = now;
});

// ---------------------------------------------------------------- sheets (⋮ menus, settings, about, night detail)
// Sheets and ⋮ menus are "layers". Opening one adds a history entry, so the phone's Back button closes the
// topmost layer only. They animate in and out with CSS transitions on transform/opacity (.open, see styles.css);
// a closing layer stays visible until its transition ends (with a timeout fallback), then gets `hidden`.
const layers = [];
const reducedMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
function afterTransition(el, fn) {
  let t = 0;
  const done = () => { el.removeEventListener('transitionend', onEnd); clearTimeout(t); fn(); };
  const part = el.querySelector(':scope > .sheet-panel') || el; // the part that moves
  const onEnd = (e) => { if (e.target === part && (e.propertyName === 'transform' || e.propertyName === 'opacity')) done(); };
  if (reducedMotion.matches) { done(); return; }
  el.addEventListener('transitionend', onEnd);
  t = setTimeout(done, 450);
}
function showLayer(el) {
  const tok = el._anim = {};
  el.hidden = false;
  void el.offsetWidth; // start from the closed state so the transition runs
  el.classList.add('open');
  return new Promise((resolve) => afterTransition(el, () => resolve(el._anim === tok)));
}
function hideLayer(el, then) {
  if (el.hidden) { if (then) then(); return; }
  const tok = el._anim = {};
  if (el.contains(document.activeElement)) document.activeElement.blur(); // commits a half-typed setting
  el.classList.remove('open');
  afterTransition(el, () => { if (el._anim !== tok) return; el.hidden = true; if (then) then(); });
}
function openLayer(el, replace = false) {
  if (layers.includes(el)) return Promise.resolve(true);
  layers.push(el);
  if (el.classList.contains('sheet')) el.style.zIndex = 20 + layers.length; // later sheets on top
  const st = { layer: el.id || 'menu', depth: layers.length };
  if (replace) history.replaceState(st, ''); else history.pushState(st, '');
  histDepth = layers.length;
  return showLayer(el);
}
// take a layer off the stack and animate it out (history is handled by the caller)
function dropLayer(el) {
  const i = layers.indexOf(el);
  if (i < 0) return;
  layers.splice(i, 1);
  if (el.id === 'nightSheet') { hideLayer(el, () => { if (!layers.includes(el)) closeNight(); }); renderWeek(); }
  else hideLayer(el);
}
// depth of our history entries once queued back navigations are done (each open layer has one)
let histDepth = 0;
const stateDepth = () => (history.state && history.state.depth) || 0;
function goBack(n) { histDepth -= n; history.go(-n); }
function closeTop() {
  if (!layers.length) return;
  const top = layers[layers.length - 1];
  if (histDepth === layers.length) goBack(1);
  dropLayer(top); // right away, so code running next sees the new stack (popstate then finds nothing to do)
}
function closeSheets() {
  const n = Math.min(layers.length, histDepth);
  while (layers.length) dropLayer(layers[layers.length - 1]);
  if (n > 0) goBack(n);
}
const openSheet = (sh) => openLayer(sh);
window.addEventListener('popstate', () => {
  histDepth = stateDepth();
  while (layers.length > histDepth) dropLayer(layers[layers.length - 1]);
});
if (stateDepth()) history.replaceState(null, ''); // reloaded with a sheet open: start from the main screen
document.querySelectorAll('.sheet').forEach((sh) => {
  sh.addEventListener('click', (e) => { if (e.target === sh && layers[layers.length - 1] === sh) closeTop(); });
  sh.querySelector('.sheet-close').onclick = closeTop;
});

// ⋮ menus: the top bar's (#appMenu) and the night screen's (.s-actions of the shown night)
const topLayer = () => layers[layers.length - 1];
function toggleMenu(menu) {
  if (topLayer() === menu) closeTop();
  else if (menu && !layers.includes(menu)) { if (topLayer() && topLayer().classList.contains('popmenu')) closeTop(); openLayer(menu); }
}
// a menu item: Settings/About replace the menu (Back then returns to what was below it); others just close it
function onMenuClick(menu, e) {
  const b = e.target.closest('button');
  if (!b || topLayer() !== menu) return;
  const target = b.dataset.open && $(b.dataset.open);
  if (!target) { closeTop(); return; }
  const replace = histDepth === layers.length;
  layers.pop(); hideLayer(menu); // its history entry becomes the sheet's
  if (target.id === 'menuSheet') fillSettings();
  updateStorageInfo();
  openLayer(target, replace);
}
function wireMenu(menu) {
  menu.addEventListener('click', (e) => onMenuClick(menu, e));
}
wireMenu($('appMenu'));
$('btnMenu').onclick = (e) => { e.stopPropagation(); toggleMenu($('appMenu')); };
// tapping anywhere outside an open menu closes it
document.addEventListener('click', (e) => {
  const m = topLayer();
  if (m && m.classList.contains('popmenu') && !m.contains(e.target)) closeTop();
});
$('appVersion').textContent = window.APP_VERSION || 'dev';
if (NATIVE) $('linkReleases').removeAttribute('target'); // the app opens external links in the browser

async function updateStorageInfo() {
  let text = '';
  if (USE_NATIVE) {
    const bytes = allNights.reduce((n, src) => n + (src.s.bytes || 0), 0);
    text = `${fmtMB(bytes)} of recordings on this phone`;
  } else if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    text = `${(usage / 1e6).toFixed(1)} MB used of ${(quota / 1e9).toFixed(1)} GB`;
  }
  document.querySelectorAll('.storage-info').forEach((el) => { el.textContent = text; });
}

// ---------------------------------------------------------------- settings
const FIELDS = {
  setThreshold: 'threshold', setPreRoll: 'preRoll', setPostRoll: 'postRoll', setMaxClip: 'maxClip',
  setMaxGap: 'maxGap',
};
function fillSettings() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = settings[key];
  $('recordAll').checked = settings.recordAll;
  $('recordAll').disabled = !FULL_OK;
  updateRecordAllInfo();
  updateThresholdUI();
}
for (const [id, key] of Object.entries(FIELDS)) {
  $(id).addEventListener('change', (e) => {
    const el = e.target, v = +el.value;
    if (Number.isFinite(v) && el.value !== '') settings[key] = Math.min(+el.max, Math.max(+el.min, v));
    el.value = settings[key];
    saveSettings(); updateThresholdUI();
  });
}
$('btnResetSettings').onclick = () => { settings = { ...DEFAULTS, recordAll: true }; saveSettings(); Monitor.setRecordAll(settings.recordAll); fillSettings(); };

// ---------------------------------------------------------------- history UI
const openViews = new Set();
const byStart = (a, b) => a.start - b.start;

/*
 * A night can come from two places:
 *  - IndexedDB: recorded by the browser version (audio as Blobs)
 *  - the Android background service: files on the phone (audio played via file URLs)
 * Both are wrapped in a "source" with the same methods so the History screen doesn't care.
 */
function idbSource(s) {
  const live = Monitor === WebMonitor && WebMonitor.session && WebMonitor.session.id === s.id;
  if (live) s = WebMonitor.session; // show the latest data of a night still being recorded
  if (!s.segments) s.segments = [];
  return {
    s, live, native: false,
    async load() {
      const [c, g] = await Promise.all([DB.getClips(s.id), DB.getSegments(s.id)]);
      return { s, clips: c.sort(byStart), segs: g.sort(byStart) };
    },
    async deleteClip(c) {
      await DB.deleteClip(c.id);
      s.clips = s.clips.filter((x) => x.id !== c.id);
      if (!live) await DB.putSession(s);
    },
    async deleteFull() { await DB.deleteSegments(s.id); s.segments = []; await DB.putSession(s); },
    deleteSession: () => DB.deleteSession(s.id),
    async saveAnalysis(a) { s.analysis = a; if (!live) await DB.putSession(s); },
    save: (items) => downloadMany(items.map((i) => ({ blob: i.item.blob, name: i.name }))),
  };
}

function nativeSource(s) {
  const src = {
    s, live: !!s.live, native: true,
    async load() {
      const { session } = await SR.getSession({ id: s.id });
      const toUrl = (x) => ({ ...x, src: window.Capacitor.convertFileSrc(x.path) });
      session.segments = session.segments || [];
      src.s = session;
      return { s: session, clips: session.clips.map(toUrl).sort(byStart), segs: session.segments.map(toUrl).sort(byStart) };
    },
    async deleteClip(c) { await SR.deleteClip({ sessionId: s.id, clipId: c.id }); src.s.clips = src.s.clips.filter((x) => x.id !== c.id); },
    async deleteFull() { await SR.deleteFull({ sessionId: s.id }); src.s.segments = []; },
    async saveAnalysis(a) { await SR.saveAnalysis({ sessionId: s.id, analysis: a }); src.s.analysis = a; },
    deleteSession: () => SR.deleteSession({ id: s.id }),
    save: (items) => SR.share({ files: items.map((i) => ({ path: i.item.path, name: i.name })) }).catch((e) => alert(e.message)),
  };
  return src;
}

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
const segBytes = (s) => (s.segments || []).reduce((n, g) => n + (g.size || 0), 0);

async function mountNight(el, src) {
  const live = src.live;
  let view = null;
  const meta = () => {
    const s = view.s;
    const dur = (live ? Date.now() : s.end) - s.start;
    const snore = snoreMs(s);
    const ns = view.sessions.length;
    return `${fmtDur(dur)} · ${view.sounds.length} loud sounds` +
      (snore !== null ? ` · snoring ${fmtSnore(snore)}${ns ? ` in ${ns} session${ns === 1 ? '' : 's'}` : ''}` : '') +
      (view.segs.length ? ` · ${fmtMB(segBytes(s))}` : '');
  };
  let d;
  try { d = await src.load(); } catch (e) { alert('Could not open this night: ' + e.message); return null; }
  if (!el.isConnected) return null; // closed while loading
  view = new NightView(el, d.s, d.clips, d.segs, src);
  openViews.add(view);

  const renderSummary = () => {
    setTextEl(el.querySelector('.s-meta'), meta());
    setTextEl(el.querySelector('.n-cl'), String(view.soundList().length));
    el.querySelector('.btn-dlfull').hidden = !view.segs.length;
    el.querySelector('.btn-delfull').hidden = !view.segs.length || live;
  };

  // sounds above this night's threshold, labelled by what they are; tap to play
  const sndBox = el.querySelector('.s-sounds'), chipBox = el.querySelector('.cat-chips');
  let shown = [];
  const renderSounds = () => {
    shown = view.soundList();
    if (view.cat === 'sessions') {
      sndBox.innerHTML = shown.length ? shown.map((x, i) =>
        `<div class="list-item clickable snd-row" data-i="${i}"><span>${hm(x.s)}–${hm(x.e)}</span><b>${durShort(Math.max(60000, x.e - x.s))}</b>` +
        `<span class="muted">${x.n} snore${x.n === 1 ? '' : 's'}</span><span class="grow"></span><span class="muted">▶</span></div>`).join('')
        : `<p class="muted empty">No snoring above ${view.thr} dB.</p>`;
      view.rowMark = null; view.markRows();
      return;
    }
    sndBox.innerHTML = shown.length ? shown.map((x, i) => {
      const cat = x.c ? CATS[x.c] : null;
      return `<div class="list-item clickable snd-row" data-i="${i}"><span>${fmtTime(x.s)}</span><span>${Math.round((x.e - x.s) / 1000)}s</span>` +
        `<span class="muted">${Math.round(x.peak)} dB</span>${cat ? `<span class="cat" style="--c:${cat.color}">${cat.name}</span>` : ''}` +
        '<span class="grow"></span><span class="muted">▶</span></div>';
    }).join('') : `<p class="muted empty">No ${view.cat ? CATS[view.cat].name.toLowerCase() + ' ' : ''}sounds above ${view.thr} dB.</p>`;
    view.rowMark = null;
    view.markRows();
  };
  // tap = play (zoom unchanged); double tap = zoom in on that sound
  let lastRow = null, lastRowAt = 0;
  sndBox.onclick = (e) => {
    const r = e.target.closest('.snd-row');
    if (!r) return;
    const x = shown[+r.dataset.i], now = performance.now();
    if (lastRow === x && now - lastRowAt < 400) { view.focusSound(x); lastRow = null; return; }
    lastRow = x; lastRowAt = now;
    view.playSound(x);
  };

  // category chips: how long each kind of sound was heard and how many loud sounds it caused; tap to highlight
  const renderChips = () => {
    const runs = view.runs(), secs = {}, count = {};
    runs.forEach((r) => { secs[r.c] = (secs[r.c] || 0) + (r.e - r.s) / 1000; });
    view.sounds.forEach((x) => { if (x.c) count[x.c] = (count[x.c] || 0) + 1; });
    const ses = view.sessions.length ? `<button class="chip${view.cat === 'sessions' ? ' on' : ''}" data-c="sessions" style="--c:${CATS.snore.color}">` +
      `Snoring sessions <span>${view.sessions.length}</span></button>` : '';
    chipBox.innerHTML = ses + CAT_ORDER.filter((c) => secs[c]).map((c) => {
      const m = Math.round(secs[c] / 60), n = count[c];
      return `<button class="chip${view.cat === c ? ' on' : ''}" data-c="${c}" style="--c:${CATS[c].color}">${CATS[c].name} ` +
        `<span>${m ? m + 'm' : Math.round(secs[c]) + 's'}${n ? ' · ' + n : ''}</span></button>`;
    }).join('');
  };
  chipBox.onclick = (e) => { const b = e.target.closest('.chip'); if (b) view.setCategory(b.dataset.c); };

  view.onDataChanged = () => { renderSounds(); renderChips(); renderSummary(); };
  view.onDataChanged();

  // sound recognition runs as a background job (keeps going if this night is closed)
  const status = el.querySelector('.an-status');
  const showJob = (job) => {
    if (job.error) { status.textContent = 'recognition unavailable'; status.title = String(job.error.message || job.error); return; }
    if (job.cancelled) { status.textContent = 'paused'; return; }
    if (!job.done) { setTextEl(status, `recognising ${Math.round(job.progress * 100)}%`); return; }
    status.textContent = '';
    if (job.result && view.root.isConnected) {
      view.s.analysis = job.result;
      view.recalc(); view.onDataChanged(); view.requestDraw();
    }
  };
  if (live) status.textContent = view.s.analysis ? 'live' : 'after the night';
  else if (Monitor.running) { if (Recog.needs(view.s)) status.textContent = 'after the recording'; }
  else if (Recog.needs(view.s) && (view.segs.length || view.clips.length)) {
    const job = Recog.run(src, d);
    job.listeners.add(showJob);
    view.onDestroy = () => job.listeners.delete(showJob);
    showJob(job);
  }

  // actions live in the ⋮ menu of the night screen (opened and closed by openNight)
  el.querySelector('.btn-csv').onclick = () => {
    const s = view.s;
    const rows = [['type', 'start', 'end', 'duration_s', 'peak_db', 'note']];
    view.clips.forEach((c) => rows.push(['clip', new Date(c.start).toISOString(), new Date(c.start + c.duration * 1000).toISOString(), c.duration, c.peak, c.tag]));
    download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `sleep_${fileStamp(s.start)}.csv`);
  };
  el.querySelector('.btn-dlall').onclick = async () => {
    if (view.clips.length) await src.save(view.clips.map((c) => ({ item: c, name: `sleep_${fileStamp(c.start)}.wav` })));
  };
  el.querySelector('.btn-dlfull').onclick = async () => {
    if (view.segs.length > 1 && !confirm(`The full recording is saved as ${view.segs.length} files of up to 10 minutes. Save them all?`)) return;
    await src.save(view.segs.map((g) => ({ item: g, name: `sleep_full_${fileStamp(g.start)}.${extFor(g.mime)}` })));
  };
  el.querySelector('.btn-delfull').onclick = async () => {
    if (!confirm(`Delete the whole-night recording (${fmtMB(segBytes(view.s))})? Saved clips and the graph are kept.`)) return;
    await src.deleteFull();
    view.clearSegments();
    renderSummary();
  };
  el.querySelector('.btn-del').onclick = async () => {
    if (live) { alert('Stop monitoring first.'); return; }
    if (!confirm('Delete this whole night, including all clips and the full recording?')) return;
    await src.deleteSession();
    closeSheets();
  };
  return view;
}

// ---------------------------------------------------------------- past nights: week grid
let allNights = [];   // sources (see idbSource / nativeSource)
let weekOffset = 0;   // 0 = this week, -1 = last week, ...
let nightView = null;

async function loadNights() {
  const sources = (await DB.getSessions()).map(idbSource);
  if (USE_NATIVE) {
    try {
      const { sessions } = await SR.listSessions();
      sessions.forEach((s) => sources.push(nativeSource(s)));
    } catch (e) { console.error(e); }
  }
  allNights = sources;
}

// a night belongs to the evening it started on (a start at 01:30 counts as the previous night)
const nightDay = (t) => { const d = new Date(t - 12 * 3600e3); d.setHours(0, 0, 0, 0); return d.getTime(); };
function weekStart(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7); // Monday
  return d;
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const durShort = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${m}m`; };
const nightEnd = (src) => (src.live ? Date.now() : src.s.end);
// snoring recognised in a night, in ms (null = not analysed yet)
function snoreMs(s) {
  if (!s.analysis || !s.analysis.runs) return null;
  return s.analysis.runs.reduce((t, r) => t + (r.c === 'snore' ? r.e - r.s : 0), 0);
}
const fmtSnore = (ms) => (ms > 0 && ms < 60000 ? '<1m' : durShort(ms));

function sparkOf(s) {
  if (s.spark) return s.spark;
  const lv = s.levels || [], n = Math.min(60, lv.length), out = [];
  for (let b = 0; b < n; b++) {
    let m = 0;
    for (let i = Math.floor((b * lv.length) / n); i < Math.max(Math.floor(((b + 1) * lv.length) / n), Math.floor((b * lv.length) / n) + 1); i++) m = Math.max(m, lv[i]);
    out.push(m);
  }
  return out;
}

function drawSpark(cv, src) {
  const { g, w, h } = setupCanvas(cv);
  const s = src.s, data = sparkOf(s), total = Math.max(1, nightEnd(src) - s.start);
  if (data.length) {
    const bw = w / data.length;
    g.fillStyle = css('--accent');
    data.forEach((v, i) => {
      const y = yOf(v, h);
      g.fillRect(i * bw, y, Math.max(1, bw - 0.5), h - y);
    });
  }
  // snoring (once recognised): short ticks along the top
  g.fillStyle = CATS.snore.color;
  ((s.analysis && s.analysis.runs) || []).forEach((r) => { if (r.c === 'snore') g.fillRect(((r.s - s.start) / total) * w, 0, Math.max(1, ((r.e - r.s) / total) * w), Math.max(3, h * 0.18)); });
}

let reloadSeq = 0;
async function renderWeek(reload = true) {
  if (reload) {
    const seq = ++reloadSeq;
    await loadNights();
    if (seq !== reloadSeq) return; // a newer reload is on its way and will draw
  }
  const ws = weekStart(weekOffset), we = addDays(ws, 7);
  const fmtD = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  $('weekLabel').textContent = weekOffset === 0 ? `This week · ${fmtD(ws)} – ${fmtD(addDays(ws, 6))}`
    : weekOffset === -1 ? `Last week · ${fmtD(ws)} – ${fmtD(addDays(ws, 6))}` : `${fmtD(ws)} – ${fmtD(addDays(ws, 6))}`;
  $('weekNext').disabled = weekOffset >= 0;
  $('weekPrev').disabled = !allNights.some((n) => nightDay(n.s.start) < ws.getTime());

  const grid = $('weekGrid');
  grid.innerHTML = '';
  const today = nightDay(Date.now() + 12 * 3600e3), inWeek = [];
  const sparks = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(ws, i).getTime();
    const list = allNights.filter((n) => nightDay(n.s.start) === day).sort((a, b) => a.s.start - b.s.start);
    inWeek.push(...list);
    const main = list.reduce((best, n) => (!best || nightEnd(n) - n.s.start > nightEnd(best) - best.s.start ? n : best), null);
    const el = document.createElement(main ? 'button' : 'div');
    el.className = 'tile' + (main ? ' has' : ' empty') + (day === today ? ' today' : '');
    const label = new Date(day).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    let html = `<div class="t-day"><span>${label}</span>` +
      (list.some((n) => n.live) ? '<span class="badge">REC</span>' : list.length > 1 ? `<span class="more">+${list.length - 1}</span>` : '') + '</div>';
    if (main) {
      const dur = nightEnd(main) - main.s.start, sn = snoreMs(main.s);
      html += `<div class="t-time">${hm(main.s.start)}</div><canvas></canvas>` +
        `<div class="t-time">${durShort(dur)}</div>` +
        `<div class="t-rate snore" data-night="${main.s.id}">${sn === null ? '' : sn ? `snore ${fmtSnore(sn)}` : 'no snoring'}</div>`;
      el.onclick = () => openNight(list, list.indexOf(main));
    } else {
      html += `<div class="t-time">${day > today ? '' : '—'}</div>`;
    }
    el.innerHTML = html;
    grid.appendChild(el);
    if (main) sparks.push([el.querySelector('canvas'), main]);
  }

  // 8th tile: week summary
  const sum = document.createElement('div');
  sum.className = 'tile summary';
  const hours = inWeek.reduce((t, n) => t + (nightEnd(n) - n.s.start), 0) / 3600e3;
  const nights = new Set(inWeek.map((n) => nightDay(n.s.start))).size;
  const analysed = inWeek.filter((n) => snoreMs(n.s) !== null);
  const snoreAvg = analysed.length ? analysed.reduce((t, n) => t + snoreMs(n.s), 0) / analysed.length : null;
  sum.innerHTML = `<div class="t-day"><span>Week</span></div>` +
    `<div><b>${nights}</b> night${nights === 1 ? '' : 's'}</div>` +
    `<div class="muted">${hours ? `${(hours / Math.max(1, nights)).toFixed(1)} h avg` : '—'}</div>` +
    `<div class="t-time">snoring avg</div>` +
    `<div class="t-rate snore"><b>${snoreAvg === null ? '–' : fmtSnore(snoreAvg)}</b></div>`;
  grid.appendChild(sum);
  requestAnimationFrame(() => sparks.forEach(([cv, src]) => drawSpark(cv, src)));
  grid.querySelectorAll('[data-night]').forEach((el) => {
    const job = Recog.jobs.get(el.dataset.night);
    if (!job) return;
    const f = (j) => {
      if (!el.isConnected) { j.listeners.delete(f); return; }
      if (j.done) { j.listeners.delete(f); setTimeout(() => renderWeek(false), 0); return; }
      setTextEl(el, `recognising ${Math.round(j.progress * 100)}%`);
    };
    job.listeners.add(f); f(job);
  });
}

// the new week slides in from the side it comes from
function slideWeek(dir) {
  renderWeek(false);
  const g = $('weekGrid');
  if (reducedMotion.matches || !g.animate) return;
  g.animate([{ transform: `translateX(${dir * 32}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
$('weekPrev').onclick = () => { weekOffset--; slideWeek(-1); };
$('weekNext').onclick = () => { if (weekOffset < 0) { weekOffset++; slideWeek(1); } };
// swipe the grid sideways to change week
(() => {
  let x0 = null;
  const g = $('weekGrid');
  g.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
  g.addEventListener('pointerup', (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) < 60) return;
    if (dx > 0 && !$('weekPrev').disabled) $('weekPrev').click();
    if (dx < 0 && !$('weekNext').disabled) $('weekNext').click();
  });
})();
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderWeek(false), 150); });

// ---------------------------------------------------------------- one night (full screen)
function closeNight() {
  if (!$('nightSheet').classList.contains('open')) nightSwitch = null;
  if (nightView) { nightView.destroy(); openViews.delete(nightView); nightView = null; }
  $('nightBody').innerHTML = '';
  $('nightPick').innerHTML = '';
}

// shown at once while a night loads (its data is read and drawn after the slide-in, so that stays smooth)
const NIGHT_PLACEHOLDER = '<div class="ph-line"></div><div class="ph-tools"></div><div class="ph-chart"></div>' +
  '<div class="ph-player"></div><div class="ph-list"></div>';
let showSeq = 0;
let nightSwitch = null; // set while a night is open: switches to the previous/next recorded day
const mainIndex = (list) => list.reduce((bi, n, i) => (nightEnd(n) - n.s.start > nightEnd(list[bi]) - list[bi].s.start ? i : bi), 0);
function openNight(list, idx) {
  const opened = openSheet($('nightSheet'));
  // swipe left/right outside the graph: next/previous day that has a recording
  nightSwitch = async (dir) => {
    const days = [...new Set(allNights.map((n) => nightDay(n.s.start)))].sort((a, b) => a - b);
    const k = days.indexOf(nightDay(list[0].s.start)) + dir;
    const body = $('nightBody'), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (k < 0 || k >= days.length) { // no more recordings that way: small bounce
      if (!still && body.animate) body.animate([{ transform: 'none' }, { transform: `translateX(${-dir * 14}px)` }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
      return;
    }
    list = allNights.filter((n) => nightDay(n.s.start) === days[k]).sort((a, b) => a.s.start - b.s.start);
    // the week grid will show this day's week when the night is closed (+12 h guards against DST shifts)
    weekOffset = Math.min(0, Math.floor((days[k] + 12 * 3600e3 - weekStart(0)) / (7 * 864e5)));
    if (!still && body.animate) await body.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${-dir * 40}px)`, opacity: 0 }], { duration: 120, easing: 'ease-in' }).finished.catch(() => {});
    show(mainIndex(list));
    if (!still && body.animate) body.animate([{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'ease-out' });
  };
  const show = async (i) => {
    const seq = ++showSeq;
    if (topLayer() && topLayer().classList.contains('popmenu')) closeTop();
    closeNight();
    const src = list[i];
    $('nightTitle').textContent = fmtDate(src.s.start) + (src.live ? ' · recording' : '');
    if (list.length > 1) {
      list.forEach((n, j) => {
        const b = document.createElement('button');
        b.textContent = `${hm(n.s.start)} · ${durShort(nightEnd(n) - n.s.start)}`;
        b.className = j === i ? 'on' : '';
        b.onclick = () => show(j);
        $('nightPick').appendChild(b);
      });
    }
    const el = $('sessionTpl').content.firstElementChild.cloneNode(true);
    el.classList.add('loading');
    const ph = document.createElement('div');
    ph.className = 'night-ph';
    ph.innerHTML = NIGHT_PLACEHOLDER;
    $('nightBody').append(el, ph);
    $('nightBody').scrollTop = 0;
    const menu = el.querySelector('.s-actions');
    wireMenu(menu);
    $('nightMenu').onclick = (e) => { e.stopPropagation(); toggleMenu(menu); };
    await opened;
    if (seq !== showSeq) return;
    const view = await mountNight(el, src);
    if (seq === showSeq) nightView = view;
    else if (view) { view.destroy(); openViews.delete(view); } // another night was picked meanwhile
    el.classList.remove('loading');
    ph.classList.add('gone');
    afterTransition(ph, () => ph.remove());
  };
  show(idx);
}

(() => {
  const panel = $('nightSheet').querySelector('.sheet-panel');
  let start = null;
  panel.addEventListener('pointerdown', (e) => {
    // the graph, threshold handle, chips row, seek bar and menus have their own gestures
    start = e.target.closest('.chart-box, .cat-chips, input, .popmenu, .night-pick') ? null : { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  panel.addEventListener('pointercancel', () => { start = null; });
  panel.addEventListener('pointerup', (e) => {
    if (!start || !nightSwitch) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) nightSwitch(dx < 0 ? 1 : -1);
  });
})();

// ---------------------------------------------------------------- sound recognition
// Uses Google's YAMNet sound-event model (521 sound classes) through MediaPipe Audio, running on the phone.
// The Android app ships the model and runtime in vendor/; the web version loads them from a CDN.
const MP_VERSION = '1.2.2';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${MP_VERSION}/`;
const YAMNET_URL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const ANALYSIS_VERSION = 2; // 2: background skipped (nights analysed with v1 are redone)

// Our categories, the YAMNet labels that map to them, and how they are shown
const CATS = {
  snore: { name: 'Snoring', color: '#b48cff', re: /^(Snoring|Snort)$/ },
  gasp: { name: 'Gasp / wheeze', color: '#ff5c6c', re: /^(Gasp|Wheeze|Pant|Choking)$/ },
  cough: { name: 'Cough', color: '#ff9f43', re: /^(Cough|Throat clearing|Sneeze|Sniff|Hiccup)$/ },
  breath: { name: 'Breathing', color: '#4fd1c5', re: /^(Breathing|Sigh)$/ },
  talk: { name: 'Talking', color: '#ffd166', re: /speech|Speech|Conversation|Narration|Whispering|Babbling|Laughter|Groan|Grunt|Whimper|Shout|Yell|Crying|Humming|Singing/ },
  move: { name: 'Movement', color: '#9aa6bd', re: /Rustl|footsteps|Door|Knock|Tap|Thump|Bang|Creak|Squeak|Zipper|Scratch|Clatter|Rub|Slam|Shuffle|Clothing|Writing/i },
  other: { name: 'Other', color: '#5f6f8f', re: null },
};
const CAT_ORDER = ['snore', 'gasp', 'cough', 'talk', 'breath', 'move', 'other'];
// sleep-relevant sounds win when the model hears several things in the same second
const CAT_WEIGHT = { snore: 1.4, gasp: 1.5, cough: 1.3, talk: 1.1, breath: 1, move: 1, other: 1 };

function pickCategory(categories) {
  const top = categories[0];
  if (!top || (top.categoryName === 'Silence' && top.score > 0.5)) return null;
  let best = null;
  for (const c of categories) {
    if (c.score < 0.1) continue;
    const key = CAT_ORDER.find((k) => CATS[k].re && CATS[k].re.test(c.categoryName));
    if (!key) continue;
    const w = c.score * CAT_WEIGHT[key];
    if (!best || w > best.w) best = { c: key, p: c.score, w, l: c.categoryName };
  }
  if (best) return best;
  if (top.categoryName !== 'Silence' && top.score >= 0.3) return { c: 'other', p: top.score, l: top.categoryName };
  return null;
}

// merge per-second labels into runs: [{ s, e, c, p, l }]
function mergeRuns(wins) {
  wins.sort((a, b) => a.t - b.t);
  const runs = [];
  for (const w of wins) {
    const last = runs[runs.length - 1];
    if (last && last.c === w.c && w.t - last.e <= 1500) {
      last.e = w.t + w.d; last.n++;
      if (w.p > last.p) { last.p = w.p; last.l = w.l; }
    } else runs.push({ s: w.t, e: w.t + w.d, c: w.c, p: w.p, l: w.l, n: 1 });
  }
  // drop single uncertain seconds of background-ish sounds
  return runs.filter((r) => r.n > 1 || r.p >= 0.3 || ['gasp', 'cough', 'snore'].includes(r.c))
    .map((r) => ({ s: Math.round(r.s), e: Math.round(r.e), c: r.c, p: Math.round(r.p * 100) / 100, l: r.l }));
}

const Analyzer = {
  clf: null, loading: null,
  load() {
    if (this.clf) return Promise.resolve(this.clf);
    if (!this.loading) {
      this.loading = (async () => {
        // the Android app has the runtime and model built in; the web version loads them from the internet
        let base = 'vendor', model = 'vendor/yamnet.tflite', mod;
        try {
          if (!NATIVE) throw new Error('web');
          mod = await import('./vendor/audio_bundle.mjs');
        } catch {
          base = MP_CDN + 'wasm'; model = YAMNET_URL;
          mod = await import(MP_CDN + 'audio_bundle.mjs');
        }
        const files = await mod.FilesetResolver.forAudioTasks(base);
        this.clf = await mod.AudioClassifier.createFromOptions(files, {
          baseOptions: { modelAssetPath: model }, maxResults: 8, scoreThreshold: 0.05,
        });
        return this.clf;
      })().catch((e) => { this.loading = null; throw e; });
    }
    return this.loading;
  },

  // items: whole-night files (or clips) with { start, duration, blob | src }
  // spans: optional [[startMs, endMs], ...] to analyse (see activeSpans); everything else is skipped
  async analyze(items, onProgress, cancelled, spans = null) {
    const wins = await this.analyzeWins(items, onProgress, cancelled, spans);
    return wins && { v: ANALYSIS_VERSION, at: Date.now(), runs: mergeRuns(wins) };
  },

  // same, but returns the labelled windows (so a night can be analysed piece by piece while recording)
  // stepWins: windows per classify() call; small steps (2) are used while recording to keep audio smooth
  async analyzeWins(items, onProgress, cancelled, spans = null, stepWins = 8) {
    const clf = await this.load();
    let ctx;
    try { ctx = new OfflineAudioContext(1, 1, 16000); } catch { ctx = new OfflineAudioContext(1, 1, 22050); }
    // the parts of each file to classify, in ms relative to the file start, on YAMNet's 0.975 s window grid
    // (all parts start on the same grid, so skipping background yields exactly the windows a full pass sees)
    const W = 975;
    const plan = items.map((it) => {
      const len = it.duration * 1000;
      if (!spans) return [[0, len]];
      const out = [];
      for (const [a, b] of spans) {
        const x = Math.max(0, Math.floor((a - it.start) / W) * W), y = Math.min(len, Math.ceil((b - it.start) / W) * W);
        if (y - x < 500) continue;
        const last = out[out.length - 1];
        if (last && x <= last[1]) last[1] = Math.max(last[1], y); else out.push([x, y]);
      }
      return out;
    });
    const total = plan.reduce((n, p) => n + p.reduce((m, [a, b]) => m + (b - a), 0), 0) || 1;
    let done = 0;
    const wins = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (!plan[k].length) continue; // nothing but background in this file: don't even decode it
      if (cancelled()) return null;
      let buf;
      try {
        const ab = it.blob ? await it.blob.arrayBuffer() : await (await fetch(it.src)).arrayBuffer();
        buf = await ctx.decodeAudioData(ab);
      } catch (e) { console.warn('could not decode', it.id, e); done += plan[k].reduce((m, [a, b]) => m + (b - a), 0); continue; }
      const data = buf.getChannelData(0), rate = buf.sampleRate, win = Math.round((W / 1000) * rate), chunk = win * stepWins; // small steps keep the screen smooth
      for (const [a, b] of plan[k]) {
        const end = Math.min(data.length, Math.round((b / 1000) * rate));
        for (let off = Math.round((a / 1000) * rate); off < end; off += chunk) {
          if (cancelled()) return null;
          const part = data.subarray(off, Math.min(end, off + chunk));
          if (part.length < win / 2) { done += (part.length / rate) * 1000; break; }
          const res = clf.classify(part, rate);
          const step = res.length ? (part.length / rate) * 1000 / res.length : 975;
          res.forEach((r, i) => {
            const pick = pickCategory(r.classifications[0] ? r.classifications[0].categories : []);
            if (pick) wins.push({ t: it.start + (off / rate) * 1000 + (r.timestampMs ?? i * step), d: step, ...pick });
          });
          done += (part.length / rate) * 1000;
          onProgress(Math.min(1, done / total));
          await new Promise((r) => setTimeout(r, 0)); // keep the screen responsive
        }
      }
    }
    return wins;
  },
};

// Which parts of a night are worth classifying: every second clearly above the room's background level,
// plus 2 s on each side. Quiet background comes out as "Silence" anyway, so skipping it saves time
// without changing the result. Returns null (= analyse everything) when the night has no level data.
const GATE_DB = 2, GATE_PAD_S = 2;
function activeSpans(s) {
  const lv = s.levels || [];
  const vals = lv.filter((v) => v > 0).sort((a, b) => a - b);
  if (vals.length < 60) return null;
  const gate = vals[Math.floor(vals.length * 0.1)] + GATE_DB; // background = 10th percentile
  const spans = [];
  let cur = null;
  for (let i = 0; i < lv.length; i++) {
    if (lv[i] > 0 && lv[i] < gate) continue; // 0 = no level data for that second: analyse it to be safe
    const a = s.start + (i - GATE_PAD_S) * 1000, b = s.start + (i + 1 + GATE_PAD_S) * 1000;
    if (cur && a <= cur[1] + 1000) cur[1] = b;
    else { if (cur) spans.push(cur); cur = [a, b]; }
  }
  if (cur) spans.push(cur);
  return spans;
}

// Live recognition while recording in the browser: every finished 10-minute file is analysed in small steps
// while the recording continues; the night's analysis is updated as it goes and is complete shortly after Stop.
// (In the Android app the native recorder does this itself.)
const LiveRecog = {
  pending: new Map(), // night id -> promise that resolves when its live analysis is complete
  start(session) { return { session, wins: [], queue: Promise.resolve(), failed: false }; },
  add(L, meta, blob) {
    L.queue = L.queue.then(async () => {
      if (L.failed) return;
      try {
        const wins = await Analyzer.analyzeWins([{ ...meta, blob }], () => {}, () => false, activeSpans(L.session), 2);
        L.wins.push(...wins);
        if (L.finished) { // a file that finished after Stop: update the stored final result
          L.session.analysis = { v: ANALYSIS_VERSION, at: Date.now(), runs: mergeRuns(L.wins.slice()) };
          await DB.putSession(L.session).catch(() => {});
          return;
        }
        L.session.analysis = { v: ANALYSIS_VERSION, at: Date.now(), partial: true, runs: mergeRuns(L.wins.slice()) };
      } catch (e) {
        console.warn('live recognition stopped', e);
        L.failed = true;
        delete L.session.analysis; // the night is analysed after it ends instead
      }
    });
  },
  // after the last file is saved: finish, store the complete result
  finish(L) {
    const id = L.session.id;
    const p = L.queue.then(async () => {
      if (L.failed) return;
      L.finished = true;
      L.session.analysis = { v: ANALYSIS_VERSION, at: Date.now(), runs: mergeRuns(L.wins.slice()) };
      await DB.putSession(L.session).catch(() => {});
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  },
};

// Background recognition: one night at a time; progress can be shown by the night view and the week grid.
const Recog = {
  jobs: new Map(),          // night id -> { progress, done, result, error, listeners }
  queue: Promise.resolve(),
  // a night needs (re)analysis unless it has a complete result of the current version. A "partial" result
  // (recognised live while recording, in the browser or the Android app) counts as complete only while that
  // night is still being recorded; if the recording was cut off, the night is analysed again afterwards.
  needs: (s) => !(s.analysis && s.analysis.v === ANALYSIS_VERSION && !(s.analysis.partial && !s.live)),
  run(src, loaded) {
    const id = src.s.id;
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = { progress: 0, done: false, result: null, error: null, cancelled: false, listeners: new Set() };
    const notify = () => job.listeners.forEach((f) => { try { f(job); } catch (e) { console.warn(e); } });
    this.jobs.set(id, job);
    this.queue = this.queue.catch(() => {}).then(async () => {
      // a night just recorded in the browser may still be finishing its live analysis: use that instead
      if (LiveRecog.pending.has(id)) { await LiveRecog.pending.get(id); loaded = null; }
      if (!loaded) loaded = await src.load(); // fresh data: it may have been analysed meanwhile
      if (!Recog.needs(loaded.s)) { src.s.analysis = job.result = loaded.s.analysis; return; }
      const d = loaded;
      const items = d.segs.length ? d.segs : d.clips;
      if (job.cancelled) return;
      const res = items.length ? await Analyzer.analyze(items, (f) => { job.progress = f; notify(); }, () => job.cancelled, activeSpans(d.s)) : null;
      if (res) {
        await src.saveAnalysis(res).catch((e) => console.warn('analysis not saved', e));
        src.s.analysis = res;
      }
      job.result = res;
    }).catch((e) => { console.warn('recognition failed', e); job.error = e; })
      .finally(() => { this.jobs.delete(id); job.done = true; notify(); });
    return job;
  },
  // stop all analysis (e.g. a recording starts: it must get the CPU)
  cancelAll() {
    this.jobs.forEach((job) => { job.cancelled = true; });
  },
};

// After a night ends, recognise its sounds in the background (newest unanalysed night of the last 3 days)
function autoRecognise() {
  if (Monitor.running) return; // don't compete with a recording
  const cand = allNights
    .filter((n) => !n.live && Recog.needs(n.s) && Date.now() - n.s.start < 3 * 864e5 && ((n.s.segments || []).length || (n.s.clips || []).length))
    .sort((a, b) => b.s.start - a.s.start)[0];
  if (cand) { Recog.run(cand); renderWeek(false); }
}

// Snoring sessions: loud snores (above the night's threshold) no more than `maxGap` seconds apart
// belong to the same session.
function computeSessions(sounds, maxGapS) {
  const gap = (maxGapS || 600) * 1000, out = [];
  for (const x of sounds) {
    if (x.c !== 'snore') continue;
    const last = out[out.length - 1];
    if (last && x.s - last.e <= gap) { last.e = Math.max(last.e, x.e); last.n++; last.peak = Math.max(last.peak, x.peak); }
    else out.push({ s: x.s, e: x.e, n: 1, peak: x.peak, c: 'snore', session: true });
  }
  return out;
}

// loud sounds = runs of seconds at or above the threshold (gaps up to 3 s are joined)
function computeSounds(s, thr, runs) {
  const lv = s.levels || [], out = [];
  let cur = null;
  for (let i = 0; i < lv.length; i++) {
    if (lv[i] < thr) continue;
    const t = s.start + i * 1000;
    if (cur && t - cur.e <= 3000) { cur.e = t + 1000; cur.peak = Math.max(cur.peak, lv[i]); }
    else { if (cur) out.push(cur); cur = { s: t, e: t + 1000, peak: lv[i] }; }
  }
  if (cur) out.push(cur);
  // label each sound with the category heard most during it (runs are sorted: one pass)
  if (runs && runs.length) {
    let j = 0;
    for (const snd of out) {
      const a = snd.s - 1000, b = snd.e + 1000, tally = {};
      while (j < runs.length && runs[j].e <= a) j++;
      for (let k = j; k < runs.length && runs[k].s < b; k++) {
        const r = runs[k], ov = Math.min(r.e, b) - Math.max(r.s, a);
        if (ov > 0) tally[r.c] = (tally[r.c] || 0) + ov * CAT_WEIGHT[r.c];
      }
      let best = null;
      for (const c in tally) if (!best || tally[c] > tally[best]) best = c;
      snd.c = best;
    }
  }
  return out;
}

/*
 * Interactive graph of one night + audio player.
 * Two kinds of audio can be played:
 *   'seg'  — whole-night recording (10-minute files, played back to back)
 *   'clip' — short WAV clips saved when sound passed the threshold
 * Tap the graph: plays the whole-night recording at that moment if there is one, otherwise the clip there.
 * Drag: scroll. Pinch / wheel / +− buttons: zoom. A playhead follows playback.
 */
class NightView {
  constructor(root, s, clips, segs, src) {
    this.root = root; this.s = s; this.clips = clips; this.segs = segs; this.src = src; this.live = src.live;
    this.cv = root.querySelector('.s-chart');
    this.tip = root.querySelector('.s-tip');
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.urls = new Map();
    this.mode = null; this.cur = -1; this.tok = 0; this.loadedId = null;
    this.fixing = false; this.pendingOffset = 0;
    this.raf = 0; this.rowMark = null;
    this.selSound = null;
    this.cat = null; // category filter (null = all)
    this.thr = +(lsGet('sleepmon.thr.' + s.id) || s.settings.threshold || 60);
    this.boost = +(lsGet('sleepmon.boost') || 1);
    this.sounds = [];
    this.recalc();
    this.t0 = s.start;
    this.v0 = this.t0; this.v1 = this.tEnd();

    const q = (c) => root.querySelector(c);
    this.ui = { play: q('.p-play'), prev: q('.p-prev'), next: q('.p-next'), title: q('.p-title'),
      seek: q('.p-seek'), time: q('.p-time'), boost: q('.p-boost') };
    // volume boost for quiet sounds (x1 .. x16, with a limiter so loud parts don't distort)
    this.ui.boost.textContent = '×' + this.boost;
    this.ui.boost.onclick = () => {
      const steps = [1, 2, 4, 8, 16];
      this.boost = steps[(steps.indexOf(this.boost) + 1) % steps.length];
      lsSet('sleepmon.boost', this.boost);
      this.ui.boost.textContent = '×' + this.boost;
      this.ui.boost.classList.toggle('on', this.boost > 1);
      this.audioGraph();
    };
    this.ui.boost.classList.toggle('on', this.boost > 1);

    q('.z-in').onclick = () => this.zoomAt(this.center(), 0.5);
    q('.z-out').onclick = () => this.zoomAt(this.center(), 2);
    q('.z-all').onclick = () => { this.v0 = this.t0; this.v1 = this.tEnd(); this.requestDraw(); };
    this.ui.play.onclick = () => this.toggle();
    this.ui.prev.onclick = () => this.jump(-1);
    this.ui.next.onclick = () => this.jump(1);
    // seek bar = the whole night: drag to preview a moment, release to play from there
    const seekT = () => this.t0 + (this.ui.seek.value / 1000) * (this.tEnd() - this.t0);
    this.ui.seek.oninput = () => { this.scrubT = seekT(); this.updatePlayer(); this.requestDraw(); };
    this.ui.seek.onchange = () => {
      const t = seekT();
      this.scrubT = null;
      this.ui.seek.blur();
      this.updatePlayer();
      this.playAt(t); // (says so in the title if there is no audio at that moment)
      this.requestDraw();
    };
    this.audio.addEventListener('play', () => { this.ui.play.textContent = '⏸'; this.loop(); });
    this.audio.addEventListener('pause', () => { if (!this.fixing) this.ui.play.textContent = '▶'; this.draw(); });
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('timeupdate', () => this.updatePlayer());

    this.bindPointer();
    this.bindThreshold();
    this.onResize = () => this.requestDraw();
    window.addEventListener('resize', this.onResize);
    // the chart box can also change size without a window resize (e.g. when the lists below fill in)
    if (window.ResizeObserver) { this.ro = new ResizeObserver(this.onResize); this.ro.observe(this.cv); }
    this.counts = this.countKey();
    if (this.live) {
      // night still being recorded: pick up new clips/files/pauses and keep the graph growing
      this.lastEnd = this.v1;
      this.liveTimer = setInterval(() => {
        if (!root.isConnected || document.visibilityState !== 'visible') return;
        const end = this.tEnd(), sp = this.v1 - this.v0, atEnd = this.v1 >= this.lastEnd - 1000;
        this.lastEnd = end;
        if (atEnd) { this.v1 = end; if (this.v0 !== this.t0) this.v0 = end - sp; }
        this.reload();
      }, 5000);
    }
    this.updatePlayer();
    this.draw();
  }

  destroy() {
    this.pause();
    this.cancelled = true;
    if (this.onDestroy) this.onDestroy();
    if (this.ac) this.ac.close().catch(() => {});
    window.removeEventListener('resize', this.onResize);
    if (this.ro) this.ro.disconnect();
    clearInterval(this.liveTimer);
    this.urls.forEach((u) => URL.revokeObjectURL(u));
  }

  countKey() { return [this.clips.length, this.segs.length, this.sounds.length, this.runs().length].join(); }

  // ---- threshold, sounds and categories
  recalc() {
    this.sounds = computeSounds(this.s, this.thr, this.s.analysis && this.s.analysis.runs);
    this.sessions = computeSessions(this.sounds, settings.maxGap);
    this.version = (this.version || 0) + 1;
  }
  setThreshold(v) {
    this.thr = v;
    lsSet('sleepmon.thr.' + this.s.id, v);
    this.recalc();
    this.rowMark = null;
    if (this.onDataChanged) this.onDataChanged();
    this.requestDraw();
  }
  setCategory(c) {
    this.cat = this.cat === c ? null : c;
    this.rowMark = null;
    if (this.onDataChanged) this.onDataChanged();
    this.draw();
  }
  // what the list, the markers and prev/next work on: all loud sounds, one category, or snoring sessions
  soundList() {
    if (this.cat === 'sessions') return this.sessions;
    return this.cat ? this.sounds.filter((x) => x.c === this.cat) : this.sounds;
  }
  runs() { return (this.s.analysis && this.s.analysis.runs) || []; }
  // run (recognised sound) at time t: binary search, runs are sorted and don't overlap
  catAt(t) {
    const rs = this.runs();
    let lo = 0, hi = rs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid].e <= t) lo = mid + 1; else if (rs[mid].s > t) hi = mid - 1; else return rs[mid];
    }
    return null;
  }

  // route playback through Web Audio so it can be amplified
  audioGraph() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ac = new AC();
        const src = this.ac.createMediaElementSource(this.audio);
        this.gain = this.ac.createGain();
        const lim = this.ac.createDynamicsCompressor();
        lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.2;
        src.connect(this.gain); this.gain.connect(lim); lim.connect(this.ac.destination);
      } catch (e) { console.warn('boost unavailable', e); this.ac = null; return; }
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
    this.gain.gain.value = this.boost;
  }

  async reload() {
    let d;
    try { d = await this.src.load(); } catch { return; }
    const it = this.item();
    this.s = d.s; this.clips = d.clips; this.segs = d.segs;
    this.recalc();
    if (it) this.cur = this.list().findIndex((x) => x.id === it.id);
    if (this.cur < 0) this.mode = null;
    const key = this.countKey();
    if (key !== this.counts) { this.counts = key; if (this.onDataChanged) this.onDataChanged(); }
    this.updatePlayer();
    if (this.audio.paused) this.draw();
  }

  tEnd() { return Math.max(this.live ? Date.now() : this.s.end, this.t0 + 60000); }
  center() { return (this.v0 + this.v1) / 2; }
  width() { return this.cv.clientWidth || 300; }
  tAt(x) { return this.v0 + (x / this.width()) * (this.v1 - this.v0); }
  xOf(t) { return ((t - this.v0) / (this.v1 - this.v0)) * this.width(); }
  endOf(c) { return c.start + c.duration * 1000; }
  list(mode = this.mode) { return mode === 'seg' ? this.segs : this.clips; }
  item() { return this.mode ? this.list()[this.cur] || null : null; }
  pos() { return this.fixing ? this.pendingOffset : this.audio.currentTime || 0; }
  curT() { const it = this.item(); return it ? it.start + this.pos() * 1000 : null; }
  segAt(t) { return this.segs.findIndex((g) => t >= g.start && t < this.endOf(g)); }

  setView(v0, v1) {
    const t1 = this.tEnd(), span = Math.min(v1 - v0, t1 - this.t0);
    v0 = Math.max(this.t0, Math.min(v0, t1 - span));
    this.v0 = v0; this.v1 = v0 + span;
    this.requestDraw();
  }

  zoomAt(t, factor, base = [this.v0, this.v1]) {
    const [b0, b1] = base;
    const span = Math.max(30000, Math.min(this.tEnd() - this.t0, (b1 - b0) * factor));
    const r = (t - b0) / (b1 - b0);
    this.setView(t - r * span, t - r * span + span);
  }

  ensureVisible(t) {
    if (t >= this.v0 && t <= this.v1) return;
    const sp = this.v1 - this.v0;
    this.setView(t - sp / 2, t + sp / 2);
  }

  // ---- playback
  url(it) {
    if (it.src) return it.src; // file on the phone (Android app)
    if (!this.urls.has(it.id)) this.urls.set(it.id, URL.createObjectURL(it.blob));
    return this.urls.get(it.id);
  }

  play(i, offsetSec = 0) { this.playItem('clip', i, offsetSec); }

  // play the whole-night recording at time t if it covers t, otherwise clip `clipIdx` (if given)
  playAt(t, clipIdx = -1) {
    const gi = this.segAt(t);
    if (gi >= 0) return this.playItem('seg', gi, (t - this.segs[gi].start) / 1000);
    if (clipIdx < 0) clipIdx = this.clips.findIndex((c) => t >= c.start - 2000 && t <= this.endOf(c));
    if (clipIdx >= 0) {
      const c = this.clips[clipIdx];
      this.playItem('clip', clipIdx, t >= c.start && t <= this.endOf(c) ? (t - c.start) / 1000 : 0);
    } else {
      this.ui.title.textContent = `No audio saved at ${fmtTime(t)}`;
    }
  }

  playItem(mode, i, offset = 0) {
    const it = this.list(mode)[i];
    if (!it) return;
    openViews.forEach((v) => v !== this && v.pause());
    const a = this.audio, tok = ++this.tok;
    offset = Math.max(0, Math.min(offset, it.duration - 0.2));
    this.mode = mode; this.cur = i; this.pendingOffset = offset;
    const seekTo = () => {
      if (tok !== this.tok) return;
      if (Number.isFinite(a.duration)) { a.currentTime = offset; return; }
      // Files from MediaRecorder (webm) have no duration in their header, so the browser can't seek.
      // Jumping to the end once makes it scan the file; then seeking works.
      this.fixing = true; a.muted = true;
      const done = () => {
        if (!Number.isFinite(a.duration) || tok !== this.tok) return;
        a.removeEventListener('durationchange', done);
        a.currentTime = offset; a.muted = false; this.fixing = false;
        if (a.paused) a.play().catch(() => {});
      };
      a.addEventListener('durationchange', done);
      a.currentTime = 1e101;
    };
    if (this.loadedId !== it.id) {
      this.loadedId = it.id; this.fixing = false; a.muted = false;
      a.src = this.url(it);
      a.addEventListener('loadedmetadata', seekTo, { once: true });
    } else seekTo();
    this.audioGraph();
    a.play().catch(() => {}); // called right away so it counts as a user gesture on iPhone
    this.ensureVisible(it.start + offset * 1000);
    this.markRows();
    this.updatePlayer();
  }

  onEnded() {
    if (this.fixing) return;
    const it = this.item();
    if (!it) return;
    if (this.mode === 'seg') {
      const next = this.segs[this.cur + 1];
      // continue straight into the next 10-minute file (they overlap by a fraction of a second)
      if (next && next.start - this.endOf(it) < 5000) this.playItem('seg', this.cur + 1, Math.max(0, (this.endOf(it) - next.start) / 1000));
    }
  }

  toggle() {
    if (!this.item()) {
      if (this.segs.length) this.playAt(this.segAt(this.v0) >= 0 ? this.v0 : this.segs[0].start);
      else if (this.clips.length) this.play(0);
      return;
    }
    if (this.audio.paused) this.audio.play().catch(() => {}); else this.audio.pause();
  }

  pause() { if (!this.audio.paused) this.audio.pause(); }

  // previous / next loud sound (of the selected category)
  targetSound(dir) {
    const list = this.soundList(), t = this.curT();
    if (t === null) return dir > 0 ? list[0] || null : null;
    if (dir > 0) return list.find((x) => x.s > t + 1000) || null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].s < t - 3000) return list[i];
    return null;
  }

  jump(dir) {
    const x = this.targetSound(dir);
    if (x) this.playSound(x);
  }

  // zoom in on a sound (double tap)
  focusSound(x) {
    this.selSound = x;
    const span = Math.max(60000, (x.e - x.s) * 6), mid = (x.s + x.e) / 2;
    this.setView(mid - span / 2, mid + span / 2);
  }

  // play a sound from the list; the zoom stays as it is (the graph only slides if the sound is off-screen)
  playSound(x) {
    this.selSound = x;
    if (x.e < this.v0 || x.s > this.v1) { const sp = this.v1 - this.v0, mid = (x.s + x.e) / 2; this.setView(mid - sp / 2, mid + sp / 2); }
    this.requestDraw();
    this.playAt(Math.max(this.t0, x.s - 1500));
  }

  removeClip(c) {
    const i = this.clips.indexOf(c);
    if (i < 0) return;
    if (this.mode === 'clip') {
      if (i === this.cur) { this.stopAudio(); }
      else if (i < this.cur) this.cur--;
    }
    this.clips.splice(i, 1);
    this.revoke(c.id);
    this.updatePlayer(); this.draw();
  }

  clearSegments() {
    if (this.mode === 'seg') this.stopAudio();
    this.segs.forEach((g) => this.revoke(g.id));
    this.segs = [];
    this.version++;
    this.updatePlayer(); this.draw();
  }

  stopAudio() {
    this.pause(); this.tok++;
    this.audio.removeAttribute('src'); this.audio.load();
    this.mode = null; this.cur = -1; this.loadedId = null; this.fixing = false;
    this.markRows();
  }

  revoke(id) { if (this.urls.has(id)) { URL.revokeObjectURL(this.urls.get(id)); this.urls.delete(id); } }

  markRows() {
    const t = this.curT(), list = this.soundList();
    const idx = t === null ? -1 : list.findIndex((x) => t >= x.s - 1500 && t <= x.e + 500);
    if (idx === this.rowMark) return;
    this.rowMark = idx;
    this.root.querySelectorAll('.snd-row').forEach((r, i) => {
      r.classList.toggle('playing', i === idx);
      if (i === idx) {
        // keep the playing clip visible inside the clips window (without moving the page)
        const box = r.parentElement;
        if (r.offsetTop < box.scrollTop || r.offsetTop + r.offsetHeight > box.scrollTop + box.clientHeight) {
          box.scrollTo({ top: r.offsetTop - box.clientHeight / 2 + r.offsetHeight / 2, behavior: 'smooth' });
        }
      }
    });
  }

  updatePlayer() {
    const it = this.item(), u = this.ui;
    const hasAudio = this.clips.length || this.segs.length;
    u.prev.disabled = !this.targetSound(-1);
    u.next.disabled = !this.targetSound(1);
    u.play.disabled = !hasAudio;
    // the seek bar and its label always describe the whole night: where we are / when it ended
    const t0 = this.t0, end = this.tEnd();
    const t = this.scrubT != null ? this.scrubT : it ? this.curT() : null;
    if (this.scrubT == null) {
      const sv = String(t === null ? 0 : Math.round(Math.min(1, Math.max(0, (t - t0) / (end - t0))) * 1000));
      if (u.seek.value !== sv) u.seek.value = sv;
    }
    const tt = `${hm(t === null ? t0 : t)} / ${hm(end)}`;
    if (u.time.textContent !== tt) u.time.textContent = tt;
    let title;
    if (this.scrubT != null) title = `Release to play from ${fmtTime(t)}`;
    else if (!it) {
      title = this.segs.length ? 'Tap the graph to listen to any moment'
        : this.clips.length ? 'Tap the graph or a clip to play' : 'No audio saved this night';
    } else if (this.mode === 'seg') {
      const r = this.catAt(t);
      title = `${fmtTime(t)}` + (r ? ' · ' + (r.c === 'other' ? r.l : CATS[r.c].name) : '');
    } else {
      title = `Clip ${this.cur + 1}/${this.clips.length} · ${fmtTime(t)} · peak ${it.peak} dB`;
    }
    if (u.title.textContent !== title) u.title.textContent = title;
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (this.audio.paused && !this.fixing) return;
      const t = this.curT();
      if (t !== null && (t > this.v1 || t < this.v0)) {
        // follow the playhead when it runs off the visible part of the graph
        const sp = this.v1 - this.v0; this.setView(t - sp * 0.1, t + sp * 0.9);
      }
      this.draw(); this.updatePlayer(); this.markRows();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ---- graph interaction
  bindPointer() {
    const cv = this.cv, pts = new Map();
    let drag = null, pinch = null;
    const xy = (e) => { const r = cv.getBoundingClientRect(); return e.clientX - r.left; };

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, xy(e));
      if (pts.size === 1) drag = { x: xy(e), v0: this.v0, v1: this.v1, moved: false };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.max(20, Math.abs(a - b)), base: [this.v0, this.v1], mid: this.tAt((a + b) / 2) };
        drag = null;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const x = xy(e);
      if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse') this.showTip(x); return; }
      pts.set(e.pointerId, x);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.zoomAt(pinch.mid, pinch.d / Math.max(20, Math.abs(a - b)), pinch.base);
      } else if (drag) {
        const dx = x - drag.x;
        if (Math.abs(dx) > 6) drag.moved = true;
        if (drag.moved) {
          const dt = (-dx / this.width()) * (drag.v1 - drag.v0);
          this.setView(drag.v0 + dt, drag.v1 + dt);
          this.tip.hidden = true;
        }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (drag && !drag.moved && e.type === 'pointerup') this.tap(xy(e));
      if (pts.size < 2) pinch = null;
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pts.size) this.tip.hidden = true; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(this.tAt(xy(e)), e.deltaY > 0 ? 1.25 : 0.8);
      this.showTip(xy(e));
    }, { passive: false });
  }

  // threshold handle: drag it up/down on the right edge of the graph (its own element, so it never conflicts with pan/zoom/tap)
  bindThreshold() {
    const hd = this.root.querySelector('.thr-handle'), cv = this.cv;
    this.thrUI = { hd, lab: hd.querySelector('.thr-lab'), y: null, v: null };
    let grab = null, queued = false;
    const valAt = (clientY) => {
      const ch = cv.getBoundingClientRect().height - 18, y = clientY - cv.getBoundingClientRect().top - grab.off;
      return Math.round(Math.min(95, Math.max(30, DB_MIN + (1 - y / ch) * (DB_MAX - DB_MIN))));
    };
    hd.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      hd.setPointerCapture(e.pointerId);
      const r = cv.getBoundingClientRect();
      grab = { id: e.pointerId, off: e.clientY - r.top - yOf(this.thr, r.height - 18), v: this.thr };
      hd.classList.add('drag'); this.thrDrag = true;
      this.tip.hidden = true;
    });
    hd.addEventListener('pointermove', (e) => {
      if (!grab || e.pointerId !== grab.id) return;
      const v = valAt(e.clientY);
      if (v === grab.v) return;
      grab.v = v;
      this.placeThr(v); // handle + label follow immediately; the sounds/graph update once per frame
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; if (this.thrUI.v !== this.thr) this.setThreshold(this.thrUI.v); });
    });
    const up = (e) => {
      if (!grab || e.pointerId !== grab.id) return;
      grab = null;
      hd.classList.remove('drag'); this.thrDrag = false;
      if (this.thrUI.v !== this.thr) this.setThreshold(this.thrUI.v);
    };
    hd.addEventListener('pointerup', up);
    hd.addEventListener('pointercancel', up);
  }

  placeThr(v, ch = this.cv.clientHeight - 18) {
    const u = this.thrUI, y = Math.round(yOf(v, ch));
    if (u.v !== v) { u.v = v; u.lab.textContent = v; u.hd.setAttribute('aria-valuenow', v); }
    if (u.y !== y) { u.y = y; u.hd.style.transform = `translateY(${y}px)`; }
  }

  clipAt(x) {
    const t = this.tAt(x), pxPerMs = this.width() / (this.v1 - this.v0);
    let best = -1, bestD = 16; // px tolerance for tapping thin clips
    this.clips.forEach((c, i) => {
      const d = t < c.start ? (c.start - t) * pxPerMs : t > this.endOf(c) ? (t - this.endOf(c)) * pxPerMs : 0;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  levelAt(t) { const v = this.s.levels[Math.floor((t - this.s.start) / 1000)]; return v === undefined ? null : v; }

  showTip(x) {
    const t = this.tAt(x), lvl = this.levelAt(t);
    const ci = this.clipAt(x);
    let html = `${fmtTime(t)}${lvl !== null ? ` · ${Math.round(lvl)} dB` : ''}`;
    const r = this.catAt(t);
    if (r) html += `<br><span style="color:${CATS[r.c].color}">● ${r.c === 'other' ? r.l : CATS[r.c].name}</span>`;
    if (this.segAt(t) >= 0) html += '<br><b>Tap to listen</b>';
    else html += ci >= 0 ? `<br><b>Clip ${ci + 1}: tap to play</b>` : '<br><span class="muted">no recording here</span>';
    this.tip.innerHTML = html;
    this.tip.style.left = `${Math.max(70, Math.min(this.width() - 70, x))}px`;
    this.tip.hidden = false;
  }

  tap(x) {
    const t = this.tAt(x), now = performance.now();
    // double tap on the graph: zoom in on the sound there (or 2x around that point)
    if (this.lastTap && now - this.lastTap.at < 400 && Math.abs(x - this.lastTap.x) < 30) {
      this.lastTap = null;
      const tol = 16 * (this.v1 - this.v0) / this.width(); // a finger's width, in ms at the current zoom
      let hit = null, best = Infinity;
      for (const s of this.soundList()) { const d = t < s.s ? s.s - t : t > s.e ? t - s.e : 0; if (d <= tol && d < best) { best = d; hit = s; } }
      if (hit) this.focusSound(hit); else this.zoomAt(t, 0.5);
      return;
    }
    this.lastTap = { at: now, x };
    this.selSound = this.soundList().find((s) => t >= s.s - 1000 && t <= s.e + 1000) || null;
    const ci = this.clipAt(x);
    if (this.segAt(t) >= 0 || ci >= 0) {
      this.playAt(t, ci);
      this.tip.hidden = true;
    } else {
      this.showTip(x);
      clearTimeout(this.tipTimer);
      this.tipTimer = setTimeout(() => { this.tip.hidden = true; }, 2500);
      this.draw();
    }
  }

  // ---- drawing
  // Redraw at most once per frame (pinch, drag and the slider can fire many events per frame)
  requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; if (this.root.isConnected) this.draw(); });
  }

  // The graph itself is cached in an off-screen layer and only re-rendered when the view or data change;
  // during playback each frame just copies it and draws the playhead.
  draw() {
    const { g, w, h } = setupCanvas(this.cv);
    const key = [w, h, window.devicePixelRatio, this.v0, this.v1, this.thr, this.cat, this.selSound && this.selSound.s, this.version].join();
    if (key !== this.layerKey) { this.renderLayer(w, h); this.layerKey = key; }
    g.drawImage(this.layer, 0, 0, w, h);
    if (!this.thrDrag) this.placeThr(this.thr, h - 18);
    const t = this.scrubT != null ? this.scrubT : this.curT();
    if (t !== null) {
      const x = this.xOf(t);
      if (x >= 0 && x <= w) { g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, h - 18); }
    }
  }

  renderLayer(w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (!this.layer) this.layer = document.createElement('canvas');
    this.layer.width = Math.round(w * dpr); this.layer.height = Math.round(h * dpr);
    const g = this.layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = this.s, ch = h - 18; // bottom strip for time labels
    const y = (db) => yOf(db, ch);
    const span = this.v1 - this.v0;

    // dB grid
    g.font = '10px system-ui'; g.fillStyle = css('--muted');
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
    [40, 60, 80].forEach((db) => { g.beginPath(); g.moveTo(0, y(db)); g.lineTo(w, y(db)); g.stroke(); g.fillText(db, 2, y(db) - 2); });

    // sound level (max per pixel column)
    const lv = s.levels, n = lv.length;
    g.fillStyle = css('--accent');
    for (let px = 0; px < w; px++) {
      const a = Math.floor((this.tAt(px) - s.start) / 1000);
      const b = Math.max(a + 1, Math.ceil((this.tAt(px + 1) - s.start) / 1000));
      let m = -1;
      for (let i = Math.max(0, a); i < b && i < n; i++) if (lv[i] > m) m = lv[i];
      if (m <= 0) continue;
      const yy = y(m);
      g.fillRect(px, yy, 1, ch - yy);
    }

    // recognised sounds: colored band along the top; the selected category is also highlighted over the graph
    this.runs().forEach((r) => {
      const x0 = this.xOf(r.s), x1 = this.xOf(r.e);
      if (x1 < 0 || x0 > w) return;
      const cw = Math.max(2, x1 - x0);
      if (this.cat && r.c !== this.cat) { g.globalAlpha = 0.25; }
      g.fillStyle = CATS[r.c].color;
      g.fillRect(x0, 0, cw, 8);
      if (this.cat === r.c) { g.globalAlpha = 0.22; g.fillRect(x0, 8, cw, ch - 8); }
      g.globalAlpha = 1;
    });

    // threshold (adjustable for this night)
    g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.beginPath();
    g.moveTo(0, y(this.thr)); g.lineTo(w, y(this.thr)); g.stroke(); g.setLineDash([]);

    // loud sounds above the threshold: markers along the bottom, colored by what they are
    this.soundList().forEach((x) => {
      const x0 = this.xOf(x.s), x1 = this.xOf(x.e);
      if (x1 < 0 || x0 > w) return;
      const cw = Math.max(3, x1 - x0);
      g.fillStyle = x.c ? CATS[x.c].color : '#e6ebf5';
      if (x === this.selSound) { g.globalAlpha = 0.2; g.fillRect(x0, 8, cw, ch - 8); g.globalAlpha = 1; g.fillRect(x0, ch - 10, cw, 10); }
      else g.fillRect(x0, ch - 6, cw, 6);
    });

    // snoring sessions: purple bars just above the loud-sound markers
    if (this.cat !== 'sessions') {
      g.fillStyle = CATS.snore.color; g.globalAlpha = 0.7;
      this.sessions.forEach((x) => {
        const x0 = this.xOf(x.s), x1 = this.xOf(x.e);
        if (x1 < 0 || x0 > w) return;
        g.fillRect(x0, ch - 11, Math.max(3, x1 - x0), 3);
      });
      g.globalAlpha = 1;
    }

    // saved clips (only when there is no whole-night recording to play from)
    if (!this.segs.length) {
      g.fillStyle = css('--clip');
      this.clips.forEach((c) => {
        const x0 = this.xOf(c.start), x1 = this.xOf(this.endOf(c));
        if (x1 < 0 || x0 > w) return;
        g.fillRect(x0, ch - 13, Math.max(3, x1 - x0), 3);
      });
    }

    // time axis: pick a step that leaves ~80 px between labels
    const steps = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 1800e3, 3600e3, 7200e3];
    const stepMs = steps.find((st) => (st / span) * w >= 80) || steps[steps.length - 1];
    const showSec = stepMs < 60e3;
    g.fillStyle = css('--muted'); g.font = '10px system-ui';
    const tz = new Date(this.v0).getTimezoneOffset() * 60000;
    for (let tt = Math.ceil((this.v0 - tz) / stepMs) * stepMs + tz; tt <= this.v1; tt += stepMs) {
      const x = this.xOf(tt);
      g.fillRect(x, ch, 1, 4);
      const label = new Date(tt).toLocaleTimeString([], showSec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
      const tw = g.measureText(label).width;
      g.fillText(label, Math.max(0, Math.min(w - tw, x - tw / 2)), h - 3);
    }
  }
}

// ---------------------------------------------------------------- Android background mode
async function checkBattery(prompt) {
  if (!USE_NATIVE) return;
  try {
    const { ignoring } = await SR.batteryStatus();
    $('btnBattery').hidden = ignoring;
    if (!ignoring && prompt && !sessionStorage.getItem('sleepmon.batteryAsked')) {
      sessionStorage.setItem('sleepmon.batteryAsked', '1');
      if (confirm('To make sure Android never stops monitoring during the night, allow Sleep Monitor to run without battery restrictions?')) {
        SR.openBatterySettings();
      }
    }
  } catch {}
}
if (USE_NATIVE) $('btnBattery').onclick = () => SR.openBatterySettings();

// show what's happening: reattach to a running background recorder, otherwise show the live preview
async function refreshState() {
  if (USE_NATIVE) {
    const running = await NativeMonitor.resume().catch(() => false);
    setRunningUI(running);
    checkBattery(false);
  }
  if (!Monitor.running) startPreview();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshState();
    if (Monitor.running) keepAwake();
    renderWeek();
  } else {
    Preview.stop(); // don't hold the microphone in the background just for the meter
  }
});
// keep today's tile up to date during the night
setInterval(() => { if (Monitor.running && document.visibilityState === 'visible' && $('nightSheet').hidden) renderWeek(USE_NATIVE); }, 60000);

// ---------------------------------------------------------------- boot
fillSettings();
setRunningUI(false);
Meter.start();
renderWeek().then(() => setTimeout(autoRecognise, 3000));
refreshState();
window.addEventListener('pagehide', () => { if (WebMonitor.running) { if (WebMonitor.clip) WebMonitor.finishClip(); WebMonitor.persist(); } });
window.addEventListener('beforeunload', (e) => { if (Monitor.running && !USE_NATIVE) { Monitor.persist(); e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
