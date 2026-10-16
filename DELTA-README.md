# DevHub delta: SAP Scope Delta

Adds **Tools > SAP tools > SAP Scope Delta** (compare two ATC / CVA result sheets per system: common objects by priority, additional objects, additional %).

## Apply
Copy these files over the same paths in your DevTools-main folder.

| File | Change |
|---|---|
| `sap-delta.js` | **New.** The comparison tool. |
| `app.js` | Registers the tool in the SAP tools group. |
| `index.html` | Loads `sap-delta.js`; build bumped to 2026.10.16-3. |
| `sw.js` | Caches `sap-delta.js`; cache version v30. |
| `styles.css` | Appends the `.dlt-*` styles. |
| `package.json` | `npm run www` now copies `sap-delta.js` (needed for the Android build). |
| `README.md` | Documents the tool. |

No server, data or dependency changes. It uses the existing `vendor/xlsx-style.min.js`.
