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
};
const CLIP_RATE = 16000;     // saved audio sample rate (Hz)
const LIVE_SECONDS = 60;     // live chart window

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
      const req = indexedDB.open('sleepmon', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        const clips = db.createObjectStore('clips', { keyPath: 'id' });
        clips.createIndex('sessionId', 'sessionId');
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
    async deleteSession(id) {
      const clips = await this.getClips(id);
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

  async start() {
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
    };
    Object.assign(this, {
      floor: null, preBuf: [], preLen: 0, clip: null, lastActive: now, wasActive: false, inactiveSince: now,
      bursts: [], silence: null, pendingResume: null, secMax: 0, secStart: now, live: [],
    });
    this.running = true;
    await DB.putSession(this.session);
    this.saveTimer = setInterval(() => this.persist(), 30000);
  },

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.saveTimer);
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

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

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
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
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
    $('nightInfo').textContent = `${s.clips.length} clips · ${s.events.length} pauses`;
  }
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
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (s) alert(`Saved: ${fmtDur(s.end - s.start)}, ${s.clips.length} clips, ${s.events.length} breathing pauses.\nSee the History tab.`);
};

$('btnCalibrate').onclick = async () => {
  const startedHere = !Monitor.running;
  if (startedHere) {
    try { await Monitor.start(); } catch (e) { alert('Microphone error: ' + e.message); return; }
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
$('btnResetSettings').onclick = () => { settings = { ...DEFAULTS }; saveSettings(); fillSettings(); };

// ---------------------------------------------------------------- history UI
async function renderHistory() {
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

function renderSession(s) {
  const el = $('sessionTpl').content.firstElementChild.cloneNode(true);
  const dur = s.end - s.start;
  const live = Monitor.session && Monitor.session.id === s.id;
  el.querySelector('.s-date').textContent = fmtDate(s.start) + (live ? '  (recording now)' : '');
  el.querySelector('.s-meta').textContent =
    `${fmtDur(dur)} · ${s.clips.length} clips · ${s.events.length} pauses · ${rate(s.events.length, dur)} pauses/h`;

  let loaded = false;
  el.addEventListener('toggle', async () => {
    if (!el.open || loaded) return;
    loaded = true;
    const clips = (await DB.getClips(s.id)).sort((a, b) => a.start - b.start);
    drawSessionChart(el.querySelector('.s-chart'), s);
    window.addEventListener('resize', () => el.open && drawSessionChart(el.querySelector('.s-chart'), s));

    const longest = s.events.reduce((m, e) => Math.max(m, e.duration), 0);
    const loud = s.events.filter((e) => e.loudResume).length;
    el.querySelector('.s-summary').innerHTML =
      `<b>${s.events.length}</b> breathing pauses ≥ ${s.settings.apneaGap}s ` +
      `(<b>${rate(s.events.length, dur)}</b>/hour)` +
      (s.events.length ? ` · longest <b>${longest}s</b> · ${loud} ended with a loud gasp/snore` : '') +
      `<br><span class="muted">For reference, clinicians grade the apnea-hypopnea index as: &lt;5 normal, 5–15 mild, 15–30 moderate, 30+ severe. ` +
      `This app's count is only a rough sound-based estimate.</span>`;

    const evBox = el.querySelector('.s-events');
    evBox.innerHTML = s.events.length ? '' : '<p class="muted">None detected.</p>';
    s.events.forEach((e) => {
      const d = document.createElement('div');
      d.className = 'list-item';
      d.innerHTML = `<span>${fmtTime(e.start)}</span><b>${e.duration}s pause</b>` + (e.loudResume ? '<span class="tag">loud resume</span>' : '');
      evBox.appendChild(d);
    });

    const clipBox = el.querySelector('.s-clips');
    clipBox.innerHTML = clips.length ? '' : '<p class="muted">No sounds above the threshold.</p>';
    clips.forEach((c) => {
      const d = document.createElement('div');
      d.className = 'list-item';
      const url = URL.createObjectURL(c.blob);
      d.innerHTML = `<span>${fmtTime(c.start)}</span><span>${c.duration}s</span><span>peak ${c.peak} dB</span>` +
        (c.tag === 'after pause' ? '<span class="tag">after pause</span>' : '') +
        `<button class="dl">Download</button><button class="rm danger">Delete</button><audio controls preload="none" src="${url}"></audio>`;
      d.querySelector('.dl').onclick = () => download(c.blob, `sleep_${fileStamp(c.start)}.wav`);
      d.querySelector('.rm').onclick = async () => {
        if (!confirm('Delete this clip?')) return;
        await DB.deleteClip(c.id);
        s.clips = s.clips.filter((x) => x.id !== c.id);
        if (!live) await DB.putSession(s);
        else Monitor.session.clips = Monitor.session.clips.filter((x) => x.id !== c.id);
        d.remove();
      };
      clipBox.appendChild(d);
    });

    el.querySelector('.btn-csv').onclick = () => {
      const rows = [['type', 'start', 'end', 'duration_s', 'peak_db', 'note']];
      s.events.forEach((e) => rows.push(['pause', new Date(e.start).toISOString(), new Date(e.end).toISOString(), e.duration, '', e.loudResume ? 'loud resume' : '']));
      clips.forEach((c) => rows.push(['clip', new Date(c.start).toISOString(), new Date(c.start + c.duration * 1000).toISOString(), c.duration, c.peak, c.tag]));
      download(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `sleep_${fileStamp(s.start)}.csv`);
    };
    el.querySelector('.btn-dlall').onclick = async () => {
      for (const c of clips) { download(c.blob, `sleep_${fileStamp(c.start)}.wav`); await new Promise((r) => setTimeout(r, 300)); }
    };
    el.querySelector('.btn-del').onclick = async () => {
      if (live) { alert('Stop monitoring first.'); return; }
      if (!confirm('Delete this whole night, including all clips?')) return;
      await DB.deleteSession(s.id);
      renderHistory();
    };
  });
  return el;
}

function drawSessionChart(cv, s) {
  const { g, w, h } = setupCanvas(cv);
  const n = s.levels.length;
  const total = Math.max(1, s.end - s.start);
  const xOfT = (t) => ((t - s.start) / total) * w;

  // breathing pauses
  g.fillStyle = 'rgba(255,138,101,.45)';
  s.events.forEach((e) => { const x = xOfT(e.start); g.fillRect(x, 0, Math.max(2, xOfT(e.end) - x), h); });

  // level: max per pixel column
  if (n) {
    g.fillStyle = css('--accent');
    for (let px = 0; px < w; px++) {
      const a = Math.floor((px / w) * n), b = Math.max(a + 1, Math.floor(((px + 1) / w) * n));
      let m = 0;
      for (let i = a; i < b && i < n; i++) m = Math.max(m, s.levels[i]);
      const y = yOf(m, h);
      g.fillRect(px, y, 1, h - y);
    }
  }
  // threshold
  g.strokeStyle = css('--danger'); g.setLineDash([4, 4]); g.beginPath();
  const ty = yOf(s.settings.threshold, h); g.moveTo(0, ty); g.lineTo(w, ty); g.stroke(); g.setLineDash([]);
  // clips
  g.fillStyle = css('--clip');
  s.clips.forEach((c) => g.fillRect(xOfT(c.start), h - 6, Math.max(2, (c.duration * 1000 / total) * w), 6));
  // hour labels
  g.fillStyle = css('--muted'); g.font = '11px system-ui';
  const first = new Date(s.start); first.setMinutes(0, 0, 0);
  const stepMs = total > 4 * 3600000 ? 3600000 : total > 3600000 ? 1800000 : 600000;
  for (let t = first.getTime() + stepMs; t < s.end; t += stepMs) {
    const x = xOfT(t);
    if (x < 0) continue;
    g.fillRect(x, 0, 1, 4);
    g.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x + 2, 13);
  }
}

// ---------------------------------------------------------------- boot
fillSettings();
drawLive();
window.addEventListener('beforeunload', (e) => { if (Monitor.running) { Monitor.persist(); e.preventDefault(); e.returnValue = ''; } });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
