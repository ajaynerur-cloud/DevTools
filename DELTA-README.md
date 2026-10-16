# DevHub delta (git)

Apply to your DevTools-main repo, either way:

1. **Patch:** from the repo root run `git apply --index devhub-delta.patch`, then commit.
2. **Files:** copy the files in this zip over the same paths in the repo (keep `.github/`, `vendor/` and `portable/`), then commit.

After merging, **redeploy the server (Render)**, because `server.js` changed.

## Build the Windows exe when you need it (no install needed on the PC that runs it)
- **GitHub:** Actions > *Windows portable exe* > *Run workflow*, then download `DevHub-Portable.exe`, `DevHub.html` and `SHA256SUMS.txt` from the run's Artifacts. A tag like `portable-v1.0` also publishes them as a release.
- **Windows PC with Python 3 and Go 1.21+:** run `portable\build-windows-exe.bat`.
- **Linux/macOS:** `sh portable/build-windows-exe.sh`.
The files land in `dist/` (git-ignored). `DevHub.html` works on its own too: double-click it in Edge or Chrome.

## What changed
- New SAP tools: **SAP Scope Delta** and **Remediation Project Planner** (libraries bundled, works offline).
- Sync server (Render) woken only on Tasks, Tool stores and Account.
- `server.js`: only `remediation-planner.html` may be framed, and only by the same site.
- **SAP CVA Orchestrator keeps no history:** applications.json, its file handle and the output folder are not stored; earlier stored copies are removed.
- Portable build (`portable/`), GitHub workflow (`.github/workflows/windows-exe.yml`), build 2026.10.16-7, `sw.js` cache v34, `package.json`, `styles.css`, `README.md`.
