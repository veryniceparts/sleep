# Sleep Apnea Monitor

A web app you install on your phone. It listens to you while you sleep and:

- **records and saves every sound louder than your threshold** (snoring, gasping, choking) as a WAV clip. Each clip includes a few seconds from before the sound started, so you hear what led up to it.
- **detects breathing pauses**: it hears normal breathing or snoring, then silence for at least 10 s, then breathing again. Each pause is logged as a possible apnea event, along with whether breathing restarted with a loud gasp or snort.
- shows a **timeline of each night** with sound level, threshold, pauses and saved clips, plus **pauses per hour**.
- lets you play, download and delete clips, and **export a CSV** of the night to show your doctor.

Everything stays on your phone in the browser's storage. Nothing is uploaded.

> ⚠️ **Not a medical device.** A microphone can't measure airflow or blood oxygen, so it misses some apneas and some pauses it reports aren't apneas. Use it to decide whether to see a doctor and to show them what happens at night. A sleep study is the only real diagnosis.

## Running it

Browsers only allow microphone access over **HTTPS** (or `localhost`), so host the folder on any static HTTPS host:

- **GitHub Pages:** in the repository go to *Settings → Pages*, choose the branch and the `/ (root)` folder, then open `https://<user>.github.io/<repo>/` on your phone.
- **Netlify, Cloudflare Pages or Vercel:** drag and drop the folder.
- **On your computer, for testing:** run `python3 -m http.server 8000` and open `http://localhost:8000`.

Then use **Add to Home Screen** (iOS Safari) or **Install app** (Android Chrome).

## How to use it at night

1. Plug the phone into a charger and put it 0.5–1 m from your head, microphone facing you.
2. In a quiet room, tap **Auto-set threshold** and stay silent for 10 s. This sets the threshold to the room level + 15 dB. Fine-tune it with the slider.
3. Tap **Start monitoring**, then **Night mode** to turn the screen black. Double-tap to exit.
4. **Leave the app open.** The screen is kept awake so the browser keeps recording. Don't switch apps or lock the phone, because mobile browsers stop the microphone in the background.
5. In the morning, tap **Stop** and open **History**.

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

Clips are 16 kHz mono WAV, about 32 KB per second. A night with 200 short clips uses about 50–100 MB. Delete old nights in History.

## Files

- `index.html`, `styles.css`: the user interface
- `app.js`: audio capture, level detection, clip recording, pause detection, IndexedDB storage, charts
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline support and installing as an app
