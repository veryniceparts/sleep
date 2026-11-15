# Sleep Apnea Monitor

A web app you install on your phone. It listens to you while you sleep and:

- **records and saves every sound louder than your threshold** (snoring, gasping, choking) as a WAV clip. Each clip includes a few seconds from before the sound started, so you hear what led up to it.
- **detects breathing pauses**: it hears normal breathing or snoring, then silence for at least 10 s, then breathing again. Each pause is logged as a possible apnea event, along with whether breathing restarted with a loud gasp or snort.
- shows an **interactive graph of each night** with sound level, threshold, breathing pauses and saved clips, plus **pauses per hour**.
- can optionally **record the whole night** (compressed, about 15 MB per hour), so you can listen to any moment, not only the loud ones.
- lets you **replay** what happened: tap anywhere on the graph to hear that moment, or play every clip one after another to replay the night.
- lets you download and delete clips, and **export a CSV** of the night to show your doctor.

Everything stays on your phone in the browser's storage. Nothing is uploaded.

> ⚠️ **Not a medical device.** A microphone can't measure airflow or blood oxygen, so it misses some apneas and some pauses it reports aren't apneas. Use it to decide whether to see a doctor and to show them what happens at night. A sleep study is the only real diagnosis.

## Download the Android app

**[⬇ Download SleepMonitor.apk](https://github.com/veryniceparts/sleep/releases/latest/download/SleepMonitor.apk)**

Open the link on your Android phone, open the downloaded file and tap **Install**. If Android asks, allow your browser to *install unknown apps*. The first time you tap Start, allow microphone access.

A new APK is built automatically by GitHub Actions on every push (see *Actions* and *Releases*). All builds are signed with the same key, so a new version installs over the old one and keeps your recordings. In the app, **Download** buttons open Android's share sheet, so you can save files to Files or Drive, or send them by email or a messaging app.

**Screen off and other apps:** in the Android app, monitoring runs in a background service, shown by a "Monitoring your sleep" notification with a Stop button. You can lock the phone or use other apps all night. It records the microphone natively (clips as WAV, the whole night as AAC .m4a files) and does the same breathing-pause detection. When you tap Start the first time, allow the microphone and notifications. The app also offers to turn off battery restrictions, so aggressive power savers (Samsung, Xiaomi, Huawei, ...) don't stop it during the night.

iPhone can't install APKs. Use the web version below and *Add to Home Screen*.

## Running it as a web app

Browsers only allow microphone access over **HTTPS** (or `localhost`), so host the folder on any static HTTPS host:

- **GitHub Pages:** in the repository go to *Settings → Pages*, choose the branch and the `/ (root)` folder, then open `https://<user>.github.io/<repo>/` on your phone.
- **Netlify, Cloudflare Pages or Vercel:** drag and drop the folder.
- **On your computer, for testing:** run `python3 -m http.server 8000` and open `http://localhost:8000`.

Then use **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

## How to use it at night

1. Plug the phone into a charger and put it 0.5–1 m from your head, microphone facing you.
2. In a quiet room, tap **Auto-set threshold** and stay silent for 10 s. This sets the threshold to the room level + 15 dB. Fine-tune it with the slider.
3. Optional: tick **Record the whole night** if you want to be able to listen to any moment later.
4. Tap **Start monitoring**, then **Night mode** to turn the screen black. Double-tap to exit.
5. **Android app:** lock the phone or use other apps as you like. **Web version:** leave the page open. The screen is kept awake so the browser keeps recording. Don't switch apps or lock the phone, because mobile browsers stop the microphone in the background.
6. In the morning, tap **Stop** and open **History**.

## Checking a night: graph and replay

Open **History** and tap a night.

- **Graph:** the blue area is sound level, the red dashed line is your threshold, orange bands are breathing pauses and yellow marks along the bottom are saved clips.
- **Green strip along the top:** parts of the night covered by the whole-night recording.
- **Tap the graph** to play the sound at that moment. With a whole-night recording, any moment can be played and playback keeps going through the night. Without one, only the saved clips can be played. A white playhead moves across the graph while it plays, and the graph scrolls to follow it.
- **Zoom and scroll:** pinch, use the mouse wheel or the **+ / −** buttons to zoom from the whole night down to 30 s. Drag sideways to scroll. **Whole night** zooms back out.
- **Player:** play/pause, previous/next loud sound and a seek bar. Tick **Play all clips** to play the whole night's clips in order.
- **Tap a breathing pause** in the list to zoom to it. With a whole-night recording it plays from 5 s before the pause, so you hear the last breaths, the silence and the restart. Without one, it plays the clip from when breathing restarted.
- **Tap a clip** in the list to play it on the graph.

You can open History while monitoring is still running. The graph keeps growing as the night is recorded.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Threshold | 60 dB | Sounds above this are saved as clips |
| Pre-roll | 3 s | Audio kept from before the trigger |
| Stop after quiet for | 4 s | A clip ends after this much quiet |
| Max clip length | 60 s | Long sounds are split into clips of this length |
| Minimum pause | 10 s | Shortest silence counted as a breathing pause (the clinical apnea definition) |
| Ignore pauses longer than | 90 s | Longer silences are probably not apneas (for example, you rolled away from the mic) |
| Breath sensitivity | 6 dB | How far above the room's noise floor a sound must be to count as a breath |
| Breaths needed before a pause | 3 | Audible breaths required in the minute before a pause, so random silence isn't counted |
| Save clip after pause | on | Always record the moment breathing restarts, even if it is quiet |

Levels are relative: 0 dB is digital silence and about 100 dB is the loudest the mic can capture. They aren't calibrated SPL readings.

**Tip:** pause detection only works if the app can hear your normal breathing. If you get 0 pauses and the live chart doesn't move when you breathe, move the phone closer or lower *Breath sensitivity*.

## Storage

- **Clips:** 16 kHz mono WAV, about 32 KB per second. A night with 200 short clips uses about 50–100 MB.
- **Whole-night recording:** compressed (Opus/WebM on Android and Chrome, AAC/MP4 on iPhone) at 32 kbit/s, about 15 MB per hour or roughly 120 MB for an 8-hour night. It is saved in 10-minute files, so if the browser crashes you lose at most the last 10 minutes. **Download full recording** saves these files. **Delete full recording** frees the space but keeps the graph and clips.

Delete old nights in History.

## Building the Android app yourself

Requires Node 22+, JDK 21 and the Android SDK:

```
npm install
npm run build:android   # → android/app/build/outputs/apk/debug/app-debug.apk
```

The Android project is a [Capacitor](https://capacitorjs.com) wrapper around the same web files (`scripts/build-web.mjs` copies them into `www/`).

## Files

- `index.html`, `styles.css`: the user interface
- `app.js`: audio capture, level detection, clip recording, pause detection, IndexedDB storage, charts
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline support and installing as an app
- `android/`, `capacitor.config.json`, `package.json`: Android app wrapper
- `.github/workflows/android.yml`: builds the APK and publishes it as a GitHub release
