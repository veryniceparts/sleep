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
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sleepmon.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('sleepmon.settings', JSON.stringify(settings)); } catch {}
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
const Monitor = {
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
    if (this.seg) { const g = this.seg; this.seg = null; await this.endSegment(g); }
    if (this.clip) await this.finishClip();
    try { this.proc.disconnect(); this.src.disconnect(); this.sink.disconnect(); } catch {}
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close().catch(() => {});
    this.session.end = Date.now();
    await this.persist();
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
    return DB.putClip({ ...meta, sessionId: this.session.id, blob })
      .then(() => this.persist())
      .catch((e) => console.error('clip save failed', e));
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

// ---------------------------------------------------------------- UI helpers
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const rate = (n, ms) => (ms >= 600000 ? (n / (ms / 3600000)).toFixed(1) : '–');
const fileStamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };

// Running inside the Android app (Capacitor) rather than a browser?
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const plugin = (name) => (NATIVE && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null);

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

// ---------------------------------------------------------------- monitor UI
let wakeLock = null;
async function keepAwake() {
  const ka = plugin('KeepAwake');
  if (ka) { ka.keepAwake().catch(() => {}); return; }
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function allowSleep() {
  const ka = plugin('KeepAwake');
  if (ka) ka.allowSleep().catch(() => {});
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Monitor.running) keepAwake();
});

function updateThresholdUI() {
  $('thresholdVal').textContent = settings.threshold;
  $('thresholdQuick').value = settings.threshold;
  $('setThreshold').value = settings.threshold;
  $('meterThreshold').style.left = `${((settings.threshold - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
}

function drawLive() {
  const cv = $('liveChart');
  const { g, w, h } = setupCanvas(cv);
  const data = Monitor.live;
  g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.beginPath();
  const ty = yOf(settings.threshold, h); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
  if (Monitor.floor !== null) {
    g.strokeStyle = css('--muted'); g.globalAlpha = 0.5; g.beginPath();
    const fy = yOf(Monitor.floor + settings.breathMargin, h); g.moveTo(0, fy); g.lineTo(w, fy); g.stroke(); g.globalAlpha = 1;
  }
  if (!data.length) return;
  const maxN = Math.ceil(LIVE_SECONDS / (4096 / (Monitor.ctx ? Monitor.ctx.sampleRate : 48000)));
  const step = w / maxN, x0 = w - data.length * step;
  g.strokeStyle = css('--accent'); g.lineWidth = 1.5; g.beginPath();
  data.forEach((v, i) => { const x = x0 + i * step, y = yOf(v, h); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}

let lastUi = 0;
Monitor.onFrame = () => {
  const now = performance.now();
  if (now - lastUi < 100) return;
  lastUi = now;
  const s = Monitor.session;
  $('levelNow').textContent = Monitor.level.toFixed(0);
  $('meterBar').style.width = `${((Math.min(DB_MAX, Math.max(DB_MIN, Monitor.level)) - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
  $('meterFloor').style.left = `${((Math.max(DB_MIN, Monitor.floor + settings.breathMargin) - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%`;
  $('stState').textContent = Monitor.calibrating ? 'Calibrating…' : Monitor.clip ? '● Recording' : Monitor.silence ? 'Quiet' : 'Listening';
  $('stState').style.color = Monitor.clip ? css('--danger') : '';
  if (s) {
    const el = Date.now() - s.start;
    $('stElapsed').textContent = fmtDur(el);
    $('stClips').textContent = s.clips.length + (Monitor.clip ? ' +1' : '');
    $('stEvents').textContent = s.events.length;
    $('stRate').textContent = rate(s.events.length, el);
    $('nightInfo').textContent = `${s.clips.length} clips · ${s.events.length} pauses` + (Monitor.seg ? ' · recording all' : '');
  }
  updateRecordAllInfo();
  $('stFloor').textContent = Monitor.floor === null ? '–' : `${Monitor.floor.toFixed(0)} dB`;
  if (!$('monitor').classList.contains('active') || !$('nightOverlay').hidden) return;
  drawLive();
};

$('btnStart').onclick = async () => {
  try {
    await Monitor.start();
  } catch (e) {
    alert('Could not access the microphone: ' + e.message + '\n\nThe page must be opened over https (or localhost) and microphone permission must be allowed.');
    return;
  }
  keepAwake();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  $('btnStart').hidden = true; $('btnStop').hidden = false; $('btnNight').disabled = false;
};

$('btnStop').onclick = async () => {
  $('btnStop').disabled = true;
  const s = await Monitor.stop();
  $('btnStop').disabled = false; $('btnStop').hidden = true; $('btnStart').hidden = false; $('btnNight').disabled = true;
  $('stState').textContent = 'Stopped'; $('stState').style.color = '';
  allowSleep();
  if (s) alert(`Saved: ${fmtDur(s.end - s.start)}, ${s.clips.length} clips, ${s.events.length} breathing pauses.\nSee the History tab.`);
};

$('btnCalibrate').onclick = async () => {
  const startedHere = !Monitor.running;
  if (startedHere) {
    try { await Monitor.start({ record: false }); } catch (e) { alert('Microphone error: ' + e.message); return; }
  }
  $('btnCalibrate').disabled = true; $('btnCalibrate').textContent = 'Stay quiet… measuring 10 s';
  const t = await Monitor.calibrate(10);
  if (startedHere) {
    // discard the throw-away calibration session
    const s = await Monitor.stop();
    if (s) await DB.deleteSession(s.id);
    $('stState').textContent = 'Idle';
  }
  $('btnCalibrate').disabled = false; $('btnCalibrate').textContent = 'Auto-set threshold (10 s quiet room)';
  if (t !== null) {
    settings.threshold = Math.min(100, Math.max(20, t)); saveSettings(); updateThresholdUI();
    alert(`Threshold set to ${settings.threshold} dB (room level + 15 dB). Adjust with the slider if needed.`);
  }
};

function updateRecordAllInfo() {
  const el = $('recordAllInfo');
  if (FULL_MIME === null) { el.textContent = 'Whole-night recording is not supported by this browser.'; return; }
  if (!Monitor.running) { el.textContent = settings.recordAll ? 'Will record the whole night when you start.' : ''; return; }
  const bytes = Monitor.fullBytes();
  el.textContent = Monitor.seg ? `● Recording the whole night${bytes ? ` · ${fmtMB(bytes)} so far` : ''}`
    : (bytes ? `Whole-night recording paused · ${fmtMB(bytes)} saved` : '');
}
$('recordAll').onchange = (e) => {
  settings.recordAll = e.target.checked; saveSettings();
  Monitor.setRecordAll(settings.recordAll);
  updateRecordAllInfo();
};

$('thresholdQuick').oninput = (e) => { settings.threshold = +e.target.value; saveSettings(); updateThresholdUI(); };

// night mode: black screen, double-tap to exit
let nightClockTimer;
$('btnNight').onclick = () => {
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

// ---------------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === b.dataset.tab));
    if (b.dataset.tab === 'history') renderHistory();
  };
});

// ---------------------------------------------------------------- settings UI
const FIELDS = {
  setThreshold: 'threshold', setPreRoll: 'preRoll', setPostRoll: 'postRoll', setMaxClip: 'maxClip',
  setApneaGap: 'apneaGap', setApneaMax: 'apneaMax', setBreathMargin: 'breathMargin', setMinBreaths: 'minBreaths',
};
function fillSettings() {
  for (const [id, key] of Object.entries(FIELDS)) $(id).value = settings[key];
  $('setClipPauses').checked = settings.clipPauses;
  $('recordAll').checked = settings.recordAll;
  $('recordAll').disabled = FULL_MIME === null;
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

async function renderHistory() {
  openViews.forEach((v) => v.destroy());
  openViews.clear();
  const list = $('sessionList');
  const sessions = (await DB.getSessions()).sort((a, b) => b.start - a.start);
  list.innerHTML = '';
  if (!sessions.length) { list.innerHTML = '<p class="muted">No recordings yet. Start monitoring on the Monitor tab.</p>'; }
  for (const s of sessions) list.appendChild(renderSession(s));
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    $('storageInfo').textContent = `${(usage / 1e6).toFixed(1)} MB used of ${(quota / 1e9).toFixed(1)} GB`;
  }
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
const segBytes = (s) => (s.segments || []).reduce((n, g) => n + (g.size || 0), 0);

function renderSession(s) {
  const el = $('sessionTpl').content.firstElementChild.cloneNode(true);
  const live = Monitor.session && Monitor.session.id === s.id;
  if (live) s = Monitor.session; // show the latest data of a night still being recorded
  if (!s.segments) s.segments = [];
  const meta = () => {
    const dur = (live ? Date.now() : s.end) - s.start;
    const full = s.segments.length ? ` · full recording ${fmtMB(segBytes(s))}` : '';
    return `${fmtDur(dur)} · ${s.clips.length} clips · ${s.events.length} pauses · ${rate(s.events.length, dur)} pauses/h${full}`;
  };
  el.querySelector('.s-date').textContent = fmtDate(s.start) + (live ? '  (recording now)' : '');
  el.querySelector('.s-meta').textContent = meta();

  let view = null;
  el.addEventListener('toggle', async () => {
    if (!el.open) { if (view) view.pause(); return; }
    if (view) { view.draw(); return; }
    const [clips, segs] = await Promise.all([DB.getClips(s.id), DB.getSegments(s.id)]);
    view = new NightView(el, s, clips.sort((a, b) => a.start - b.start), segs.sort((a, b) => a.start - b.start), live);
    openViews.add(view);

    const renderSummary = () => {
      const dur = (live ? Date.now() : s.end) - s.start;
      const longest = s.events.reduce((m, e) => Math.max(m, e.duration), 0);
      const loud = s.events.filter((e) => e.loudResume).length;
      el.querySelector('.s-summary').innerHTML =
        `<b>${s.events.length}</b> breathing pauses ≥ ${s.settings.apneaGap}s ` +
        `(<b>${rate(s.events.length, dur)}</b>/hour)` +
        (s.events.length ? ` · longest <b>${longest}s</b> · ${loud} ended with a loud gasp/snore` : '') +
        (view.segs.length ? '<br>Whole night recorded: tap anywhere on the graph to listen.' : '') +
        `<br><span class="muted">For reference, clinicians grade the apnea-hypopnea index as: &lt;5 normal, 5–15 mild, 15–30 moderate, 30+ severe. ` +
        `This app's count is only a rough sound-based estimate.</span>`;
      el.querySelector('.s-meta').textContent = meta();
      el.querySelector('.btn-dlfull').hidden = !view.segs.length;
      el.querySelector('.btn-delfull').hidden = !view.segs.length || live;
    };

    // breathing pauses: tap to zoom the graph there and play the sound
    const evBox = el.querySelector('.s-events');
    const renderEvents = () => {
      evBox.innerHTML = s.events.length ? '' : '<p class="muted">None detected.</p>';
      s.events.forEach((e) => {
        const d = document.createElement('div');
        d.className = 'list-item clickable';
        d.innerHTML = `<span>${fmtTime(e.start)}</span><b>${e.duration}s pause</b>` +
          (e.loudResume ? '<span class="tag">loud resume</span>' : '') + '<span class="grow"></span><span class="muted">show ›</span>';
        d.onclick = () => view.focusEvent(e);
        evBox.appendChild(d);
      });
    };

    // clips: tap a row to play it
    const clipBox = el.querySelector('.s-clips');
    const renderClips = () => {
      const clips = view.clips;
      clipBox.innerHTML = clips.length ? '' : '<p class="muted">No sounds above the threshold.</p>';
      clips.forEach((c, i) => {
        const d = document.createElement('div');
        d.className = 'list-item clickable clip-row';
        d.innerHTML = `<span>${fmtTime(c.start)}</span><span>${c.duration}s</span><span>peak ${c.peak} dB</span>` +
          (c.tag === 'after pause' ? '<span class="tag">after pause</span>' : '') +
          `<span class="grow"></span><button class="dl">Download</button><button class="rm danger">Delete</button>`;
        d.onclick = (ev) => { if (!ev.target.closest('button')) view.play(i); };
        d.querySelector('.dl').onclick = () => download(c.blob, `sleep_${fileStamp(c.start)}.wav`);
        d.querySelector('.rm').onclick = async () => {
          if (!confirm('Delete this clip?')) return;
          await DB.deleteClip(c.id);
          s.clips = s.clips.filter((x) => x.id !== c.id);
          if (!live) await DB.putSession(s);
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

    el.querySelector('.btn-csv').onclick = () => {
      const rows = [['type', 'start', 'end', 'duration_s', 'peak_db', 'note']];
      s.events.forEach((e) => rows.push(['pause', new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.duration, '', e.loudResume ? 'loud resume' : '']));
      view.clips.forEach((c) => rows.push(['clip', new Date(c.start).toISOString(), new Date(c.start + c.duration * 1000).toISOString(), c.duration, c.peak, c.tag]));
      download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `sleep_${fileStamp(s.start)}.csv`);
    };
    el.querySelector('.btn-dlall').onclick = async () => {
      if (view.clips.length) await downloadMany(view.clips.map((c) => ({ blob: c.blob, name: `sleep_${fileStamp(c.start)}.wav` })));
    };
    el.querySelector('.btn-dlfull').onclick = async () => {
      if (view.segs.length > 1 && !confirm(`The full recording is saved as ${view.segs.length} files of up to 10 minutes. Save them all?`)) return;
      await downloadMany(view.segs.map((g) => ({ blob: g.blob, name: `sleep_full_${fileStamp(g.start)}.${extFor(g.mime)}` })));
    };
    el.querySelector('.btn-delfull').onclick = async () => {
      if (!confirm(`Delete the whole-night recording (${fmtMB(segBytes(s))})? Saved clips and the graph are kept.`)) return;
      await DB.deleteSegments(s.id);
      s.segments = [];
      await DB.putSession(s);
      view.clearSegments();
      renderSummary();
    };
    el.querySelector('.btn-del').onclick = async () => {
      if (live) { alert('Stop monitoring first.'); return; }
      if (!confirm('Delete this whole night, including all clips and the full recording?')) return;
      await DB.deleteSession(s.id);
      renderHistory();
    };
  });
  return el;
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
  constructor(root, s, clips, segs, live) {
    this.root = root; this.s = s; this.clips = clips; this.segs = segs; this.live = live;
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
    this.onResize = () => { if (root.open) this.draw(); };
    window.addEventListener('resize', this.onResize);
    if (live) {
      // night still being recorded: pick up new clips/files and keep the graph growing
      this.lastEnd = this.v1;
      this.liveTimer = setInterval(() => {
        if (!root.open) return;
        const end = this.tEnd(), sp = this.v1 - this.v0, atEnd = this.v1 >= this.lastEnd - 1000;
        this.lastEnd = end;
        if (atEnd) { this.v1 = end; if (this.v0 !== this.t0) this.v0 = end - sp; }
        if (this.s.clips.length !== this.clips.length || this.s.segments.length !== this.segs.length) this.reload();
        else if (this.onDataChanged && this.s.events.length !== this.evCount) this.onDataChanged();
        this.evCount = this.s.events.length;
        if (this.audio.paused) this.draw();
      }, 5000);
      this.evCount = s.events.length;
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

  async reload() {
    const it = this.item();
    const [clips, segs] = await Promise.all([DB.getClips(this.s.id), DB.getSegments(this.s.id)]);
    this.clips = clips.sort((a, b) => a.start - b.start);
    this.segs = segs.sort((a, b) => a.start - b.start);
    if (it) this.cur = this.list().findIndex((x) => x.id === it.id);
    if (this.cur < 0) this.mode = null;
    if (this.onDataChanged) this.onDataChanged();
    this.updatePlayer(); this.draw();
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
    this.cv.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// ---------------------------------------------------------------- boot
fillSettings();
drawLive();
window.addEventListener('beforeunload', (e) => { if (Monitor.running) { Monitor.persist(); e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !NATIVE) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
