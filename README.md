# DevHub — developer toolkit PWA

Installable, offline-capable web app for phone, tablet and desktop, plus an Android APK built by GitHub Actions.

**30 tools in 6 groups**

| Group | Tools |
|---|---|
| Formatters | JSON, HTML, CSS/SCSS/Less, JavaScript/TypeScript/JSX, XML/SVG, SQL (11 dialects), YAML — format, and minify for JSON/CSS/XML |
| Converters | Any-format converter, JSON ⇄ CSV, JSON ⇄ Excel, CSV ⇄ Excel, XML ⇄ JSON, XML → CSV/Excel, YAML ⇄ JSON, Data → SQL inserts |
| Encode & decode | Base64, URL, JWT, HTML entities, hashes |
| Text | Regex tester, case converter, text diff |
| Generators | UUID, password, lorem ipsum |
| Utilities | Timestamp, cron explainer, color, number base |

Plus a **daily task tracker** and **tool store links**, stored as JSON in your GitHub repo.

### Converters

Inputs: JSON, NDJSON/JSON Lines, CSV, TSV, Excel (.xlsx, .xls, .ods), XML, YAML.
Outputs: JSON, NDJSON, CSV, TSV, Excel (.xlsx), XML, YAML, SQL inserts, Markdown table.

Open a file from your computer, phone or tablet (file picker or drag and drop), or paste text. Results can be downloaded, shared through the phone's share sheet, or copied.

### Large files

All formatting and conversion runs in a Web Worker, so the page never freezes, and you can cancel at any time.

- JSON arrays and NDJSON are **streamed** record by record, never loaded as one giant string.
- CSV is parsed in 4 MB chunks.
- Output is assembled as Blob parts, so results can exceed the browser's single-string limit.
- Only a preview (first 100 rows / 64 KB) is drawn on screen; the full result goes to Download.
- Excel output splits across sheets past 1,048,576 rows and flags cells over 32,767 characters.

Measured in desktop Chrome: 300,000 nested records (54 MB JSON) → CSV in about 3 s, → Excel in about 13 s. Excel and XML inputs are read whole, so their practical size depends on device memory; phones handle tens of MB comfortably, desktops hundreds.

No build step for the web app — plain HTML, CSS and JavaScript. Libraries are vendored in `vendor/` (SheetJS, Papa Parse, fast-xml-parser, js-yaml, js-beautify, sql-formatter) so everything works offline.

## 1. Put it on GitHub

```bash
git init && git add . && git commit -m "DevHub"
git branch -M main
git remote add origin https://github.com/<you>/devhub.git
git push -u origin main
```

## 2. Deploy on Render (gets you a URL)

1. Render dashboard → **New → Blueprint** → pick your `devhub` repo. `render.yaml` is detected automatically.
   *(Or **New → Static Site**, Build command: empty, Publish directory: `.`)*
2. Deploy. Your app is live at `https://devhub-xxxx.onrender.com`.

Pushes to `main` redeploy automatically. Commits that only touch `data/` are ignored, so saving tasks doesn't trigger a redeploy.

## 3. (Optional) Also deploy on GitHub Pages

Repo → **Settings → Pages → Source: GitHub Actions**. The included workflow publishes to `https://<you>.github.io/devhub/`.

## 4. Build the Android APK (GitHub Actions)

The workflow `.github/workflows/android.yml` wraps the app with [Capacitor](https://capacitorjs.com) and builds with Gradle.

- **Debug APK:** repo → **Actions → Build Android APK → Run workflow**. When it finishes, download `DevHub-…-apk` from the run's **Artifacts**. Install it on your phone (allow "install unknown apps").
- **Release on tag:** `git tag v2.0.0 && git push --tags` builds the APK and attaches it to a GitHub Release.
- **Signed release APK (optional, needed for Play Store or clean updates):** create a keystore once:
  ```bash
  keytool -genkey -v -keystore release.keystore -alias devhub -keyalg RSA -keysize 2048 -validity 10000
  base64 -w0 release.keystore   # copy the output
  ```
  Add repo secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The workflow then also produces `DevHub-…-release.apk`.
- **App id:** defaults to `io.github.devhub`. Set a repo variable `ANDROID_APP_ID` (e.g. `com.yourname.devhub`) to change it.

The APK bundles the app files, so all tools work offline. In the app, **Download** writes the file and opens Android's share sheet, where you can save it to Files, Drive, or send it anywhere.

To work on the Android app locally: `npm install && npm run android:sync && npm run android:open` (needs Android Studio).

## 5. Connect storage

1. Create a **fine-grained personal access token**: GitHub → Settings → Developer settings → Fine-grained tokens.
   - Repository access: **only** your data repo
   - Permissions: **Contents → Read and write**
2. Open the app → **GitHub sync** → enter owner, repo, branch (`main`), data folder (`data`) and token → **Save and connect**.

The data repo can be the same repo as the app, or a separate **private** repo (recommended if your tasks are personal).

## How sync works

- Edits save locally at once and push to GitHub 1.5 s later (debounced).
- Offline? Changes queue locally and push when you're back online.
- On open, and when you return to the tab, the app pulls the latest JSON.
- If the file changed elsewhere, the last write wins (history stays in git).

## Security notes

- The token is kept in this browser's localStorage only; it's never in the repo. Anyone with access to your browser profile could read it, so use a fine-grained token scoped to one repo.
- If your data repo is public, your tasks are public. Use a private repo for personal data.
- Tools never send your input anywhere.

## Data format

```jsonc
// data/tasks.json
{ "2026-09-26": [ { "id": "…", "text": "Review PR #142", "done": false, "priority": "high", "created": "2026-09-26T09:12:00.000Z" } ] }

// data/links.json
[ { "id": "…", "name": "npm", "url": "https://www.npmjs.com", "category": "Package registries", "notes": "" } ]
```

## Adding a tool

Add an entry to the `TOOLS` array in `app.js`:

```js
{ id: 'reverse', group: 'Text', name: 'Reverse text', desc: 'Reverse a string.',
  render: el => io(el, { actions: [{ label: 'Reverse', fn: s => [...s].reverse().join('') }] }) }
```

After changing app files, bump `CACHE` in `sw.js` (e.g. `devhub-v3`) so installed copies update.

Converter and formatter logic lives in `worker.js`; add a new output format by writing a writer function there and adding it to `OUT_FORMATS` in `app.js`.
