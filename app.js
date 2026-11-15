'use strict';
/*
 * Sleep Apnea Monitor
 * - Listens to the microphone and shows a live sound level (relative dB).
 * - Saves an audio clip (WAV) whenever sound goes above the threshold, including a few
 *   seconds of audio from before the sound started (pre-roll).
 * - Detects breathing pauses: regular breathing/snoring sounds, then silence for at least
 *   N seconds, then sound again. These are logged as possible apnea events.
 * - Everything is stored on the device in IndexedDB.
 */

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  threshold: 60,     // dB (relative) above which clips are saved
  preRoll: 3,        // s of audio kept before the trigger
  postRoll: 4,       // s of quiet before a clip ends
  maxClip: 60,       // s max clip length
  apneaGap: 10,      // s min breathing pause
  apneaMax: 90,      // s pauses longer than this are ignored
  breathMargin: 6,   // dB above noise floor that counts as a breath
  minBreaths: 3,     // breath sounds required in 60 s before a pause
  clipPauses: true,  // save a clip when breathing restarts after a pause
  recordAll: false,  // also record the whole night (compressed)
};
const CLIP_RATE = 16000;     // saved audio sample rate (Hz)
const LIVE_SECONDS = 60;     // live chart window
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
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sleepmon.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('sleepmon.settings', JSON.stringify(settings)); } catch {}
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
  // per-frame state
  floor: null, level: 0,
  preBuf: [], preLen: 0,
  clip: null,                 // { start, chunks, len, peak, lastLoud, tag }
  lastActive: 0, wasActive: false, inactiveSince: 0,
  bursts: [],                 // timestamps of breath/snore sound onsets
  silence: null,              // { start, breaths }
  pendingResume: null,        // event waiting to see if breathing restarted loudly
  secMax: 0, secStart: 0,     // per-second level aggregation for history chart
  live: [],                   // recent levels for live chart
  saveTimer: null,
  calibrating: null,
  onFrame: null,
  seg: null, segTimer: null,  // whole-night recording

  async start({ record = settings.recordAll } = {}) {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume();
    this.src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is deprecated but works on every browser incl. iOS Safari.
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.proc); this.proc.connect(this.sink); this.sink.connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0), this.ctx.sampleRate);

    const now = Date.now();
    this.session = {
      id: 's' + now, start: now, end: now,
      settings: { ...settings },
      levels: [],      // one value per second: max dB in that second
      events: [],      // breathing pauses
      clips: [],       // { id, start, duration, peak, tag } (audio is in the clips store)
      segments: [],    // whole-night recording: { id, start, duration, mime, size } (audio in segments store)
    };
    Object.assign(this, {
      floor: null, preBuf: [], preLen: 0, clip: null, lastActive: now, wasActive: false, inactiveSince: now,
      bursts: [], silence: null, pendingResume: null, secMax: 0, secStart: now, live: [],
    });
    this.running = true;
    await DB.putSession(this.session);
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
    const g = { rec, chunks: [], size: 0, start: Date.now(), end: 0, mime: rec.mimeType || FULL_MIME || 'audio/webm', session: this.session };
    g.done = new Promise((res) => { rec.onstop = () => this.saveSegment(g).then(res, res); });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) { g.chunks.push(e.data); g.size += e.data.size; } };
    rec.onstart = () => { g.start = Date.now(); };
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
    const meta = { id: 'g' + g.start, start: g.start, duration: +((end - g.start) / 1000).toFixed(1), mime: g.mime, size: blob.size };
    g.session.segments.push(meta);
    try {
      await DB.putSegment({ ...meta, sessionId: g.session.id, blob });
      await DB.putSession(g.session);
    } catch (e) { console.error('segment save failed', e); }
  },

  fullBytes() {
    if (!this.session) return 0;
    return this.session.segments.reduce((n, g) => n + g.size, 0) + (this.seg ? this.seg.size : 0);
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
    const now = Date.now();
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const level = toDb(Math.sqrt(sum / input.length));
    this.level = level;

    // noise floor: drops quickly, rises very slowly (follows the quiet room, not breathing)
    if (this.floor === null) this.floor = level;
    else if (level < this.floor) this.floor += (level - this.floor) * 0.3;
    else this.floor += (level - this.floor) * 0.0005;

    if (this.calibrating) { this.calibrating.push(level); }

    // live chart + per-second history
    this.live.push(level);
    const frameSec = input.length / rate;
    const maxLive = Math.ceil(LIVE_SECONDS / frameSec);
    if (this.live.length > maxLive) this.live.splice(0, this.live.length - maxLive);
    this.secMax = Math.max(this.secMax, level);
    while (now - this.secStart >= 1000) {
      this.session.levels.push(Math.round(this.secMax * 10) / 10);
      this.secMax = level; this.secStart += 1000;
    }

    const chunk = resample(input, rate, CLIP_RATE);
    this.handleClip(chunk, level, now);
    this.handleBreathing(level, now);
    if (this.onFrame) this.onFrame();
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
      this.startClip(now, 'loud');
      this.clip.chunks.push(chunk); this.clip.len += chunk.length; this.clip.peak = level;
    } else {
      this.preBuf.push(chunk); this.preLen += chunk.length;
      while (this.preBuf.length && this.preLen - this.preBuf[0].length >= s.preRoll * CLIP_RATE) {
        this.preLen -= this.preBuf.shift().length;
      }
    }
  },

  startClip(now, tag) {
    const preSec = this.preLen / CLIP_RATE;
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

  // ---- breathing pause detection
  handleBreathing(level, now) {
    const s = settings;
    const active = level >= this.floor + s.breathMargin;

    // count breath/snore onsets (sound after ≥0.7 s of quiet)
    if (active && !this.wasActive && now - this.inactiveSince >= 700) this.bursts.push(now);
    if (!active && this.wasActive) this.inactiveSince = now;
    this.wasActive = active;
    while (this.bursts.length && now - this.bursts[0] > 180000) this.bursts.shift();

    if (active) {
      if (this.silence) {
        const gap = (now - this.silence.start) / 1000;
        if (gap >= s.apneaGap && gap <= s.apneaMax && this.silence.breaths >= s.minBreaths) {
          const ev = { start: Math.round(this.silence.start), end: now, duration: +gap.toFixed(1), loudResume: false };
          this.session.events.push(ev);
          this.pendingResume = { ev, until: now + 3000 };
          if (s.clipPauses && !this.clip) {
            this.startClip(now, 'after pause');
          } else if (this.clip && this.clip.tag === 'loud') {
            this.clip.tag = 'after pause';
          }
          this.persist();
        }
        this.silence = null;
      }
      this.lastActive = now;
    } else if (!this.silence && now - this.lastActive > 1500) {
      const start = this.lastActive;
      const breaths = this.bursts.filter((t) => t <= start && start - t <= 60000).length;
      this.silence = { start, breaths };
    }

    if (this.pendingResume) {
      if (level >= s.threshold) { this.pendingResume.ev.loudResume = true; this.pendingResume = null; }
      else if (now > this.pendingResume.until) this.pendingResume = null;
    }
  },

  discard(id) { return DB.deleteSession(id); },

  calibrate(seconds = 10) {
    return new Promise((resolve) => {
      this.calibrating = [];
      setTimeout(() => {
        const vals = this.calibrating.sort((a, b) => a - b);
        this.calibrating = null;
        if (!vals.length) return resolve(null);
        const p90 = vals[Math.floor(vals.length * 0.9)];
        resolve(Math.round(p90 + 15));
      }, seconds * 1000);
    });
  },
};

// ---------------------------------------------------------------- native monitor (Android app)
// Same interface as WebMonitor, but the work happens in the native SleepService; this only polls its status.
const NativeMonitor = {
  native: true,
  running: false, level: 0, floor: null, session: null, clip: false, silence: false, seg: false,
  live: [], frameSec: 0.064, bytes: 0, calibrating: null, onFrame: null, pollTimer: null,

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
    return s ? { id: s.id, start: s.start, end: s.end, clips: { length: s.clipCount }, events: { length: s.eventCount } } : null;
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
    }, 250);
  },
  apply(st) {
    this.running = !!st.running;
    if (!st.running) { this.session = null; this.clip = false; this.silence = false; this.seg = false; return; }
    this.level = st.level; this.floor = st.floor; this.clip = st.clipActive; this.silence = st.silent;
    this.seg = st.recordAll; this.bytes = st.fullBytes; this.live = st.live || []; this.frameSec = st.frameSec || 0.064;
    this.session = { id: st.sessionId, start: st.start, clips: { length: st.clipCount }, events: { length: st.eventCount } };
    if (this.calibrating) this.calibrating.push(st.level);
    if (this.onFrame) this.onFrame();
  },
  fullBytes() { return this.bytes; },
  setRecordAll(on) {
    if (this.running) SR.update({ settings: { ...settings, recordAll: on } }).catch(() => {});
    return Promise.resolve();
  },
  persist() {},
  discard(id) { return SR.deleteSession({ id }); },
  calibrate: WebMonitor.calibrate,
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
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DB_MIN = 20, DB_MAX = 100;
const yOf = (db, h) => h - ((Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * h;

// ---------------------------------------------------------------- live level preview
// The meter and graph work as soon as the app opens (before Start). Nothing is recorded in preview.
const Preview = {
  on: false, level: 0, floor: null, live: [], frameSec: 0.085, onFrame: null, starting: null,
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
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
      proc.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0));
      Object.assign(this, { ctx, stream, src, proc, sink, on: true, live: [], floor: null, frameSec: 4096 / ctx.sampleRate });
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
    try { this.proc.disconnect(); this.src.disconnect(); this.sink.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    this.ctx.close().catch(() => {});
  },
  process(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const level = toDb(Math.sqrt(sum / input.length));
    this.level = level;
    if (this.floor === null) this.floor = level;
    else if (level < this.floor) this.floor += (level - this.floor) * 0.3;
    else this.floor += (level - this.floor) * 0.0005;
    this.live.push(level);
    const max = Math.ceil(LIVE_SECONDS / this.frameSec);
    if (this.live.length > max) this.live.splice(0, this.live.length - max);
    if (this.onFrame) this.onFrame();
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

function drawLive() {
  const m = levelSource();
  const { g, w, h } = setupCanvas($('liveChart'));
  g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.beginPath();
  const ty = yOf(settings.threshold, h); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
  if (m.floor !== null && m.floor !== undefined) {
    g.strokeStyle = css('--muted'); g.globalAlpha = 0.5; g.beginPath();
    const fy = yOf(m.floor + settings.breathMargin, h); g.moveTo(0, fy); g.lineTo(w, fy); g.stroke(); g.globalAlpha = 1;
  }
  const data = m.live || [];
  if (!data.length) return;
  const frameSec = m.frameSec || 4096 / (m.ctx ? m.ctx.sampleRate : 48000);
  const step = w / Math.ceil(LIVE_SECONDS / frameSec), x0 = w - data.length * step;
  g.strokeStyle = Monitor.running ? css('--accent') : css('--muted'); g.lineWidth = 1.5; g.beginPath();
  data.forEach((v, i) => { const x = x0 + i * step, y = yOf(v, h); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}

let lastUi = 0, calib = null, lastSaved = '';
function onLevelFrame() {
  const now = performance.now();
  if (now - lastUi < 100) return;
  lastUi = now;
  const m = levelSource(), s = Monitor.running ? Monitor.session : null;
  if (calib) calib.push(m.level);
  $('levelNow').textContent = Number.isFinite(m.level) ? m.level.toFixed(0) : '--';
  $('meterBar').style.width = `${((Math.min(DB_MAX, Math.max(DB_MIN, m.level || 0)) - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
  if (m.floor !== null && m.floor !== undefined) {
    $('meterFloor').style.left = `${((Math.max(DB_MIN, m.floor + settings.breathMargin) - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
  }
  let state, info;
  if (calib) { state = 'Stay quiet…'; info = 'Measuring the room for 10 s'; }
  else if (s) {
    state = Monitor.clip ? '● Recording sound' : Monitor.silence ? 'Quiet' : 'Monitoring';
    const el = Date.now() - s.start;
    info = `${fmtDur(el)} · ${s.events.length} pauses · ${s.clips.length} clips` + (Monitor.seg ? ' · rec all' : '');
    $('nightInfo').textContent = `${s.clips.length} clips · ${s.events.length} pauses`;
  } else { state = 'Live level'; info = lastSaved || 'Not recording · tap Start'; }
  $('stState').textContent = state;
  $('stState').style.color = s && Monitor.clip ? css('--danger') : '';
  $('stInfo').textContent = info;
  updateRecordAllInfo();
  if ($('nightOverlay').hidden && $('nightSheet').hidden) drawLive();
}
Monitor.onFrame = onLevelFrame;
Preview.onFrame = onLevelFrame;

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
      if (s) lastSaved = `Saved ${fmtDur(s.end - s.start)} · ${s.events.length} pauses · ${s.clips.length} clips`;
      startPreview();
      renderWeek();
    }
  } finally {
    b.disabled = false;
  }
};

// monitoring was stopped from the notification's Stop button
function onStoppedElsewhere() {
  setRunningUI(false);
  startPreview();
  renderWeek();
}

$('btnCalibrate').onclick = async () => {
  closeSheets();
  if (!Monitor.running && !Preview.on) {
    try { await Preview.start(); } catch (e) { alert('Microphone error: ' + e.message); return; }
  }
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

// ---------------------------------------------------------------- sheets (⋮ menu, night detail)
// Opening a sheet adds a history entry, so the phone's Back button closes it.
function openSheet(sh) {
  if (!sh.hidden) return;
  sh.hidden = false;
  history.pushState({ sheet: sh.id }, '');
}
function hideSheet(sh) {
  if (sh.hidden) return;
  sh.hidden = true;
  if (sh.id === 'nightSheet') { closeNight(); renderWeek(); }
}
function closeSheets() {
  const open = [...document.querySelectorAll('.sheet')].filter((s) => !s.hidden);
  if (open.length && history.state && history.state.sheet) history.back();
  else open.forEach(hideSheet);
}
window.addEventListener('popstate', () => document.querySelectorAll('.sheet').forEach(hideSheet));
document.querySelectorAll('.sheet').forEach((sh) => {
  sh.addEventListener('click', (e) => { if (e.target === sh) closeSheets(); });
  sh.querySelector('.sheet-close').onclick = closeSheets;
});
$('btnMenu').onclick = () => { openSheet($('menuSheet')); updateStorageInfo(); };

async function updateStorageInfo() {
  let text = '';
  if (USE_NATIVE) {
    const bytes = allNights.reduce((n, src) => n + (src.s.bytes || 0), 0);
    text = `${fmtMB(bytes)} of recordings on this phone`;
  } else if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    text = `${(usage / 1e6).toFixed(1)} MB used of ${(quota / 1e9).toFixed(1)} GB`;
  }
  $('storageInfo').textContent = text;
}

// ---------------------------------------------------------------- settings
const FIELDS = {
  setThreshold: 'threshold', setPreRoll: 'preRoll', setPostRoll: 'postRoll', setMaxClip: 'maxClip',
  setApneaGap: 'apneaGap', setApneaMax: 'apneaMax', setBreathMargin: 'breathMargin', setMinBreaths: 'minBreaths',
};
function fillSettings() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = settings[key];
  $('setClipPauses').checked = settings.clipPauses;
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
$('setClipPauses').onchange = (e) => { settings.clipPauses = e.target.checked; saveSettings(); };
$('btnResetSettings').onclick = () => { settings = { ...DEFAULTS }; saveSettings(); Monitor.setRecordAll(settings.recordAll); fillSettings(); };

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
    deleteSession: () => SR.deleteSession({ id: s.id }),
    save: (items) => SR.share({ files: items.map((i) => ({ path: i.item.path, name: i.name })) }).catch((e) => alert(e.message)),
  };
  return src;
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
const segBytes = (s) => (s.segments || []).reduce((n, g) => n + (g.size || 0), 0);

async function mountNight(el, src) {
  const live = src.live;
  let view = null;
  const meta = () => {
    const s = view.s;
    const dur = (live ? Date.now() : s.end) - s.start;
    const longest = s.events.reduce((m, e) => Math.max(m, e.duration), 0);
    return `${fmtDur(dur)} · ${s.events.length} pauses (${rate(s.events.length, dur)}/h)` +
      (longest ? ` · longest ${longest}s` : '') + (view.segs.length ? ` · full ${fmtMB(segBytes(s))}` : '');
  };
  let d;
  try { d = await src.load(); } catch (e) { alert('Could not open this night: ' + e.message); return null; }
  view = new NightView(el, d.s, d.clips, d.segs, src);
  openViews.add(view);

  const renderSummary = () => {
    el.querySelector('.s-meta').textContent = meta();
    el.querySelector('.n-ev').textContent = view.s.events.length;
    el.querySelector('.n-cl').textContent = view.clips.length;
    el.querySelector('.btn-dlfull').hidden = !view.segs.length;
    el.querySelector('.btn-delfull').hidden = !view.segs.length || live;
  };

  // breathing pauses: tap to zoom the graph there and play the sound
  const evBox = el.querySelector('.s-events');
  const renderEvents = () => {
    const s = view.s;
    evBox.innerHTML = s.events.length ? '' : '<p class="muted empty">No breathing pauses detected.</p>';
    s.events.forEach((e) => {
      const d = document.createElement('div');
      d.className = 'list-item clickable';
      d.innerHTML = `<span>${fmtTime(e.start)}</span><b>${e.duration}s</b>` +
        (e.loudResume ? '<span class="tag">gasp</span>' : '') + '<span class="grow"></span><span class="muted">▶</span>';
      d.onclick = () => view.focusEvent(e);
      evBox.appendChild(d);
    });
  };

  // clips: tap a row to play it
  const clipBox = el.querySelector('.s-clips');
  const renderClips = () => {
    const clips = view.clips;
    clipBox.innerHTML = clips.length ? '' : '<p class="muted empty">No sounds above the threshold.</p>';
    clips.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'list-item clickable clip-row';
      d.innerHTML = `<span>${fmtTime(c.start)}</span><span>${c.duration}s</span><span class="muted">${c.peak} dB</span>` +
        (c.tag === 'after pause' ? '<span class="tag">after pause</span>' : '') +
        `<span class="grow"></span><button class="dl" aria-label="Download">⬇</button><button class="rm danger" aria-label="Delete">✕</button>`;
      d.onclick = (ev) => { if (!ev.target.closest('button')) view.play(i); };
      d.querySelector('.dl').onclick = () => src.save([{ item: c, name: `sleep_${fileStamp(c.start)}.wav` }]);
      d.querySelector('.rm').onclick = async () => {
        if (!confirm('Delete this clip?')) return;
        await src.deleteClip(c);
        view.removeClip(c);
        renderClips(); renderSummary();
      };
      clipBox.appendChild(d);
    });
    view.rowMark = null;
    view.markRows();
  };
  view.onDataChanged = () => { renderClips(); renderEvents(); renderSummary(); };
  view.onDataChanged();

  // pauses / clips tabs (the list scrolls inside its box; the screen itself doesn't scroll)
  const tabEv = el.querySelector('.tab-ev'), tabCl = el.querySelector('.tab-cl');
  const showTab = (clipsTab) => {
    tabEv.classList.toggle('on', !clipsTab); tabCl.classList.toggle('on', clipsTab);
    evBox.hidden = clipsTab; clipBox.hidden = !clipsTab;
  };
  tabEv.onclick = () => showTab(false);
  tabCl.onclick = () => showTab(true);
  showTab(!view.s.events.length && view.clips.length > 0);

  // "All" = play every clip one after another
  const allBtn = el.querySelector('.p-allbtn'), allBox = el.querySelector('.p-all');
  allBtn.onclick = () => { allBox.checked = !allBox.checked; allBtn.classList.toggle('on', allBox.checked); };

  // actions live in the ⋮ menu of the night screen
  const actions = el.querySelector('.s-actions');
  $('nightMenu').onclick = (e) => { e.stopPropagation(); actions.hidden = !actions.hidden; };
  actions.addEventListener('click', () => { actions.hidden = true; });
  el.addEventListener('click', (e) => { if (!actions.hidden && !actions.contains(e.target)) actions.hidden = true; });

  el.querySelector('.btn-csv').onclick = () => {
    const s = view.s;
    const rows = [['type', 'start', 'end', 'duration_s', 'peak_db', 'note']];
    s.events.forEach((e) => rows.push(['pause', new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.duration, '', e.loudResume ? 'loud resume' : '']));
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
const rateClass = (r) => (r < 5 ? 'r1' : r < 15 ? 'r2' : r < 30 ? 'r3' : 'r4');

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
  // breathing pauses: short ticks along the top
  g.fillStyle = css('--warn');
  (s.events || []).forEach((e) => g.fillRect(((e.start - s.start) / total) * w, 0, 1, Math.max(3, h * 0.18)));
}

async function renderWeek(reload = true) {
  if (reload) await loadNights();
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
      const dur = nightEnd(main) - main.s.start, n = main.s.events.length;
      const r = dur >= 600000 ? n / (dur / 3600e3) : null;
      html += `<div class="t-time">${hm(main.s.start)}</div><canvas></canvas>` +
        `<div class="t-time">${durShort(dur)}</div>` +
        `<div class="t-rate ${r === null ? '' : rateClass(r)}">${r === null ? '–' : `${r.toFixed(1)}/h`}</div>`;
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
  const pauses = inWeek.reduce((t, n) => t + n.s.events.length, 0);
  const nights = new Set(inWeek.map((n) => nightDay(n.s.start))).size;
  const avg = hours >= 1 / 6 ? pauses / hours : null;
  sum.innerHTML = `<div class="t-day"><span>Week</span></div>` +
    `<div><b>${nights}</b> night${nights === 1 ? '' : 's'}</div>` +
    `<div class="muted">${hours ? `${(hours / Math.max(1, nights)).toFixed(1)} h avg` : '—'}</div>` +
    `<div class="t-time">pauses/h</div>` +
    `<div class="t-rate ${avg === null ? '' : rateClass(avg)}"><b>${avg === null ? '–' : avg.toFixed(1)}</b></div>`;
  grid.appendChild(sum);
  requestAnimationFrame(() => sparks.forEach(([cv, src]) => drawSpark(cv, src)));
}

$('weekPrev').onclick = () => { weekOffset--; renderWeek(false); };
$('weekNext').onclick = () => { if (weekOffset < 0) { weekOffset++; renderWeek(false); } };
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
window.addEventListener('resize', () => renderWeek(false));

// ---------------------------------------------------------------- one night (full screen)
function closeNight() {
  if (nightView) { nightView.destroy(); openViews.delete(nightView); nightView = null; }
  $('nightBody').innerHTML = '';
  $('nightPick').innerHTML = '';
}

function openNight(list, idx) {
  openSheet($('nightSheet'));
  const show = async (i) => {
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
    $('nightBody').appendChild(el);
    $('nightBody').scrollTop = 0;
    nightView = await mountNight(el, src);
  };
  show(idx);
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
    this.selEvent = null; this.raf = 0; this.rowMark = null;
    this.t0 = s.start;
    this.v0 = this.t0; this.v1 = this.tEnd();

    const q = (c) => root.querySelector(c);
    this.ui = { play: q('.p-play'), prev: q('.p-prev'), next: q('.p-next'), title: q('.p-title'),
      seek: q('.p-seek'), time: q('.p-time'), all: q('.p-all'), zlabel: q('.z-label') };

    q('.z-in').onclick = () => this.zoomAt(this.center(), 0.5);
    q('.z-out').onclick = () => this.zoomAt(this.center(), 2);
    q('.z-all').onclick = () => { this.v0 = this.t0; this.v1 = this.tEnd(); this.draw(); };
    this.ui.play.onclick = () => this.toggle();
    this.ui.prev.onclick = () => this.jump(-1);
    this.ui.next.onclick = () => this.jump(1);
    this.ui.seek.oninput = () => {
      const it = this.item();
      if (it && !this.fixing) this.audio.currentTime = (this.ui.seek.value / 1000) * it.duration;
      this.draw();
    };
    this.audio.addEventListener('play', () => { this.ui.play.textContent = '⏸'; this.loop(); });
    this.audio.addEventListener('pause', () => { if (!this.fixing) this.ui.play.textContent = '▶'; this.draw(); });
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('timeupdate', () => this.updatePlayer());

    this.bindPointer();
    this.onResize = () => { if (root.isConnected) this.draw(); };
    window.addEventListener('resize', this.onResize);
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
    window.removeEventListener('resize', this.onResize);
    clearInterval(this.liveTimer);
    this.urls.forEach((u) => URL.revokeObjectURL(u));
  }

  countKey() { return [this.clips.length, this.segs.length, this.s.events.length].join(); }

  async reload() {
    let d;
    try { d = await this.src.load(); } catch { return; }
    const it = this.item();
    this.s = d.s; this.clips = d.clips; this.segs = d.segs;
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
    this.draw();
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
    if (clipIdx >= 0) {
      const c = this.clips[clipIdx];
      this.playItem('clip', clipIdx, t >= c.start && t <= this.endOf(c) ? (t - c.start) / 1000 : 0);
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
    } else if (this.ui.all.checked && this.cur < this.clips.length - 1) {
      this.playAt(this.clips[this.cur + 1].start, this.cur + 1);
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

  // previous / next loud sound (clip). With a whole-night recording, play it in context from there.
  targetClip(dir) {
    const t = this.curT();
    if (t === null) return dir > 0 ? (this.clips.length ? 0 : -1) : -1;
    if (dir > 0) return this.clips.findIndex((c) => c.start > t + 1000);
    for (let i = this.clips.length - 1; i >= 0; i--) if (this.clips[i].start < t - 3000) return i;
    return -1;
  }

  jump(dir) {
    const i = this.targetClip(dir);
    if (i >= 0) this.playAt(this.clips[i].start, i);
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
    let idx = -1;
    if (this.mode === 'clip') idx = this.cur;
    else if (this.mode === 'seg') { const t = this.curT(); idx = this.clips.findIndex((c) => t >= c.start && t <= this.endOf(c)); }
    if (idx === this.rowMark) return;
    this.rowMark = idx;
    this.root.querySelectorAll('.clip-row').forEach((r, i) => r.classList.toggle('playing', i === idx));
  }

  updatePlayer() {
    const it = this.item(), u = this.ui;
    const hasAudio = this.clips.length || this.segs.length;
    u.prev.disabled = this.targetClip(-1) < 0;
    u.next.disabled = this.targetClip(1) < 0;
    u.play.disabled = !hasAudio;
    if (!it) {
      u.title.textContent = this.segs.length ? 'Tap the graph to listen to any moment'
        : this.clips.length ? 'Tap the graph or a clip to play' : 'No audio saved this night';
      u.seek.value = 0; u.time.textContent = '0:00';
      return;
    }
    const at = this.pos(), t = this.curT();
    if (this.mode === 'seg') {
      const ev = this.s.events.find((e) => t >= e.start && t <= e.end);
      const loud = this.clips.some((c) => t >= c.start && t <= this.endOf(c));
      u.title.textContent = `Whole night · ${fmtTime(t)}` + (ev ? ' · breathing pause' : loud ? ' · loud sound' : '');
    } else {
      u.title.textContent = `Clip ${this.cur + 1}/${this.clips.length} · ${fmtTime(t)} · peak ${it.peak} dB` +
        (it.tag === 'after pause' ? ' · after pause' : '');
    }
    u.seek.value = it.duration ? Math.round((at / it.duration) * 1000) : 0;
    u.time.textContent = `${fmtClock(at)} / ${fmtClock(it.duration)}`;
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

  focusEvent(e) {
    this.selEvent = e;
    const span = Math.max(120000, e.duration * 1000 * 5);
    this.setView((e.start + e.end) / 2 - span / 2, (e.start + e.end) / 2 + span / 2);
    if (this.segAt(e.start) >= 0) {
      this.playAt(Math.max(e.start - 5000, this.t0)); // whole night: hear the last breaths, the silence and the restart
    } else {
      // play the sound when breathing restarted (or the closest clip around the pause)
      let best = -1, bestD = Infinity;
      this.clips.forEach((c, i) => {
        if (c.start > e.end + 30000 || this.endOf(c) < e.start - 30000) return;
        const d = Math.abs(c.start - e.end) - (c.tag === 'after pause' ? 5000 : 0);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best >= 0) this.play(best, Math.max(0, (e.end - 5000 - this.clips[best].start) / 1000));
    }
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
    const ev = this.s.events.find((e) => t >= e.start && t <= e.end);
    const ci = this.clipAt(x);
    let html = `${fmtTime(t)}${lvl !== null ? ` · ${Math.round(lvl)} dB` : ''}`;
    if (ev) html += `<br>Breathing pause ${ev.duration}s`;
    if (this.segAt(t) >= 0) html += '<br><b>Tap to listen</b>';
    else html += ci >= 0 ? `<br><b>Clip ${ci + 1}: tap to play</b>` : '<br><span class="muted">no recording here</span>';
    this.tip.innerHTML = html;
    this.tip.style.left = `${Math.max(70, Math.min(this.width() - 70, x))}px`;
    this.tip.hidden = false;
  }

  tap(x) {
    const t = this.tAt(x);
    this.selEvent = this.s.events.find((e) => t >= e.start && t <= e.end) || null;
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
  draw() {
    const { g, w, h } = setupCanvas(this.cv);
    const s = this.s, ch = h - 18; // bottom strip for time labels
    const y = (db) => yOf(db, ch);
    const span = this.v1 - this.v0;
    this.ui.zlabel.textContent = `${fmtTime(this.v0)} – ${fmtTime(this.v1)}`;

    // dB grid
    g.font = '10px system-ui'; g.fillStyle = css('--muted');
    g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 1;
    [40, 60, 80].forEach((db) => { g.beginPath(); g.moveTo(0, y(db)); g.lineTo(w, y(db)); g.stroke(); g.fillText(db, 2, y(db) - 2); });

    // sound level (max per pixel column)
    const n = s.levels.length;
    g.fillStyle = css('--accent');
    for (let px = 0; px < w; px++) {
      const a = Math.floor((this.tAt(px) - s.start) / 1000);
      const b = Math.max(a + 1, Math.ceil((this.tAt(px + 1) - s.start) / 1000));
      let m = -1;
      for (let i = Math.max(0, a); i < b && i < n; i++) m = Math.max(m, s.levels[i]);
      if (m < 0) continue;
      const yy = y(m);
      g.fillRect(px, yy, 1, ch - yy);
    }

    // breathing pauses (drawn over the level so they stay visible)
    s.events.forEach((e) => {
      const x0 = this.xOf(e.start), x1 = this.xOf(e.end);
      if (x1 < 0 || x0 > w) return;
      g.fillStyle = e === this.selEvent ? 'rgba(255,138,101,.75)' : 'rgba(255,138,101,.55)';
      g.fillRect(x0, 0, Math.max(2, x1 - x0), ch);
    });

    // threshold
    g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.beginPath();
    g.moveTo(0, y(s.settings.threshold)); g.lineTo(w, y(s.settings.threshold)); g.stroke(); g.setLineDash([]);

    // whole-night recording coverage: green strip along the top
    g.fillStyle = css('--ok');
    this.segs.forEach((sg) => {
      const x0 = this.xOf(sg.start), x1 = this.xOf(this.endOf(sg));
      if (x1 < 0 || x0 > w) return;
      g.fillRect(x0, 0, Math.max(1, x1 - x0), 4);
    });

    // clips
    const clipCol = css('--clip');
    this.clips.forEach((c, i) => {
      const x0 = this.xOf(c.start), x1 = this.xOf(this.endOf(c));
      if (x1 < 0 || x0 > w) return;
      const cw = Math.max(3, x1 - x0);
      if (this.mode === 'clip' && i === this.cur) {
        g.fillStyle = 'rgba(242,201,76,.18)'; g.fillRect(x0, 0, cw, ch);
        g.fillStyle = clipCol; g.fillRect(x0, ch - 10, cw, 10);
      } else {
        g.fillStyle = clipCol; g.fillRect(x0, ch - 6, cw, 6);
      }
    });

    // playhead
    const t = this.curT();
    if (t !== null) {
      const x = this.xOf(t);
      if (x >= 0 && x <= w) { g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, ch); }
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
setInterval(() => { if (Monitor.running && document.visibilityState === 'visible' && $('nightSheet').hidden) renderWeek(); }, 60000);

// ---------------------------------------------------------------- boot
fillSettings();
setRunningUI(false);
drawLive();
renderWeek();
refreshState();
window.addEventListener('beforeunload', (e) => { if (Monitor.running && !USE_NATIVE) { Monitor.persist(); e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
