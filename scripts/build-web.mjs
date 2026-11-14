// Copies the web app into www/ for the Android build.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
const files = ['index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', 'icon.svg'];
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of files) cpSync(f, `www/${f}`);
console.log('web app copied to www/');
