# DevHub delta: SAP Scope Delta + Remediation Project Planner

Adds two tools under **Tools > SAP tools**:

- **SAP Scope Delta**: compare two ATC / CVA result sheets per system (common objects by priority, additional objects, additional %).
- **Remediation Project Planner**: effort, team and timeline estimate with Excel and PowerPoint export, shown as an embedded page.

It also stops the app contacting the sync server (Render) when you only use the developer tools. The server is woken only on Tasks, Tool stores and Account.

## Why `server.js` is in this delta
`server.js` used to send `X-Frame-Options: DENY` and `frame-ancestors 'none'` on every page, which made the planner appear as a blocked frame. It now allows only `remediation-planner.html` to be framed, and only by the same site. All other pages stay denied. **Redeploy the server** (Render) for this to take effect.

## Apply
Copy these files over the same paths in your DevTools-main folder (keep the `vendor/` subfolder), then redeploy.

| File | Change |
|---|---|
| `sap-delta.js` | **New.** SAP Scope Delta. |
| `remediation-planner.html`, `remediation-planner.js` | **New.** The planner page and its script (the server's policy only allows scripts from its own files). |
| `vendor/exceljs.min.js`, `vendor/pptxgen.bundle.js` | **New.** Libraries for the planner's exports (MIT), plus `vendor/LICENSE-exceljs` and `vendor/LICENSE-pptxgenjs`. |
| `server.js` | Lets the planner page be framed by DevHub only. |
| `app.js` | Registers both tools; server wake-up and sync run only on Tasks, Tool stores and Account. |
| `index.html` | Loads `sap-delta.js`; build 2026.10.16-6. |
| `sw.js` | Caches the new files; cache version v33. |
| `styles.css` | Styles for both tools. |
| `package.json` | `npm run www` copies the new files (needed for the Android build). |
| `README.md` | Documents both tools; tool count is now 35. |
