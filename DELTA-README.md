# DevHub delta: SAP Scope Delta + Remediation Project Planner

Adds two tools under **Tools > SAP tools**:

- **SAP Scope Delta**: compare two ATC / CVA result sheets per system (common objects by priority, additional objects, additional %).
- **Remediation Project Planner**: effort, team and timeline estimate with Excel and PowerPoint export. Runs as an embedded page.

It also stops the app contacting the sync server (Render) when you only use the developer tools. The server is woken only on Tasks, Tool stores and Account.

## Apply
Copy these files over the same paths in your DevTools-main folder (keep the `vendor/` subfolder).

| File | Change |
|---|---|
| `sap-delta.js` | **New.** SAP Scope Delta. |
| `remediation-planner.html` | **New.** The planner page (works offline; saves through DevHub, so the Android app can share the exported file). |
| `vendor/exceljs.min.js`, `vendor/pptxgen.bundle.js` | **New.** Libraries for the planner's Excel and PowerPoint export (MIT), plus `vendor/LICENSE-exceljs` and `vendor/LICENSE-pptxgenjs`. |
| `app.js` | Registers both tools; server wake-up and sync run only on Tasks, Tool stores and Account. |
| `index.html` | Loads `sap-delta.js`; build 2026.10.16-5. |
| `sw.js` | Caches the new files; cache version v32. |
| `styles.css` | Styles for both tools. |
| `package.json` | `npm run www` copies the new files (needed for the Android build). |
| `README.md` | Documents both tools; tool count is now 35. |

No server or data changes.
