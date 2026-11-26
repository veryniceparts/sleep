// Copies the web app into www/ for the Android build, plus the sound-recognition runtime and model
// (so recognition works offline in the app). The web version loads those from a CDN instead.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const files = ['index.html', 'styles.css', 'version.js', 'app.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of files) cpSync(f, `www/${f}`);
// version shown in About (CI sets VERSION_NAME, e.g. 1.0.42)
const version = process.env.VERSION_NAME || 'dev';
writeFileSync('www/version.js', `window.APP_VERSION = ${JSON.stringify(version)};\n`);
console.log(`version ${version}`);

const mp = 'node_modules/@mediapipe/tasks-audio';
const model = 'models/yamnet.tflite';
if (existsSync(mp) && existsSync(model)) {
  mkdirSync('www/vendor');
  cpSync(`${mp}/audio_bundle.mjs`, 'www/vendor/audio_bundle.mjs');
  cpSync(`${mp}/wasm/audio_wasm_internal.js`, 'www/vendor/audio_wasm_internal.js');
  cpSync(`${mp}/wasm/audio_wasm_internal.wasm`, 'www/vendor/audio_wasm_internal.wasm');
  cpSync(model, 'www/vendor/yamnet.tflite');
  console.log('sound recognition bundled into www/vendor/');
} else {
  console.log('sound recognition not bundled (run: npm install && npm run fetch-model)');
}
console.log('web app copied to www/');
