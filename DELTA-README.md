# DevHub delta: SAP Scope Delta

Adds **Tools > SAP tools > SAP Scope Delta** (compare two ATC / CVA result sheets per system: common objects by priority, additional objects, additional %).

It also stops the app contacting the sync server (Render) when you only use the developer tools. The server is now woken only on Tasks, Tool stores and Account.

## Apply
Copy these files over the same paths in your DevTools-main folder.

| File | Change |
|---|---|
| `sap-delta.js` | **New.** The comparison tool. |
| `app.js` | Registers the tool; the server wake-up and sync run only on Tasks, Tool stores and Account (checked on launch, on coming back online, on tab focus and when opening those screens). |
| `index.html` | Loads `sap-delta.js`; build bumped to 2026.10.16-4. |
| `sw.js` | Caches `sap-delta.js`; cache version v31. |
| `styles.css` | Appends the `.dlt-*` styles. |
| `package.json` | `npm run www` now copies `sap-delta.js` (needed for the Android build). |
| `README.md` | Documents the tool. |

No server, data or dependency changes. It uses the existing `vendor/xlsx-style.min.js`.
