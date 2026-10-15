// SAP CVA Orchestrator — browser port of SAP_CVA_Orchestrator_v2.pyw.
// Maps SAP Code Vulnerability Analyzer findings to CVA codes, then builds the same
// 13-sheet report workbook, the compact executive summary and the trend-history JSON.
// Runs as a Web Worker (new Worker('sap-cva-core.js')) and also loads on the page for helpers.
(function (root) {
  'use strict';

  // code: [description, section id, risk type, severity, RAG, keywords]
  const SECTIONS = {
    1: 'SQL Injection & Dynamic Open SQL / Native SQL',
    2: 'ABAP Command Injection & Dynamic Code Generation',
    3: 'Authorization & Security Check Handling',
    4: 'Dynamic Calls (CALL TRANSACTION/FUNCTION) & RFC Call Injections',
    5: 'OS Command Injection, File Access & Directory Traversal',
    6: 'Hard-coded Credentials, System Fingerprinting & Backdoors',
    7: 'Web Security (XSS, XSRF, Upload, Redirect, Tabnabbing)',
    8: 'Sensitive Table Access & Repository Manipulation'
  };
  // Kept as a list: object keys like "1101" would be re-ordered by JavaScript, and match order decides keyword ties.
  const RAW = [
    ["1101", "Possible SQL injection (WHERE condition)", 1, "SQL Injection", "Critical", "🔴", ["sql injection", "where condition", "dynamic where", "open sql injection"]],
    ["110A", "Potential manipulation of the dynamic WHERE condition of a wrapped SQL statement", 1, "SQL Injection", "Critical", "🔴", ["wrapped sql", "dynamic where condition", "wrapped sql statement"]],
    ["110B", "Potential read performed on an illegal database table in a wrapped SELECT statement", 1, "Illegal DB Table Access", "Critical", "🔴", ["illegal database table", "wrapped select", "illegal table"]],
    ["1112", "Possible SQL injection (SET clause)", 1, "SQL Injection", "Critical", "🔴", ["set clause", "sql injection set", "update set"]],
    ["1114", "Possible SQL injection (column names)", 1, "SQL Injection", "Critical", "🔴", ["column names", "invalid columns", "sql injection column"]],
    ["1116", "Possible SQL injection (GROUP BY clause)", 1, "SQL Injection", "Critical", "🔴", ["group by", "dynamic group by", "sql injection group"]],
    ["1117", "Possible SQL injection (HAVING clause)", 1, "SQL Injection", "Critical", "🔴", ["having clause", "dynamic having", "sql injection having"]],
    ["1118", "Possible SQL injection (table name when reading)", 1, "SQL Injection", "Critical", "🔴", ["table name when reading", "select statement", "illegal database table"]],
    ["1120", "Possible SQL injection (table name when writing)", 1, "SQL Injection", "Critical", "🔴", ["table name when writing", "modifying opensql", "dynamic table write"]],
    ["1122", "Possible SQL injection via object services", 1, "SQL Injection", "Critical", "🔴", ["object services", "i_filter", "sql injection via object"]],
    ["1128", "Possible SQL injection via ADBC (DDL)", 1, "Native SQL Injection", "Critical", "🔴", ["adbc ddl", "ddl statement", "native sql injection"]],
    ["1130", "Possible SQL injection via ADBC (DML)", 1, "Native SQL Injection", "Critical", "🔴", ["adbc dml", "dml statement", "native sql injection"]],
    ["11D1", "Potential SQL injection", 1, "SQL Injection", "Critical", "🔴", ["potential sql injection", "malicious sql", "sql statements"]],
    ["1108", "Possible ABAP command injection", 2, "ABAP Command Injection", "Critical", "🔴", ["abap command injection", "insert report", "generate subroutine pool"]],
    ["1109", "Possible ABAP command injection via RFC call", 2, "ABAP Command Injection", "Critical", "🔴", ["abap command injection via rfc", "rfc_abap_install_and_run"]],
    ["1170", "Call of system function CALL \"SYSTEM\"", 2, "OS Command Injection", "Critical", "🔴", ["call system", "call \"system\"", "system function"]],
    ["1171", "System function call with potential user input on FIELD", 2, "OS Command Injection", "Critical", "🔴", ["system function call", "potential user input", "field"]],
    ["1190", "The dynamic WHERE condition allows a potential code injection", 2, "Code Injection", "Critical", "🔴", ["dynamic where condition", "code injection", "internal table"]],
    ["11N1", "Invalid validation with class CL_ABAP_DYN_PRG", 2, "Invalid Validation", "High", "🔴", ["cl_abap_dyn_prg", "invalid validation"]],
    ["11N3", "Invalid validation (tautological value check) with class CL_ABAP_DYN_PRG", 2, "Invalid Validation", "High", "🔴", ["tautological", "cl_abap_dyn_prg", "invalid validation"]],
    ["1160", "AUTHORITY-CHECK without processing or sy-subrc", 3, "Authorization Check Handling", "High", "🔴", ["authority-check", "sy-subrc", "not evaluated"]],
    ["1161", "Call of a security-relevant method without handling the return value", 3, "Security Return Value Handling", "High", "🔴", ["security-relevant method", "return value", "not evaluated"]],
    ["1163", "Potentially security-relevant procedure without registration", 3, "Security Procedure Registration", "High", "🔴", ["security-relevant procedure", "without registration"]],
    ["1165", "Call of a security-relevant function without processing sy-subrc", 3, "Security Return Value Handling", "High", "🔴", ["security-relevant function", "sy-subrc"]],
    ["1180", "AUTHORITY-CHECK for specified user", 3, "Authorization Bypass Risk", "High", "🔴", ["authority-check for specified user", "specified user"]],
    ["1181", "AUTHORITY-CHECK for SY-UNAME", 3, "Authorization Bypass Risk", "High", "🔴", ["authority-check for sy-uname", "sy-uname"]],
    ["11A1", "Potentially missing authorization check in a Report", 3, "Missing Authorization", "High", "🔴", ["missing authorization", "report"]],
    ["11A2", "Potentially missing authorization check in an RFC function module", 3, "Missing Authorization", "High", "🔴", ["missing authorization", "rfc function module"]],
    ["11A3", "Potentially missing authorization check in a BOR object", 3, "Missing Authorization", "High", "🔴", ["missing authorization", "bor object"]],
    ["1140", "User-controlled dynamic CALL FUNCTION via RFC", 4, "Call Injection", "High", "🔴", ["dynamic call function", "via rfc", "call function"]],
    ["1141", "User-controlled dynamic program unit call", 4, "Call Injection", "High", "🔴", ["dynamic program unit call", "dynamic procedure call", "submit"]],
    ["1142", "User-controlled dynamic CALL TRANSACTION", 4, "Call Injection", "High", "🔴", ["dynamic call transaction", "user-controlled"]],
    ["1143", "User-controlled dynamic LEAVE TO TRANSACTION", 4, "Call Injection", "High", "🔴", ["leave to transaction", "dynamic leave"]],
    ["1144", "Dynamic function module call controllable from UI or via RFC", 4, "Call Injection", "High", "🔴", ["dynamic function module", "controllable from ui", "via rfc"]],
    ["114A", "Static CALL TRANSACTION without check of authorization object from SE93", 4, "Missing Authorization", "High", "🔴", ["static call transaction", "se93"]],
    ["114B", "Static CALL TRANSACTION without check of authorization object S_TCODE", 4, "Missing Authorization", "High", "🔴", ["static call transaction", "s_tcode"]],
    ["114C", "Static CALL TRANSACTION without authorization check", 4, "Missing Authorization", "High", "🔴", ["static call transaction", "without authorization check"]],
    ["114D", "Static CALL TRANSACTION without authorization check (restricted function)", 4, "Missing Authorization", "High", "🔴", ["restricted function", "without authorization check"]],
    ["114E", "Dynamic CALL TRANSACTION without authorization check", 4, "Missing Authorization", "High", "🔴", ["dynamic call transaction", "without authorization check"]],
    ["114F", "Dynamic CALL TRANSACTION with data flow and without authorization check", 4, "Missing Authorization", "High", "🔴", ["dynamic call transaction", "data flow", "without authorization"]],
    ["114G", "Dynamic CALL TRANSACTION with data flow, authorization check on S_TCODE", 4, "Incomplete Authorization", "High", "🔴", ["dynamic call transaction", "s_tcode", "data flow"]],
    ["114H", "Dynamic CALL TRANSACTION without authorization check", 4, "Missing Authorization", "High", "🔴", ["dynamic call transaction", "without authorization check"]],
    ["1104", "Possible directory traversal", 5, "Directory Traversal", "High", "🔴", ["directory traversal", "open dataset", "delete dataset", "file name"]],
    ["1106", "Possible system command injection (addition FILTER)", 5, "OS Command Injection", "Critical", "🔴", ["system command injection", "filter addition", "open dataset filter"]],
    ["1107", "FILTER addition of the statement OPEN DATASET used", 5, "OS Command Injection", "High", "🔴", ["filter addition", "open dataset"]],
    ["1124", "Possible Directory Traversal via file utilities class", 5, "Directory Traversal", "High", "🔴", ["directory traversal", "file utilities class", "create_utf8_file_with_bom"]],
    ["1126", "Potential directory traversal due to insecure parameters", 5, "Directory Traversal", "High", "🔴", ["directory traversal", "insecure parameters", "file_get_name"]],
    ["0821", "Hard-coded user name", 6, "Backdoor Indicator", "Medium", "🟡", ["hard-coded user", "hardcoded user", "user name", "back door"]],
    ["11K1", "Hard-coded password", 6, "Hard-coded Credential", "Critical", "🔴", ["hard-coded password", "hardcoded password"]],
    ["11K2", "Field with hard-coded password", 6, "Hard-coded Credential", "Critical", "🔴", ["field with hard-coded password", "password field"]],
    ["11K3", "Field with Base64-encoded password", 6, "Encoded Credential", "Critical", "🔴", ["base64 password", "base64-encoded password"]],
    ["11S1", "Hard-coded host name", 6, "System Fingerprinting", "Medium", "🟡", ["hard-coded host", "sy-host"]],
    ["11S2", "Hard-coded system ID", 6, "System Fingerprinting", "Medium", "🟡", ["hard-coded system id", "sy-sysid"]],
    ["11S3", "Hard-coded client", 6, "System Fingerprinting", "Medium", "🟡", ["hard-coded client", "sy-mandt"]],
    ["11S4", "Comparison of a specific registered system variable with a fixed value", 6, "Backdoor Indicator", "Medium", "🟡", ["system variable", "fixed value", "hard-coded value"]],
    ["11SP", "Potential back doors", 6, "Backdoor Indicator", "High", "🔴", ["potential back doors", "backdoor", "back door"]],
    ["1132", "Possible cross-site scripting", 7, "Cross-Site Scripting", "High", "🔴", ["cross-site scripting", "xss"]],
    ["1134", "Potential reflected cross-site scripting", 7, "Reflected XSS", "High", "🔴", ["reflected cross-site scripting", "reflected xss"]],
    ["1135", "Potentially manipulated HTML page in HTML control", 7, "HTML Manipulation", "High", "🔴", ["html page", "html control", "manipulated html"]],
    ["1150", "Usage of an obsolete escaping method", 7, "Unsafe Output Encoding", "Medium", "🟡", ["obsolete escaping", "obsolete escape"]],
    ["1151", "forceEncode=\"not specified\" for htmlb:content", 7, "Unsafe Output Encoding", "Medium", "🟡", ["forceencode", "htmlb:content"]],
    ["1152", "In tag htmlb:content an obsolete design is specified or none at all", 7, "Unsafe UI Design", "Medium", "🟡", ["htmlb:content", "obsolete design"]],
    ["11F1", "Missing Content Check During HTTP Upload", 7, "Unsafe Upload", "High", "🔴", ["http upload", "missing content check", "upload"]],
    ["11P1", "Open URL redirect", 7, "Open Redirect", "Medium", "🟡", ["open redirect", "url redirect", "unvalidated url"]],
    ["11R1", "Potential reverse tabnabbing", 7, "Reverse Tabnabbing", "Medium", "🟡", ["reverse tabnabbing", "tabnabbing"]],
    ["11RF", "The BSP application is not protected against XSRF", 7, "XSRF / CSRF", "High", "🔴", ["xsrf", "csrf", "bsp application", "not protected against xsrf"]],
    ["1110", "Potentially important reports deleted from the ABAP repository", 8, "Repository Manipulation", "High", "🔴", ["reports deleted", "abap repository", "repository deletion"]],
    ["11C1", "Use of command COMMUNICATION", 8, "System Communication Risk", "Medium", "🟡", ["command communication", "communication used"]],
    ["11G0", "Direct read access to critical database tables", 8, "Sensitive Data Exposure", "High", "🔴", ["critical database tables", "sensitive database table", "read access"]],
    ["11G1", "Write access to sensitive database tables", 8, "Sensitive Data Manipulation", "High", "🔴", ["sensitive database table", "write access", "write performed"]]
  ];
  const CVA_MASTER = {}, CVA_LIST = [];
  for (const [code, description, section_id, risk_type, severity, rag, keywords] of RAW)
    CVA_LIST.push([code, CVA_MASTER[code] = { description, section_id, section_name: SECTIONS[section_id], risk_type, severity, rag, keywords }]);

  const JSON_TEMPLATES = {
    applications: { filename: 'applications.json', content: {
      APP001: { system_no: 'S4H100', system_name: 'S/4HANA Production', business_area: 'Finance' },
      APP002: { system_no: 'ECC200', system_name: 'ECC Sandbox', business_area: 'Supply Chain' } } },
    history: { filename: 'SAP_CVA_History.json', content: [
      { 'Application ID': 'APP001', Systems: 'S4H100', 'System Name': 'S/4HANA Production', 'Run-date': '2026-08-01', 'Priority 1': 12, 'Priority 2': 34, 'Priority 3': 8, 'Priority 4': 2 },
      { 'Application ID': 'APP001', Systems: 'S4H100', 'System Name': 'S/4HANA Production', 'Run-date': '2026-09-01', 'Priority 1': 9, 'Priority 2': 28, 'Priority 3': 6, 'Priority 4': 1 }] }
  };

  // ---------- applications.json ----------
  function parseApplications(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('applications.json must contain an object mapping Application ID to its details.');
    const mapping = {}, errors = [];
    for (const [id, d] of Object.entries(raw)) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) { errors.push(`'${id}': expected an object with system_no, system_name, business_area`); continue; }
      const v = k => String(d[k] ?? '').trim();
      if (!(String(id).trim() && v('system_no') && v('system_name') && v('business_area'))) { errors.push(`'${id}': values cannot be blank`); continue; }
      mapping[String(id)] = { system_no: v('system_no'), system_name: v('system_name'), business_area: v('business_area') };
    }
    if (errors.length) throw new Error('Invalid applications.json configuration:\n\n' + errors.join('\n'));
    return mapping;
  }

  // ---------- mapping ----------
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const CODES_SORTED = Object.keys(CVA_MASTER).sort((a, b) => b.length - a.length);
  const CODE_RE = new RegExp('\\b(?:' + CODES_SORTED.map(reEsc).join('|') + ')\\b', 'i');
  const CANON = Object.fromEntries(Object.keys(CVA_MASTER).map(c => [c.toUpperCase(), c]));
  const normalize = v => v == null ? '' : String(v).replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const MATCH_DATA = CVA_LIST.map(([code, m]) => [code, normalize(m.description), (m.keywords || []).map(normalize)]);

  function keywordMatch(text) {
    const t = normalize(text);
    if (!t) return [null, 0];
    let best = null, bestScore = 0;
    for (const [code, desc, kws] of MATCH_DATA) {
      let s = 0;
      if (desc && t.includes(desc)) s += 100;
      for (const kw of kws) if (kw && t.includes(kw)) s += 20 + kw.split(' ').length;
      if (s > bestScore) { bestScore = s; best = code; }
    }
    return bestScore >= 20 ? [best, bestScore] : [null, bestScore];
  }
  const MAPPED_COLS = ['CVA Code', 'CVA Description', 'CVA Section ID', 'CVA Section Name', 'Risk Type', 'Severity', 'RAG', 'Mapping Method', 'Mapping Confidence'];
  function mapText(text) {
    const m = CODE_RE.exec(text);
    let code = m ? CANON[m[0].toUpperCase()] : null, method = 'Code Match', conf = 100;
    if (!code) { [code, conf] = keywordMatch(text); method = code ? 'Keyword Match' : 'Unmapped'; }
    if (code && CVA_MASTER[code]) { const x = CVA_MASTER[code]; return [code, x.description, x.section_id, x.section_name, x.risk_type, x.severity, x.rag, method, conf]; }
    return ['', '', '', '', '', 'Unmapped', '⚪', 'Unmapped', 0];
  }

  // ---------- priority ----------
  const PRIORITY_MAP = { Critical: 'P1', High: 'P2', Medium: 'P3', Low: 'P4', Unmapped: 'Unmapped', '': 'Unmapped' };
  const PRIORITY_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, Unmapped: 5 };
  const prOrd = p => PRIORITY_ORDER[p] ?? 99;
  const priorityOf = sev => sev == null ? 'Unmapped' : (PRIORITY_MAP[String(sev).trim()] ?? 'P3');

  // ---------- small table model (keeps duplicate column names, like pandas) ----------
  // T = { cols: [..], rows: [[..], ..] }
  const lastIdx = (T, name) => T.cols.lastIndexOf(name);
  const colIdx = (T, names) => { const want = new Set(names.map(x => String(x).trim().toLowerCase())); for (let i = T.cols.length - 1; i >= 0; i--) if (want.has(String(T.cols[i]).trim().toLowerCase())) return i; return -1; };
  const sortStable = (arr, cmp) => arr.map((v, i) => [v, i]).sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1]).map(x => x[0]);
  const cmpAny = (a, b) => { const ta = typeof a, tb = typeof b; if (ta !== tb) return ta === 'number' ? -1 : tb === 'number' ? 1 : 0; return a < b ? -1 : a > b ? 1 : 0; };

  function withPriority(T) {
    const si = lastIdx(T, 'Severity'), pi = T.cols.indexOf('Priority');
    const cols = pi >= 0 ? T.cols.slice() : [...T.cols, 'Priority'];
    const at = pi >= 0 ? pi : cols.length - 1;
    const rows = T.rows.map(r => { const o = r.slice(); while (o.length < cols.length) o.push(''); o[at] = si < 0 ? 'Unmapped' : priorityOf(r[si]); return o; });
    return { cols, rows };
  }
  function groupCount(T, keys) {
    const idx = keys.map(k => lastIdx(T, k)), m = new Map();
    for (const r of T.rows) { const kv = idx.map(i => i < 0 ? '' : r[i]); const k = JSON.stringify(kv); const e = m.get(k); e ? e[1]++ : m.set(k, [kv, 1]); }
    let g = [...m.values()].sort((a, b) => { for (let i = 0; i < keys.length; i++) { const c = cmpAny(a[0][i], b[0][i]); if (c) return c; } return 0; });
    g = sortStable(g, (a, b) => b[1] - a[1]);
    return { cols: [...keys, 'Count'], rows: g.map(([kv, n]) => [...kv, n]) };
  }
  function createSummaries(T) {
    return [groupCount(T, ['Severity', 'RAG']), groupCount(T, ['CVA Section ID', 'CVA Section Name']), groupCount(T, ['Risk Type']),
      groupCount(T, ['CVA Code', 'CVA Description', 'CVA Section Name', 'Risk Type', 'Severity', 'RAG'])];
  }
  function masterTable() {
    const rows = CVA_LIST.map(([c, m]) => [c, m.description, m.section_id, m.section_name, m.risk_type, m.severity, m.rag, m.keywords.join(', ')]);
    rows.sort((a, b) => a[2] - b[2] || cmpAny(a[0], b[0]));
    return { cols: ['CVA Code', 'CVA Description', 'CVA Section ID', 'CVA Section Name', 'Risk Type', 'Severity', 'RAG', 'Keywords'], rows };
  }
  function codePriorityTable() {
    let rows = CVA_LIST.map(([c, m]) => [c, m.description, m.section_id, m.section_name, m.risk_type, m.severity, priorityOf(m.severity), m.rag, m.keywords.join(', ')]);
    rows = rows.sort((a, b) => prOrd(a[6]) - prOrd(b[6]) || cmpAny(a[0], b[0]));
    return { cols: ['CVA Code', 'CVA Description', 'CVA Section ID', 'CVA Section Name', 'Risk Type', 'Severity', 'Priority', 'RAG', 'Keywords'], rows };
  }
  function backlogTable(M) {
    const pref = ['CVA Code', 'CVA Description', 'CVA Section ID', 'CVA Section Name', 'Risk Type', 'Severity', 'Priority', 'RAG', 'Mapping Method', 'Mapping Confidence'];
    const pi = lastIdx(M, 'Priority');
    const order = [...pref.map(c => lastIdx(M, c)).filter(i => i >= 0), ...M.cols.map((c, i) => i).filter(i => !pref.includes(M.cols[i]))];
    const cols = order.map(i => M.cols[i]);
    let rows = M.rows.filter(r => r[pi] === 'P1' || r[pi] === 'P2').map(r => order.map(i => r[i]));
    const npi = cols.indexOf('Priority'), nci = cols.indexOf('CVA Code');
    rows = sortStable(rows, (a, b) => prOrd(a[npi]) - prOrd(b[npi]) || (nci >= 0 ? cmpAny(a[nci], b[nci]) : 0));
    return { cols, rows };
  }
  const RAG_BUCKET = { '🔴': 'Red_RAG', '🟡': 'Amber_RAG', '🟢': 'Green_RAG', '⚪': 'Unmapped_RAG' };
  function heatmapTable(M) {
    const cols = ['Priority', 'Red_RAG', 'Amber_RAG', 'Green_RAG', 'Unmapped_RAG', 'Total'];
    if (!M.rows.length) return { cols, rows: [] };
    const pi = lastIdx(M, 'Priority'), ri = lastIdx(M, 'RAG'), m = new Map();
    for (const r of M.rows) {
      const p = pi < 0 || r[pi] === '' || r[pi] == null ? 'Unmapped' : r[pi];
      const b = RAG_BUCKET[ri < 0 ? '⚪' : r[ri]] || 'Unmapped_RAG';
      if (!m.has(p)) m.set(p, { Red_RAG: 0, Amber_RAG: 0, Green_RAG: 0, Unmapped_RAG: 0 });
      m.get(p)[b]++;
    }
    const rows = [...m.entries()].sort((a, b) => cmpAny(a[0], b[0])).sort((a, b) => prOrd(a[0]) - prOrd(b[0]))
      .map(([p, c]) => [p, c.Red_RAG, c.Amber_RAG, c.Green_RAG, c.Unmapped_RAG, c.Red_RAG + c.Amber_RAG + c.Green_RAG + c.Unmapped_RAG]);
    return { cols, rows };
  }
  const OBJ_NAMES = ['Object name', 'Object Name', 'Object', 'Object_Name', 'ObjectName', 'Program', 'Program Name', 'Include', 'Include Name'];
  const TYPE_NAMES = ['Object Type', 'Object type', 'Object_Type', 'ObjectType', 'Type'];
  function uniqueObjectTable(M) {
    const cols = ['Object Name', 'Object Type', 'Highest Priority', 'Highest Severity', 'RAG', 'Total Findings', 'Unique CVA Codes'];
    const oi = colIdx(M, OBJ_NAMES), ti = colIdx(M, TYPE_NAMES);
    if (!M.rows.length || oi < 0) return { cols, rows: [] };
    const pi = lastIdx(M, 'Priority'), si = lastIdx(M, 'Severity'), ri = lastIdx(M, 'RAG'), ci = lastIdx(M, 'CVA Code');
    const s = (r, i, d) => i < 0 ? d : String(r[i] ?? d).trim();
    const groups = new Map();
    for (const r of M.rows) {
      const name = s(r, oi, ''); if (!name) continue;
      const kind = s(r, ti, ''), k = name + '\u0000' + kind;
      const w = { p: s(r, pi, 'Unmapped'), sev: s(r, si, 'Unmapped'), rag: s(r, ri, '⚪'), code: s(r, ci, '') };
      const g = groups.get(k); g ? g.items.push(w) : groups.set(k, { name, kind, items: [w] });
    }
    let rows = [...groups.values()].map(g => {
      const top = g.items.reduce((a, b) => prOrd(b.p) < prOrd(a.p) ? b : a);
      return [g.name, g.kind, top.p, top.sev, top.rag, g.items.length, [...new Set(g.items.map(x => x.code).filter(Boolean))].sort().join(', ')];
    });
    rows = sortStable(rows, (a, b) => prOrd(a[2]) - prOrd(b[2]) || b[5] - a[5] || cmpAny(a[0], b[0]));
    return { cols, rows };
  }
  function cannotMapTable(U) {
    const h = ['CVA Mapping Status', 'Reason Not Mapped', 'Required Action'];
    if (!U.rows.length) return { cols: [...h, 'CVA Code', 'CVA Description', 'Priority'], rows: [] };
    const P = withPriority(U), keep = P.cols.map((c, i) => i).filter(i => !h.includes(P.cols[i]));
    return { cols: [...h, ...keep.map(i => P.cols[i])], rows: P.rows.map(r => ['CANNOT BE MAPPED TO CVA CODE', 'No CVA code or keyword match was found in the current CVA master mapping', 'Manual review required', ...keep.map(i => r[i])]) };
  }
  const countPrio = U => { const c = { P1: 0, P2: 0, P3: 0, P4: 0, Unmapped: 0 }; for (const r of U.rows) c[r[2]] = (c[r[2]] || 0) + 1; return c; };
  function appSummaryTable(U, app) {
    const c = countPrio(U);
    return { cols: ['Applications ID', 'Systems No', 'System Name', 'Business Area', 'Prio 1', 'Prio 2', 'Prio 3', 'Prio 4'],
      rows: [[app.id, app.system_no, app.system_name, app.business_area, c.P1, c.P2, c.P3, c.P4]] };
  }

  // ---------- Excel writing (xlsx-js-style) ----------
  const FILL = { red: 'FFC7CE', amber: 'FFEB9C', green: 'C6EFCE', blue: 'D9E1F2', p4: 'D9EAD3' };
  const RAG_FILL = { '🔴': FILL.red, '🟡': FILL.amber, '🟢': FILL.green, '⚪': FILL.blue };
  const PRIO_FILL = { P1: FILL.red, P2: FILL.amber, P3: FILL.green, P4: FILL.p4, Unmapped: FILL.blue };
  const fill = rgb => ({ patternType: 'solid', fgColor: { rgb } });
  const HEADER_STYLE = { fill: fill('1F4E78'), font: { bold: true, color: { rgb: 'FFFFFF' } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } };

  function makeSheet(X, T) {
    const ws = X.utils.aoa_to_sheet([T.cols, ...T.rows], { cellDates: true });
    const nc = Math.max(T.cols.length, 1), nr = T.rows.length + 1;
    for (let c = 0; c < T.cols.length; c++) { const a = X.utils.encode_cell({ r: 0, c }); if (ws[a]) ws[a].s = HEADER_STYLE; }
    const last = Math.min(nr, 251), widths = [];   // autosize from the header and up to 250 rows
    for (let c = 0; c < nc; c++) {
      let mx = 0;
      for (let r = 0; r < last; r++) { const v = r ? T.rows[r - 1][c] : T.cols[c]; const l = v == null ? 0 : (v instanceof Date ? 19 : [...String(v)].length); if (l > mx) { mx = l; if (mx >= 58) break; } }
      widths.push({ wch: Math.min(Math.max(mx + 2, 12), 60) });
    }
    ws['!cols'] = widths;
    if (T.cols.length) ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: nr - 1, c: nc - 1 } }) };
    ws.__freeze = true;
    return ws;
  }
  const paint = (X, ws, T, col, fn, extra) => {
    const c = typeof col === 'number' ? col : T.cols.lastIndexOf(col); if (c < 0) return;
    for (let r = 0; r < T.rows.length; r++) { const rgb = fn(T.rows[r][c], r); if (!rgb) continue; const a = X.utils.encode_cell({ r: r + 1, c }); ws[a] ||= { t: 's', v: '' }; ws[a].s = { fill: fill(rgb), ...(extra || {}) }; }
  };

  function buildReport(X, mapped, unmapped, app) {
    const M = withPriority(mapped), U = withPriority(unmapped);
    const [bySev, bySec, byRisk, byCode] = createSummaries(mapped);
    const uniq = uniqueObjectTable(M);
    const sheets = [
      ['Mapped_Data', M], ['Summary_By_Severity', bySev], ['Summary_By_Section', bySec], ['Summary_By_Risk', byRisk], ['Summary_By_Code', byCode],
      ['Unmapped', U], ['CVA_Master', masterTable()], ['Code_Priority_Mapping', codePriorityTable()], ['P1_P2_Backlog', backlogTable(M)],
      ['RAG_vs_Priority_Heatmap', heatmapTable(M)], ['Unique_Object_Priority', uniq], ['Cannot_Map_To_CVA', cannotMapTable(U)],
      ['Application_System_Summary', appSummaryTable(uniq, app)]
    ];
    const wb = X.utils.book_new(), tabs = {};
    for (const [name, T] of sheets) {
      const ws = makeSheet(X, T);
      if (name === 'Mapped_Data') {
        const ri = T.cols.lastIndexOf('RAG'), si = T.cols.lastIndexOf('Severity');
        paint(X, ws, T, 'RAG', v => RAG_FILL[v]);
        if (ri >= 0 && si >= 0) paint(X, ws, T, si, (v, r) => RAG_FILL[T.rows[r][ri]]);
        paint(X, ws, T, 'Priority', v => v !== 'Unmapped' && PRIO_FILL[v]);
      }
      if (name === 'P1_P2_Backlog') paint(X, ws, T, 'Priority', v => (v === 'P1' || v === 'P2') && PRIO_FILL[v]);
      if (name === 'RAG_vs_Priority_Heatmap') {
        const H = { Red_RAG: FILL.red, Amber_RAG: FILL.amber, Green_RAG: FILL.green, Unmapped_RAG: FILL.blue };
        T.cols.forEach((c, i) => { if (!H[c]) return; ws[X.utils.encode_cell({ r: 0, c: i })].s = { ...HEADER_STYLE, fill: fill(H[c]), font: { bold: true, color: { rgb: '000000' } } }; paint(X, ws, T, i, () => H[c]); });
      }
      if (name === 'Cannot_Map_To_CVA') {
        tabs[name] = 'C00000';
        paint(X, ws, T, 0, () => FILL.red, { font: { bold: true, color: { rgb: '9C0006' } } });
        paint(X, ws, T, 1, () => 'FCE4D6'); paint(X, ws, T, 2, () => 'FFF2CC');
        Object.assign(ws['!cols'][0] || {}, { wch: 34 }); if (ws['!cols'][1]) ws['!cols'][1] = { wch: 68 }; if (ws['!cols'][2]) ws['!cols'][2] = { wch: 28 }; ws['!cols'][0] = { wch: 34 };
      }
      if (name === 'Unique_Object_Priority') {
        tabs[name] = '4472C4';
        paint(X, ws, T, 'Highest Priority', v => PRIO_FILL[v]);
        const c = { P1: 0, P2: 0, P3: 0, P4: 0, Unmapped: 0 }; T.rows.forEach(r => { if (r[2] in c) c[r[2]]++; });
        X.utils.sheet_add_aoa(ws, [['Priority', 'Unique Objects'], ...['P1', 'P2', 'P3', 'P4', 'Unmapped'].map(p => [p, c[p]]), ['Total Unique Objects', T.rows.length]], { origin: 'I1' });
        ['P1', 'P2', 'P3', 'P4', 'Unmapped'].forEach((p, i) => { ws['I' + (i + 2)].s = { fill: fill(PRIO_FILL[p]) }; });
      }
      if (name === 'Application_System_Summary') {
        tabs[name] = '70AD47';
        ['Prio 1', 'Prio 2', 'Prio 3', 'Prio 4'].forEach((h, i) => paint(X, ws, T, h, () => [FILL.red, FILL.amber, FILL.green, FILL.p4][i], { alignment: { horizontal: 'center' } }));
        [22, 18, 22, 20].forEach((w, i) => { ws['!cols'][i] = { wch: w }; });
      }
      X.utils.book_append_sheet(wb, ws, name);
    }
    return { buf: finishWorkbook(X, wb, tabs), uniq };
  }

  // SheetJS can't write frozen panes or tab colours, so patch the sheet XML inside the package.
  function finishWorkbook(X, wb, tabs) {
    const out = new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx', compression: true, bookSST: true }));
    const z = X.CFB.read(out, { type: 'array' }), enc = new TextEncoder(), dec = new TextDecoder();
    wb.SheetNames.forEach((name, i) => {
      const fi = z.FullPaths.findIndex(p => p.endsWith(`xl/worksheets/sheet${i + 1}.xml`)); if (fi < 0) return;
      const e = z.FileIndex[fi]; let xml = dec.decode(e.content);
      xml = xml.replace('<sheetView workbookViewId="0"/>', '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>');
      if (tabs[name]) {
        const tc = `<tabColor rgb="FF${tabs[name]}"/>`;
        xml = /<sheetPr[^>]*\/>/.test(xml) ? xml.replace(/<sheetPr([^>]*)\/>/, `<sheetPr$1>${tc}</sheetPr>`)
          : /<sheetPr[^>]*>/.test(xml) ? xml.replace(/<sheetPr([^>]*)>/, `<sheetPr$1>${tc}`)
          : xml.replace(/(<worksheet[^>]*>)/, `$1<sheetPr>${tc}</sheetPr>`);
      }
      e.content = enc.encode(xml); e.size = e.content.length;
    });
    return X.CFB.write(z, { fileType: 'zip', type: 'array', compression: true });
  }

  function buildCompactSummary(X, records) {
    const cols = ['Application ID', 'Systems', 'System Name', 'Run-date', 'Priority 1', 'Priority 2', 'Priority 3', 'Priority 4'];
    const T = { cols, rows: records.map(r => cols.map(c => r[c] ?? '')) };
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, makeSheet(X, T), 'Consolidated_View');
    return finishWorkbook(X, wb, {});
  }

  // ---------- reading the source workbook ----------
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const asText = v => v == null ? '' : v instanceof Date ? stamp(v) : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);

  function readSource(X, buf, sheet) {
    const wb = X.read(buf, { type: 'array', cellDates: true, sheets: sheet, dense: true });
    const ws = wb.Sheets[sheet]; if (!ws) throw new Error(`Worksheet "${sheet}" was not found.`);
    const aoa = X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
    if (!aoa.length) return { cols: [], rows: [] };
    const seen = {}, cols = aoa[0].map((h, i) => {
      let n = h === '' || h == null ? `Unnamed: ${i}` : asText(h);
      if (seen[n] != null) { let k = ++seen[n]; while (seen[`${n}.${k}`] != null) k++; n = `${n}.${k}`; }
      seen[n] = seen[n] ?? 0; return n.trim();
    });
    const rows = aoa.slice(1).map(r => { const o = r.slice(0, cols.length); while (o.length < cols.length) o.push(''); return o; });
    return { cols, rows };
  }
  // pandas "object" columns: any text/blank cell, or mixed value types
  function textColumns(T) {
    const out = [];
    T.cols.forEach((c, i) => { const kinds = new Set(); for (const r of T.rows) { const v = r[i]; if (typeof v === 'string') { kinds.add('s'); break; } kinds.add(v instanceof Date ? 'd' : typeof v); } if (kinds.has('s') || kinds.size > 1) out.push(i); });
    return out;
  }

  // ---------- one file, end to end ----------
  const safeName = v => String(v).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Unknown';
  function processFile(X, job, log) {
    const t0 = Date.now(), app = job.app, tag = m => log(`[${app.system_no}] ${job.name} | ${m}`);
    tag('START'); tag(`Application ID: ${app.id}; worksheet: ${job.sheet}`);
    let st = Date.now();
    const S = readSource(X, job.buffer, job.sheet);
    tag(`READ COMPLETE | rows=${S.rows.length.toLocaleString()}; columns=${S.cols.length.toLocaleString()}; elapsed=${((Date.now() - st) / 1000).toFixed(2)}s`);
    let use = textColumns(S); if (!use.length) use = S.cols.map((c, i) => i);
    tag(`MAPPING START | text columns=${use.length}`);
    st = Date.now();
    let exact = 0, kw = 0, lastB = -1;
    const mappedCols = S.rows.map((r, n) => {
      const res = mapText(use.map(i => asText(r[i])).join(' | '));
      if (res[7] === 'Code Match') exact++; else if (res[7] === 'Keyword Match') kw++;
      const pct = Math.floor((n + 1) * 100 / S.rows.length), b = Math.floor(pct / 10) * 10;
      if (b !== lastB && b >= 10) { lastB = b; tag(`MAPPING ${b}% | ${(n + 1).toLocaleString()}/${S.rows.length.toLocaleString()} rows`); }
      return res;
    });
    tag(`MAPPING COMPLETE | exact=${exact.toLocaleString()}; keyword=${kw.toLocaleString()}; unmapped=${(S.rows.length - exact - kw).toLocaleString()}; elapsed=${((Date.now() - st) / 1000).toFixed(2)}s`);
    st = Date.now();
    const APPC = ['Application ID', 'System Number', 'System Name', 'Business Area'];
    const keep = S.cols.map((c, i) => i).filter(i => !APPC.includes(S.cols[i]));
    const now = stamp(new Date());
    const mapped = { cols: [...APPC, ...keep.map(i => S.cols[i]), ...MAPPED_COLS, 'Source File', 'Source Sheet', 'Processed On'],
      rows: S.rows.map((r, n) => [app.id, app.system_no, app.system_name, app.business_area, ...keep.map(i => r[i]), ...mappedCols[n], job.name, job.sheet, now]) };
    const mi = mapped.cols.lastIndexOf('Mapping Method');
    const unmapped = { cols: mapped.cols, rows: mapped.rows.filter(r => r[mi] === 'Unmapped') };
    tag(`SUMMARY COMPLETE | mapped=${(mapped.rows.length - unmapped.rows.length).toLocaleString()}; unmapped=${unmapped.rows.length.toLocaleString()}; elapsed=${((Date.now() - st) / 1000).toFixed(2)}s`);
    const filename = `${safeName(app.system_name)}_${app.system_no}_${app.id}_CVA_Report.xlsx`;
    tag(`EXPORT START | ${filename}`); st = Date.now();
    const { buf, uniq } = buildReport(X, mapped, unmapped, app);
    tag(`EXPORT COMPLETE | elapsed=${((Date.now() - st) / 1000).toFixed(2)}s; size=${(buf.length / 1048576).toFixed(2)} MB`);
    const c = countPrio(uniq);
    const compact = { 'Application ID': app.id, Systems: app.system_no, 'System Name': app.system_name, 'Run-date': job.run_date || stamp(new Date()).slice(0, 10),
      'Priority 1': c.P1, 'Priority 2': c.P2, 'Priority 3': c.P3, 'Priority 4': c.P4 };
    tag(`PRIORITY COMPLETE | unique objects=${uniq.rows.length.toLocaleString()}; P1=${c.P1}; P2=${c.P2}; P3=${c.P3}; P4=${c.P4}`);
    tag(`COMPLETE | total elapsed=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    return { filename, buf, compact, stats: { rows: S.rows.length, exact, keyword: kw, unmapped: S.rows.length - exact - kw, objects: uniq.rows.length } };
  }

  function runBatch(X, msg, log, progress) {
    const t0 = Date.now(), results = [];
    log(`Starting ${msg.jobs.length} file${msg.jobs.length === 1 ? '' : 's'}.`);
    msg.jobs.forEach((job, i) => {
      try { results.push(processFile(X, job, log)); }
      catch (e) { throw new Error(`${job.name}: ${e.message}`); }
      log(`Completed ${i + 1}/${msg.jobs.length}: ${job.name}`);
      progress(Math.round((i + 1) / msg.jobs.length * 90));
    });
    let history = null;
    if (msg.keepHistory) {
      log('HISTORY JSON | START');
      history = (msg.subsequent && Array.isArray(msg.history) ? msg.history.slice() : []).concat(results.map(r => r.compact));
      log(`HISTORY JSON | COMPLETE | total runs recorded=${history.length}`);
    }
    let summary = null;
    if (msg.makeSummary) {
      log('SUMMARY WORKBOOK | START');
      const recs = history || results.map(r => r.compact);
      summary = buildCompactSummary(X, recs);
      log(`SUMMARY WORKBOOK | COMPLETE | rows=${recs.length}${history ? ' (full history)' : ' (this run only)'}`);
    }
    log(`BATCH COMPLETE | files=${results.length}; total elapsed=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    progress(100);
    return { results, history, summary };
  }

  const api = { CVA_MASTER, JSON_TEMPLATES, parseApplications, mapText, keywordMatch, runBatch, safeName };
  root.SapCva = api;

  // ---------- worker entry ----------
  if (typeof importScripts === 'function' && typeof document === 'undefined') {
    self.onmessage = ({ data: msg }) => {
      try {
        if (!self.XLSX) importScripts('vendor/xlsx-style.min.js');
        const log = text => self.postMessage({ type: 'log', text });
        const progress = pct => self.postMessage({ type: 'progress', pct });
        const out = runBatch(self.XLSX, msg, log, progress);
        const transfer = [...out.results.map(r => r.buf.buffer), ...(out.summary ? [out.summary.buffer] : [])];
        self.postMessage({ type: 'done', ...out }, transfer);
      } catch (e) { self.postMessage({ type: 'error', message: e.message || String(e) }); }
    };
  }
})(typeof self !== 'undefined' ? self : this);
