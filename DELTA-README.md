# DevHub delta (git)

Two ways to apply it to your DevTools-main repo:

1. **Git patch (recommended):** from the repo root run `git apply --index devhub-delta.patch` (or `git am devhub-delta.patch` to keep the commit message).
2. **Files:** copy the files in this zip over the same paths in the repo (keep the `vendor/` and `portable/` folders), then commit.

After merging, **redeploy the server (Render)**: `server.js` changed.

## What changed
- New tools under SAP tools: **SAP Scope Delta** (`sap-delta.js`) and **Remediation Project Planner** (`remediation-planner.html`, `remediation-planner.js`, `vendor/exceljs.min.js`, `vendor/pptxgen.bundle.js`).
- The sync server (Render) is woken only on Tasks, Tool stores and Account (`app.js`).
- `server.js` lets only `remediation-planner.html` be framed, and only by the same site.
- **SAP CVA Orchestrator keeps no history** (`sap-cva.js`): applications.json, its file handle and the output folder are no longer stored on the device, and earlier stored copies are removed. Users open applications.json each time.
- **Portable build** (`portable/`): `sh portable/build-windows-exe.sh` makes `dist/DevHub.html` (the whole app in one file) and `dist/DevHub-Portable.exe` (no install, no admin rights). `dist/` is git-ignored.
- `index.html` build 2026.10.16-7, `sw.js` cache v34, `package.json` (Android `www` copy list), `styles.css`, `README.md`.
