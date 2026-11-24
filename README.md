# Sleep Apnea Monitor

An app for your phone that listens while you sleep:

- **records the whole night** (compressed, about 15 MB per hour) and saves a WAV clip of every sound louder than your threshold;
- **recognises the sounds** afterwards (snoring, gasp/wheeze, cough, talking, breathing, movement) with an on-device model, and highlights them on the night's graph;
- shows **past nights as a weekly grid**, with each night's length, a small graph and its snoring time;
- lets you **replay any moment** by tapping the graph, **amplify** quiet sounds and **change the loudness threshold** after recording;
- **in the Android app, keeps recording with the screen off or while you use other apps**.

Everything stays on your phone in the browser's storage. Nothing is uploaded.

> ⚠️ **Not a medical device.** A microphone can't measure airflow or blood oxygen, so it can't detect apnea reliably. Use it to decide whether to see a doctor and to show them what happens at night. A sleep study is the only real diagnosis.

## Download the Android app

**[⬇ Download SleepMonitor.apk](https://github.com/veryniceparts/sleep/releases/latest/download/SleepMonitor.apk)**

Open the link on your Android phone, open the downloaded file and tap **Install**. If Android asks, allow your browser to *install unknown apps*. The first time you tap Start, allow microphone access.

A new APK is built automatically by GitHub Actions on every push (see *Actions* and *Releases*). All builds are signed with the same key, so a new version installs over the old one and keeps your recordings. In the app, **Download** buttons open Android's share sheet, so you can save files to Files or Drive, or send them by email or a messaging app.

**Screen off and other apps:** in the Android app, monitoring runs in a background service, shown by a "Monitoring your sleep" notification with a Stop button. You can lock the phone or use other apps all night. It records the microphone natively (clips as WAV, the whole night as AAC .m4a files). When you tap Start the first time, allow the microphone and notifications. The app also offers to turn off battery restrictions, so aggressive power savers (Samsung, Xiaomi, Huawei, ...) don't stop it during the night.

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

## The screen

Everything fits on one screen:

- **Live card:** the dB level and live graph work as soon as the app opens. **Start** turns into **Stop** while monitoring. The red line is the recording threshold, which you can adjust with the slider.
- **Past nights:** a 4×2 grid for one week, with Monday–Sunday plus a week summary (nights, average hours, average snoring). Each tile shows the start time, length, a small graph and the snoring time. Switch weeks with ‹ › or by swiping the grid. **+1** means more than one recording that night. A night that starts after midnight counts as the previous evening.
- **⋮ menu:** record the whole night, auto-set threshold, night mode, battery settings (Android) and all detection settings.

## Sound recognition

The whole night is always recorded. When you open a night, the app identifies its sounds once and saves the result. It uses Google's YAMNet sound-event model (521 sound classes) through MediaPipe, running on the phone, so no audio is uploaded. Each second is labelled **Snoring**, **Gasp / wheeze**, **Cough**, **Talking**, **Breathing**, **Movement** or **Other**:

- A colored band along the top of the graph shows what was heard and when.
- Chips above the **Sounds** list show how long each kind lasted. Tap one to highlight it on the graph and filter the list.
- Each loud sound in the list is labelled with what it most likely is.

The Android app has the model built in, so it works offline. The web version downloads it (about 26 MB) the first time.

## Changing the threshold afterwards

The **Loud ≥** slider in a night changes which sounds count as loud for that night. The Sounds list and the markers update immediately, and each night remembers its own setting.

## Amplifying playback

The **×1** button in the player boosts quiet recordings ×2, ×4, ×8 or ×16. A limiter keeps loud parts from distorting.

## Checking a night: graph and replay

Tap a day in the grid to open that night full screen. The phone's Back button or ‹ returns to the grid.


- **Graph:** the blue area is sound level and the red dashed line is the night's threshold. The colored band along the top shows recognised sounds, and the marks along the bottom are loud sounds, colored by type.
- **Green strip along the top:** parts of the night covered by the whole-night recording.
- **Tap the graph** to play the sound at that moment. With a whole-night recording, any moment can be played and playback keeps going through the night. Without one, only the saved clips can be played. A white playhead moves across the graph while it plays, and the graph scrolls to follow it.
- **Zoom and scroll:** pinch, use the mouse wheel or the **+ / −** buttons to zoom from the whole night down to 30 s. Drag sideways to scroll. **Whole night** zooms back out.
- **Player:** play/pause, previous/next loud sound (of the selected type), a seek bar and the **×1–×16** volume boost.
- **Tap a clip** in the list to play it on the graph.

You can open History while monitoring is still running. The graph keeps growing as the night is recorded.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Threshold | 60 dB | Sounds above this are saved as clips |
| Pre-roll | 3 s | Audio kept from before the trigger |
| Stop after quiet for | 4 s | A clip ends after this much quiet |
| Max clip length | 60 s | Long sounds are split into clips of this length |

Levels are relative: 0 dB is digital silence and about 100 dB is the loudest the mic can capture. They aren't calibrated SPL readings.

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
- `app.js`: audio capture, level meter, clip and whole-night recording, sound recognition, IndexedDB storage, graphs
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline support and installing as an app
- `android/`, `capacitor.config.json`, `package.json`: Android app wrapper
- `.github/workflows/android.yml`: builds the APK and publishes it as a GitHub release
