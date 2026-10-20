// Toolbox+ › SAP tools › Remediation Project Planner (page script; kept in its own file because the server only allows scripts from 'self').
const GROUPS=[{"name":"SQL injection (dynamic Open/Native SQL)","cat":"T","pfx":["Potential SQL injection"],"codes":["1101","110A","110B","1112","1114","1116","1117","1118","1120","1122","1128","1130","11D1"],"k94":232,"real":[0,4.82,0,1.36],"cons":[0,4.82,0,2.27]},
{"name":"Code injection via dynamic WHERE","cat":"T","pfx":["Dynamic WHERE condition"],"codes":["1190"],"k94":3,"real":[0,11,0,1.4],"cons":[0,11,0,2.33]},
{"name":"Authority-check result handling (sy-subrc, SY-UNAME)","cat":"T","pfx":["AUTHORITY-CHECK without sy-subrc","Security-relevant function call","AUTHORITY-CHECK for SY-UNAME"],"codes":["1161","1165","1181"],"k94":66,"real":[0,1,0,0.84],"cons":[0,1,0,1.39]},
{"name":"Static CALL TRANSACTION without authority check","cat":"T","pfx":["Static CALL TRANSACTION"],"codes":["114A","114B","114C","114D"],"k94":653,"real":[0,0.98,0,0.73],"cons":[0,0.98,0,1.21]},
{"name":"Dynamic calls (CALL TRANSACTION / FM / program)","cat":"T","pfx":["Dynamic CALL TRANSACTION","User-driven","UI-driven"],"codes":["1140","1141","1142","1143","1144","114E","114F","114G","114H"],"k94":106,"real":[0,2.62,0,0.96],"cons":[0,2.62,0,1.59]},
{"name":"Directory / file traversal","cat":"T","pfx":["Potential directory traversal"],"codes":["1104","1124","1126"],"k94":516,"real":[0.18,2.4,0,0.76],"cons":[0.18,2.4,0,1.27]},
{"name":"Web security (XSS, XSRF, upload)","cat":"T","pfx":["Potential cross-site","Potential reflected","BSP application"],"codes":["1132","1134","1135","11RF","11F1"],"k94":102,"real":[0,2.45,0,1.04],"cons":[0,2.45,0,1.74]},
{"name":"ABAP / OS command injection","cat":"R","pfx":["Potential ABAP command","System function call"],"codes":["1106","1108","1109","1170","1171"],"k94":254,"real":[0,9.95,3,4.91],"cons":[0,9.95,3,4.91]},
{"name":"Hard-coded passwords","cat":"R","pfx":["Potential hard-coded password"],"codes":["11K1","11K2","11K3"],"k94":15,"real":[0,4,2,2.87],"cons":[0,4,2,2.87]},
{"name":"Missing authority check – reports","cat":"R","pfx":["Missing authority check in ABAP report"],"codes":["11A1"],"k94":2430,"real":[0.25,0.4,0.2,0.43],"cons":[0.5,1.2,0.9,0.82]},
{"name":"Missing authority check – RFC / BOR","cat":"R","pfx":["Missing authority check in RFC","Missing authority check in BOR"],"codes":["11A2","11A3"],"k94":450,"real":[0.5,2.4,1.13,2.89],"cons":[0.5,2.4,1.5,2.89]},
{"name":"AUTHORITY-CHECK for a specified user","cat":"R","pfx":["AUTHORITY-CHECK with explicitly"],"codes":["1180"],"k94":16,"real":[0,2.41,1.5,1.81],"cons":[0,2.41,1.5,1.81]},
{"name":"Sensitive table READ access","cat":"R","pfx":["Read on sensitive"],"codes":["11G0"],"k94":5835,"real":[0.1,0.42,0.1,0.1],"cons":[0.25,1.27,0.3,0.3]},
{"name":"Sensitive table WRITE access","cat":"R","pfx":["Write on sensitive"],"codes":["11G1"],"k94":394,"real":[0.5,8.14,3,2.82],"cons":[0.5,8.14,3,2.82]}];
const HOW=["Escape inputs or whitelist with CL_ABAP_DYN_PRG; switch to static Open SQL","Escape / whitelist the dynamic WHERE via CL_ABAP_DYN_PRG","Evaluate SY-SUBRC / return codes; drop FOR USER sy-uname","CALL TRANSACTION … WITH AUTHORITY-CHECK","Whitelist allowed targets + authority check","Logical file names (FILE_GET_NAME / FILE_VALIDATE_NAME)","Output encoding, XSRF protection flag, upload content check",
"Remove dynamic code generation or OS calls; redesign or decommission","Move credential to RFC destination / secure store; rotate","Decide auth object / program auth group per business function","Agree auth object for RFC/BOR callers; align interface roles","Confirm business need to check another user","Classify tables with data owner; add auth check, use released API or exempt","Replace direct writes with BAPI / standard API"];
const PARAMS=[
 ["phw","Productive hours / person / week",32,"40 h week at 80% utilisation"],
 ["hpd","Hours per person-day",8,""],
 ["ut","Unit test & re-scan (% of build)",20,"developer effort"],
 ["rev","Code review & sign-off (% of build)",10,"tech lead effort"],
 ["pm","PM & coordination (% of subtotal)",10,"PM headcount is calculated"],
 ["cont","Contingency (% of subtotal)",10,"Conservative basis uses 15% while this is 10"],
 ["fp","Expected false positives (%)",25,"typically 20–30%; every item is still triaged to confirm"],
 ["unused","Unused code deleted instead of fixed (%)",0,"from usage logs (UPL/SCMON)"],
 ["su","Start-up weeks",1,"access, ATC setup, onboarding"],
 ["lag","Test tail after build (weeks)",2,"last fixes still need testing"],
 ["falead","Build time after last FA decision (weeks)",3,"redesign build follows the FA"],
 ["smefa","Max share of FA decision work an SME can take (%)",50,"area expert decides with the FA whether a fix is needed"],
 ["leadhands","Max tech lead time on fixing code (%)",70,"the planner gives leads all the time review doesn't need, up to this cap"]];
const DEF_AREAS=7, WPM=4.33;
/* share of build / FA / test effort removed by false positives and unused code (triage still covers every item) */
const fpOf=P=>S.fpOn===false?0:(+(P.fp??25)||0);
const redF=P=>1-(1-(+P.unused||0)/100)*(1-fpOf(P)/100);
const defTeam=()=>({dev:5,lead:1,fa:1,ba:2,smeN:1,smeAlloc:0.5,sme:0.5,target:6});
const blank=()=>({name:"",counts:GROUPS.map(()=>0),src:"",unmapped:0,team:defTeam()});
const example=()=>({name:"Example area",counts:GROUPS.map(g=>g.k94),src:"Example data – load your findings sheet or clear this area",unmapped:0,team:{dev:25,lead:3,fa:6,ba:10,smeN:2,smeAlloc:0.5,sme:1,target:6}});
const fq=v=>fmt(+v||0,(+v||0)%1?2:0);
const fmt=(v,d=0)=>isFinite(v)?v.toLocaleString("en-GB",{minimumFractionDigits:d,maximumFractionDigits:d}):"–";
let S={basis:"real",p12:true,params:{},team:{dev:25,lead:3,fa:6,ba:10,target:6},rates:{real:GROUPS.map(g=>g.real.slice()),cons:GROUPS.map(g=>g.cons.slice())},areas:[]};
PARAMS.forEach(p=>S.params[p[0]]=p[2]);
for(let i=0;i<DEF_AREAS;i++)S.areas.push(i===0?example():blank());
try{let s=JSON.parse(localStorage.getItem("cva-planner-v4")||"null"),old=false;
  if(!s){s=JSON.parse(localStorage.getItem("cva-planner-v3")||"null");old=!!s;}
  if(s&&Array.isArray(s.areas)&&s.areas.length){S=Object.assign(S,s);if(S.params.fp===undefined)S.params.fp=25;
    let first=true;S.areas.forEach(a=>{if(!a.team){a.team=old&&first&&a.counts.some(c=>+c>0)&&s.team?{...defTeam(),...s.team}:defTeam();if(a.counts.some(c=>+c>0))first=false;}});}}catch(e){}
S.areas.forEach(a=>{const t=a.team;if(!t)return;if(t.sme===undefined)t.sme=0.5;
  if(t.smeN===undefined){t.smeAlloc=(t.sme%0.5===0)?0.5:0.25;t.smeN=Math.round(t.sme/t.smeAlloc);}t.sme=(+t.smeN||0)*(+t.smeAlloc||0.5);});
const smeTxt=t=>`${fmt(+t.smeN||0)}×${(+t.smeAlloc||0.5)}`;
const save=()=>{try{localStorage.setItem("cva-planner-v4",JSON.stringify(S))}catch(e){}};
const nm=(a,i)=>a.name||("Area "+(i+1));

/* ---------- effort per area ---------- */
function hours(a){
  const P=S.params,R=S.rates[S.basis],u=redF(P),cont=(S.basis==="cons"&&P.cont===10?15:P.cont)/100;
  const z=()=>({items:0,tri:0,dev:0,ut:0,fa:0,test:0,rev:0});const t={T:z(),R:z()};
  GROUPS.forEach((g,i)=>{const n=+a.counts[i]||0,r=R[i],c=t[g.cat];
    c.items+=n;c.tri+=n*r[0];const dv=n*r[1]*(1-u);c.dev+=dv;c.ut+=dv*P.ut/100;c.rev+=dv*P.rev/100;c.fa+=n*r[2]*(1-u);c.test+=n*r[3]*(1-u);});
  ["T","R"].forEach(k=>{const c=t[k];c.sub=c.tri+c.dev+c.ut+c.fa+c.test+c.rev;c.pm=c.sub*P.pm/100;c.cont=c.sub*cont;c.total=c.sub+c.pm+c.cont;
    /* hours each role must deliver, with contingency spread 50% dev / 15% FA / 25% test / 10% review */
    c.devH=c.tri+c.dev+c.ut+0.5*c.cont;c.faH=c.fa+0.15*c.cont;c.testH=c.test+0.25*c.cont;c.revH=c.rev+0.1*c.cont;});
  const sum=k=>t.T[k]+t.R[k];
  return{t,items:t.T.items+t.R.items,triH:sum("tri"),devH:sum("devH"),faH:sum("faH"),testH:sum("testH"),revH:sum("revH"),pmH:sum("pm"),
    total:sum("total"),devPlain:sum("tri")+sum("dev")+sum("ut"),utH:sum("ut"),testPlain:sum("test"),contH:sum("cont"),has:t.T.items+t.R.items>0};
}
/* split n people across weights (largest remainder); every weighted item gets at least one when n allows */
function split(n,w){
  const idx=w.map((x,i)=>i).filter(i=>w[i]>0),out=w.map(()=>0);if(!idx.length||n<=0)return out;
  const W=idx.reduce((s,i)=>s+w[i],0);
  if(n<idx.length){idx.sort((a,b)=>w[b]-w[a]).slice(0,n).forEach(i=>out[i]=1);return out;}
  idx.forEach(i=>out[i]=1);let left=n-idx.length;
  while(left>0){let best=-1,bv=-1;idx.forEach(i=>{const v=w[i]/out[i];if(v>bv){bv=v;best=i;}});out[best]++;left--;}
  return out;
}
function planFor(team,params){
  const oT=S.team,oP=S.params;S.team={...oT,...(team||{})};S.params={...oP,...(params||{})};
  try{return plan();}finally{S.team=oT;S.params=oP;}
}
/* optimal mix: keep developers fixed, find the fewest leads and FA+BA that do not delay the end date; SME sized to cover triage */
function optimalTeam(){
  const T=S.team,BIG=1000;
  const base=planFor({fa:BIG,ba:0});if(!base.act.length||!(+T.dev>0))return null;
  // SME: smallest part-time allocation (0–2 FTE in 0.25 steps) that gets within ~0.1 month of the best possible
  const alloc=+T.smeAlloc||0.5;let smeN=1;{const ns=[0,1,2,3,4,5,6,7,8,10,12],ds=ns.map(n=>planFor({fa:BIG,ba:0,sme:n*alloc}).dur),best=Math.min(...ds);smeN=Math.max(1,ns[ds.findIndex(x=>x<=best+0.43)]);}
  const sme=smeN*alloc;  // at least 0.25 FTE: someone from the area must confirm what really needs fixing
  let L=0;
  if(base.tot("revH")>0){L=1;for(;L<=200;L++){const r=planFor({lead:L,fa:BIG,ba:0,sme});if(isFinite(r.dur)&&r.roleEnd["Tech leads"]<=r.roleEnd.Developers+0.05)break;}}
  const Lmax=Math.max(L,+T.lead||0),D=planFor({lead:Lmax,fa:BIG,ba:0,sme}).dur;if(!isFinite(D))return null;
  for(let l=L;l<=Lmax;l++){if(planFor({lead:l,fa:BIG,ba:0,sme}).dur<=D+0.3){L=l;break;}}
  const fH=base.tot("faH"),tH=base.tot("testH");let N=0;
  if(fH+tH>0){let lo=1,hi=BIG;while(lo<hi){const mid=(lo+hi)>>1,r=planFor({lead:L,fa:mid,ba:0,sme});if(r.dur<=D+0.3)hi=mid;else lo=mid+1;}N=lo;}
  let fa=fH>0?Math.max(1,Math.round(N*fH/(fH+tH))):0,ba=N-fa;if(tH>0&&ba<1&&N>=2){ba=1;fa=N-1;}if(ba<0)ba=0;
  const r=planFor({lead:L,fa,ba,sme});
  return{dev:+T.dev,lead:L,fa,ba,sme,smeN,smeAlloc:alloc,pm:r.pm,total:(+T.dev)+L+fa+ba+smeN+r.pm,dur:r.dur,pd:r.tot("total")/(S.params.hpd||8)};
}
function plan(){
  // leads fix code with whatever time review does not need: iterate to a stable split
  const T=S.team,P=S.params,cap=Math.min(100,Math.max(0,P.leadhands??70))/100;
  if(!(+T.lead>0))return planWith(0);
  let lh=cap,r=planWith(lh);
  for(let k=0;k<12;k++){
    const build=Math.max(0,...r.act.map(a=>a.build).filter(isFinite));
    const revH=r.tot("revH");if(!(build>0)||revH<=0){lh=revH<=0?cap:0;r=planWith(lh);break;}
    const needRev=revH/(build*P.phw), next=Math.min(cap,Math.max(0,(T.lead-needRev)/T.lead));
    if(Math.abs(next-lh)<0.002)break;lh=(lh+next)/2;r=planWith(lh);
  }
  return r;
}
function planWith(lhIn){
  const P=S.params,T=S.team,phw=P.phw;
  const H=S.areas.map(hours);
  const lh=lhIn, leadFTE=(+T.lead||0)*lh;
  const tot=k=>H.reduce((s,h)=>s+(h.has?h[k]:0),0);
  // developers: balance build weeks across areas, then across tracks inside an area
  // balance developers across every area track at once so no single track drags the end date
  const trackW=H.flatMap(h=>h.has?[h.t.T.devH,h.t.R.devH]:[0,0]);
  const trackA=split(+T.dev||0,trackW);
  const devA=H.map((h,i)=>trackA[2*i]+trackA[2*i+1]);
  const faA=split(+T.fa||0,H.map(h=>h.has?h.faH:0));
  const baA=split(+T.ba||0,H.map(h=>h.has?h.testH:0));
  const areas=H.map((h,i)=>{
    if(!h.has)return{h,has:false};
    const d=devA[i],tr=[trackA[2*i],trackA[2*i+1]];
    const dh=H.reduce((s2,x)=>s2+(x.has?x.devH:0),0)||1, lf=leadFTE*h.devH/dh;            // lead hands-on FTE for this area
    const lT=h.devH>0?lf*h.t.T.devH/h.devH:0, lR=lf-lT;
    const wk=(H_,n)=>H_<=0?0:(n>0?H_/(n*phw):Infinity);
    // SME (area expert, part-time) takes the "is a fix needed?" triage and part of the FA decision work off the team
    const dh0=H.reduce((s2,x)=>s2+(x.has?x.devH:0),0)||1,smeN=(+T.sme||0)*h.devH/dh0;
    const est=h.devH/(((tr[0]+lT)+(tr[1]+lR))||1)/phw;
    let smeCap=smeN*phw*est;const triT=h.t.T.tri,triR=h.t.R.tri,tri=triT+triR;
    const mvTri=Math.min(tri,smeCap);smeCap-=mvTri;const mvFa=Math.min(h.faH*(+(P.smefa??50)||0)/100,smeCap);
    const dT=h.t.T.devH-(tri?mvTri*triT/tri:0),dR=h.t.R.devH-(tri?mvTri*triR/tri:0),faAdj=h.faH-mvFa;
    const wT=wk(dT,tr[0]+lT),wR=wk(dR,tr[1]+lR);
    const build=Math.max(wT,wR);
    // FAs and BAs share the functional work: redesign decisions and testing
    const fh0=H.reduce((s2,x)=>s2+(x.has?x.faH+x.testH:0),0)||1,funcN=((+T.fa||0)+(+T.ba||0))*(h.faH+h.testH)/fh0;
    const funcH=faAdj+h.testH,fw=wk(funcH,funcN);
    const devEnd=P.su+build+P.lag,funcEnd=funcH>0?P.su+fw+P.lag:0,faEnd=funcEnd,baEnd=funcEnd;
    const end=Math.max(devEnd,funcEnd);
    return{h,has:true,dev:d,devT:tr[0],devR:tr[1],lead:lf,fa:faA[i],ba:baA[i],wT,wR,build,durT:h.t.T.devH>0?P.su+wT+P.lag:0,durR:h.t.R.devH>0?P.su+wR+P.lag:0,sme:smeN,smeTri:mvTri,smeFa:mvFa,smeUsed:mvTri+mvFa,funcH,funcEnd,end,devEnd,faEnd,baEnd};
  });
  const act=areas.filter(a=>a.has);
  // pooled leads
  const revH=tot("revH"),revCap=(+T.lead||0)*(1-lh),leadW=revH<=0?0:(revCap>0?revH/(revCap*phw):Infinity);
  const leadEnd=revH>0?P.su+leadW:0;
  const dur=Math.max(0,leadEnd,...act.map(a=>a.end));
  const roleEnd={Developers:Math.max(0,...act.map(a=>a.devEnd)),"FA + BA":Math.max(0,...act.map(a=>a.funcEnd)),"Tech leads":leadEnd};
  const bn=Object.keys(roleEnd).reduce((b,k)=>roleEnd[k]>roleEnd[b]?k:b,"Developers");
  const pmH=tot("pmH"),pm=act.length&&isFinite(dur)&&dur>0?Math.max(1,Math.ceil(pmH/(dur*phw))):0;
  // headcount needed for target
  const tw=(+T.target||0)*WPM;
  const need=(h,win)=>h<=0?0:(win>0?Math.ceil(h/(win*phw)):Infinity);
  const needDev=need(tot("devH"),tw-P.su-P.lag);
  const needLead=revH<=0?0:(tw-P.su>0&&lh<1?Math.ceil(revH/((tw-P.su)*phw*(1-lh))):Infinity);
  const smeTri=act.reduce((x,a)=>x+a.smeTri,0),smeFa=act.reduce((x,a)=>x+a.smeFa,0),smeUsed=smeTri+smeFa;
  const needs={Developers:isFinite(needDev)?Math.max(0,Math.ceil(needDev-leadFTE)):needDev,"Tech leads":needLead,"FA + BA":need(act.reduce((x,a)=>x+a.funcH,0),tw-P.su-P.lag)};
  const buildW=Math.max(0,...act.map(a=>a.build).filter(isFinite));
  const smeRec=tot("triH")<=0?0:(tw-P.su-P.lag>0?Math.min(1,Math.max(0.25,Math.ceil(tot("triH")/((tw-P.su-P.lag)*phw)*4)/4)):1);
  return{areas,act,dur,bn,roleEnd,pm,pmH,needs,tot,leadW,leadFTE,lh,smeTri,smeFa,smeUsed,smeRec,buildW};
}

/* ---------- reading findings sheets ---------- */
function classify(msg,code){
  const m=(msg||"").toString().trim().toLowerCase();
  if(m)for(let i=0;i<GROUPS.length;i++)if(GROUPS[i].pfx.some(p=>m.startsWith(p.toLowerCase())))return i;
  const c=(code||"").toString().trim().toUpperCase();
  if(c)for(let i=0;i<GROUPS.length;i++)if(GROUPS[i].codes.includes(c))return i;
  return -1;
}
function pickSheet(names){
  for(const p of ["P1_P2_By_Category","P1_P2_Backlog","Mapped_Data","Data"]){const f=names.find(n=>n.toLowerCase()===p.toLowerCase());if(f)return[f];}
  return names;
}
function rowsToCounts(rows){
  let h=-1,cols={};
  for(let r=0;r<Math.min(rows.length,30);r++){const row=(rows[r]||[]).map(x=>(x??"").toString().trim().toLowerCase());
    const om=row.findIndex(x=>x==="object name"||x==="object"),cm=row.findIndex(x=>x==="check message"||x==="message");
    if(om>=0&&cm>=0){h=r;cols={obj:om,msg:cm,prio:row.findIndex(x=>x==="priority"||x==="prio"),code:row.findIndex(x=>x==="cva code")};break;}}
  if(h<0)return null;
  const seen=new Set(),counts=GROUPS.map(()=>0);let unm=0,rowsUsed=0;
  for(let r=h+1;r<rows.length;r++){const row=rows[r];if(!row)continue;const obj=row[cols.obj],msg=row[cols.msg];if(!obj||!msg)continue;
    if(S.p12&&cols.prio>=0){const p=(row[cols.prio]??"").toString().trim().toUpperCase().replace(/\s+/g,"");
      if(!/^(P?[12]|PRIO[12]|PRIORITY[12])$/.test(p))continue;}
    rowsUsed++;const key=obj+"\u0001"+msg;if(seen.has(key))continue;seen.add(key);
    const g=classify(msg,cols.code>=0?row[cols.code]:"");if(g<0)unm++;else counts[g]++;}
  return{counts,unm,rowsUsed,prio:cols.prio>=0};
}
async function readFile(file,i){
  const a=S.areas[i];setStatus(i,"Reading "+file.name+" … large reports can take a minute.");
  await new Promise(r=>setTimeout(r,40));
  try{
    if(typeof XLSX==="undefined")throw new Error("The spreadsheet reader did not load. Enter the counts by hand under ‘Edit counts’.");
    const buf=await file.arrayBuffer();
    const names=/\.csv$/i.test(file.name)?null:XLSX.read(buf,{type:"array",bookSheets:true}).SheetNames;
    let res=null,used="";
    for(const sn of (names?pickSheet(names):[null])){
      const wb=XLSX.read(buf,sn?{type:"array",sheets:[sn],dense:true}:{type:"array",dense:true});
      const ws=wb.Sheets[sn||wb.SheetNames[0]];
      res=rowsToCounts(XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null}));
      if(res){used=sn||wb.SheetNames[0];break;}
    }
    if(!res)throw new Error("No sheet with ‘Object name’ and ‘Check Message’ columns was found in "+file.name+".");
    a.counts=res.counts;a.unmapped=res.unm;
    if(!a.name)a.name=file.name.replace(/\.(xlsx|xlsm|xls|csv)$/i,"");
    a.src=`${file.name} · sheet ${used} · ${fmt(res.rowsUsed)} findings → ${fmt(res.counts.reduce((x,y)=>x+y,0))} work items`+(S.p12&&!res.prio?" · no Priority column, all rows counted":"");
    save();renderAreas();compute();
  }catch(e){a.src="";setStatus(i,e.message||"Could not read the file.",true);}
}
function setStatus(i,msg,err){const el=document.getElementById("st-"+i);if(el){el.textContent=msg;el.className="status"+(err?" err":"");}}

/* ---------- rendering ---------- */
const sums=a=>({T:GROUPS.reduce((s,g,k)=>s+(g.cat==="T"?+a.counts[k]||0:0),0),R:GROUPS.reduce((s,g,k)=>s+(g.cat==="R"?+a.counts[k]||0:0),0)});
function renderAreas(){
  const box=document.getElementById("areas");box.innerHTML="";
  S.areas.forEach((a,i)=>{
    const s=sums(a),el=document.createElement("article");el.className="area"+(s.T+s.R===0?" empty":"");
    el.innerHTML=`<div class="area-top"><span class="idx">A${i+1}</span><input id="nm-${i}" aria-label="Area ${i+1} name" placeholder="Area ${i+1} name" value="${(a.name||"").replace(/"/g,"&quot;")}"></div>
      <div class="load"><label class="file" for="fl-${i}">Load findings sheet</label><input type="file" id="fl-${i}" accept=".xlsx,.xlsm,.xls,.csv">
      <div class="pills"><span class="pill t" id="pt-${i}">${fmt(s.T)} tech</span><span class="pill r" id="pr-${i}">${fmt(s.R)} redesign</span>${a.unmapped?`<span class="pill w" title="Check types not in the rate card are not estimated">${fmt(a.unmapped)} unclassified</span>`:""}</div></div>
      <div class="status" id="st-${i}">${a.src||"No data yet – load a sheet or edit counts."}</div>
      <div class="ateam">${[["dev","Developers"],["lead","Tech leads"],["fa","Functional analysts (FA)"],["ba","Business analysts (BA)"],["target","Target (months)"],["smeN","SMEs (number)"]].map(([k,l])=>`<label class="f" for="tm-${i}-${k}">${l}<input type="number" min="0" step="${k==="target"?0.5:1}" id="tm-${i}-${k}" value="${a.team[k]}"></label>`).join("")}<label class="f" for="tm-${i}-alloc">SME allocation (each)<select id="tm-${i}-alloc"><option value="0.25" ${+a.team.smeAlloc===0.25?"selected":""}>0.25 FTE</option><option value="0.5" ${+a.team.smeAlloc!==0.25?"selected":""}>0.5 FTE</option></select></label></div>
      <div class="alloc" id="al-${i}"></div>
      <details class="counts"><summary>Edit counts (work items per check type)</summary><div class="cgrid">${GROUPS.map((g,k)=>`<span class="${g.cat.toLowerCase()}">${g.name}</span><input type="number" min="0" step="1" id="c-${i}-${k}" aria-label="${g.name}" value="${a.counts[k]}">`).join("")}</div></details>
      <div class="foot"><span class="note" id="ad-${i}"></span><span style="display:flex;gap:12px"><button type="button" class="linkbtn" id="clr-${i}">Clear</button>${S.areas.length>1?`<button type="button" class="linkbtn" id="rm-${i}">Remove</button>`:""}</span></div>`;
    box.appendChild(el);
    el.querySelector("#nm-"+i).addEventListener("input",e=>{a.name=e.target.value;save();compute();});
    ["dev","lead","fa","ba","smeN","target"].forEach(k=>el.querySelector(`#tm-${i}-${k}`).addEventListener("input",e=>{a.team[k]=Math.max(0,+e.target.value||0);if(k==="smeN")a.team[k]=Math.round(a.team[k]);a.team.sme=a.team.smeN*(+a.team.smeAlloc||0.5);save();compute();}));
    el.querySelector(`#tm-${i}-alloc`).addEventListener("change",e=>{a.team.smeAlloc=+e.target.value;a.team.sme=(+a.team.smeN||0)*a.team.smeAlloc;save();compute();});
    el.querySelector("#fl-"+i).addEventListener("change",e=>{const f=e.target.files[0];if(f)readFile(f,i);e.target.value="";});
    GROUPS.forEach((g,k)=>el.querySelector(`#c-${i}-${k}`).addEventListener("input",e=>{a.counts[k]=Math.max(0,+e.target.value||0);a.src="Counts entered by hand";save();
      const s2=sums(a);document.getElementById("pt-"+i).textContent=fmt(s2.T)+" tech";document.getElementById("pr-"+i).textContent=fmt(s2.R)+" redesign";
      el.classList.toggle("empty",s2.T+s2.R===0);document.getElementById("st-"+i).textContent=a.src;compute();}));
    el.querySelector("#clr-"+i).addEventListener("click",()=>{S.areas[i]=blank();save();renderAreas();compute();});
    const rm=el.querySelector("#rm-"+i);if(rm)rm.addEventListener("click",()=>{S.areas.splice(i,1);save();renderAreas();compute();});
  });
}
function renderParams(){
  const box=document.getElementById("params");box.innerHTML="";
  PARAMS.forEach(([k,l,,n])=>{const w=document.createElement("label");w.className="f";w.htmlFor="p-"+k;
    w.innerHTML=`${l}<input type="number" step="any" min="0" id="p-${k}" value="${S.params[k]}">${n?`<span style="font-size:.7rem">${n}</span>`:""}`;
    w.querySelector("input").addEventListener("input",e=>{S.params[k]=Math.max(0,+e.target.value||0);save();compute();});box.appendChild(w);});
}
function renderRates(){
  const t=document.getElementById("rc"),R=S.rates[S.basis];
  t.innerHTML=`<thead><tr><th>Check type</th><th>Track</th><th class="n">Triage h</th><th class="n">Build h</th><th class="n">FA h</th><th class="n">Test h</th></tr></thead><tbody>`+
   GROUPS.map((g,i)=>`<tr><td>${g.name}</td><td>${g.cat==="T"?'<span class="pill t">Technical</span>':'<span class="pill r">Redesign</span>'}</td>${[0,1,2,3].map(j=>`<td class="n"><input type="number" step="any" min="0" id="r-${i}-${j}" aria-label="${g.name} rate ${j+1}" value="${R[i][j]}"></td>`).join("")}</tr>`).join("")+`</tbody>`;
  GROUPS.forEach((g,i)=>[0,1,2,3].forEach(j=>t.querySelector(`#r-${i}-${j}`).addEventListener("input",e=>{S.rates[S.basis][i][j]=Math.max(0,+e.target.value||0);save();compute();})));
}
/* ---------- per-area planning ---------- */
const hasData=a=>a.counts.some(c=>+c>0);
function scoped(i,team,params,fn){
  const oA=S.areas,oT=S.team,oP=S.params;S.areas=[oA[i]];S.team={...defTeam(),...(oA[i].team||{}),...(team||{})};S.params={...oP,...(params||{})};
  try{return fn();}finally{S.areas=oA;S.team=oT;S.params=oP;}
}
const areaPlan=(i,params)=>scoped(i,null,params,plan);
const areaOptimal=(i,params)=>scoped(i,null,params,optimalTeam);
/* programme = all areas in parallel, each with its own team */
function planAll(params){
  const per=S.areas.map((a,i)=>hasData(a)?areaPlan(i,params):null);
  const areas=per.map(r=>r?r.areas[0]:{has:false}),act=areas.filter(a=>a.has),live=per.filter(Boolean);
  const tot=k=>live.reduce((s,r)=>s+r.tot(k),0);
  const dur=Math.max(0,...live.map(r=>r.dur));
  const ROLES=["Developers","Tech leads","FA + BA"],roleEnd={},needs={};
  ROLES.forEach(k=>{roleEnd[k]=Math.max(0,...live.map(r=>r.roleEnd[k]));needs[k]=live.reduce((s,r)=>s+r.needs[k],0);});
  let bi=-1;per.forEach((r,i)=>{if(r&&(bi<0||r.dur>per[bi].dur))bi=i;});
  const team={dev:0,lead:0,fa:0,ba:0,sme:0,smeN:0};per.forEach((r,i)=>{if(r)for(const k in team)team[k]+=+S.areas[i].team[k]||0;});
  const P=S.params;
  const sm=k=>live.reduce((s2,r)=>s2+r[k],0);
  return{per,areas,act,dur,bn:bi>=0?per[bi].bn:"Developers",bnArea:bi,roleEnd,needs,tot,team,smeTri:sm("smeTri"),smeFa:sm("smeFa"),smeUsed:sm("smeUsed"),smeRec:sm("smeRec"),buildW:Math.max(0,...live.map(r=>r.buildW)),
    pm:live.reduce((s,r)=>s+r.pm,0),pmH:tot("pmH"),leadFTE:live.reduce((s,r)=>s+r.leadFTE,0),
    revCap:per.reduce((s,r,i)=>s+(r?(+S.areas[i].team.lead||0)*(1-r.lh):0),0),
    pmNeed:per.reduce((s,r,i)=>s+(r?Math.max(1,Math.ceil(r.pmH/(Math.max(1,(+S.areas[i].team.target||6)*WPM)*P.phw))):0),0)};
}
function areaCapCtx(i,r){const t=S.areas[i].team;
  return{team:t,leadFTE:r.leadFTE,revCap:(+t.lead||0)*(1-r.lh),tot:r.tot,smeTri:r.smeTri,smeFa:r.smeFa,smeUsed:r.smeUsed,smeRec:r.smeRec,buildW:r.buildW,roleEnd:r.roleEnd,needs:r.needs,pm:r.pm,pmH:r.pmH,dur:r.dur,bn:r.bn,
    pmNeed:Math.max(1,Math.ceil(r.pmH/(Math.max(1,(+t.target||6)*WPM)*S.params.phw)))};}
function capRows(o){
  const P=S.params,hpd=P.hpd||8,build=Math.max(0,o.dur-P.su-P.lag),fa=+o.team.fa||0,ba=+o.team.ba||0,sme=+o.team.sme||0,smeN=+o.team.smeN||0,alloc=+o.team.smeAlloc||0;
  const defs=[["Developers","Developers",o.team.dev,o.tot("devH")-o.smeTri,(+o.team.dev||0)+o.leadFTE],["Tech leads","Tech leads",o.team.lead,o.tot("revH"),o.revCap],
    ["FA + BA","Functional & business analysts (FA + BA)",fa+ba,o.tot("faH")-o.smeFa+o.tot("testH"),fa+ba]];
  const rows=defs.map(([key,label,n,h,cap])=>{const busy=cap>0&&h>0?h/(cap*P.phw):0,load=build>0&&isFinite(busy)?Math.min(1,busy/build):0;
    return{role:label,head:+n||0,pd:h/hpd,end:h?o.roleEnd[key]:null,load:h?load:null,status:!h?"No work":key===o.bn?"Bottleneck":"Has slack",need:o.needs[key],
      note:key==="Developers"&&o.leadFTE>0?`+ ${fmt(o.leadFTE,1)} lead FTE hands-on`:key==="Tech leads"&&n>0&&h>0?`review & sign-off (${fmt(o.revCap/n*100)}% of time)`:key==="FA + BA"?`${fa} FA + ${ba} BA share redesign decisions and testing`:""};});
  rows.push({role:"SME (area expert)",head:smeN,pd:o.smeUsed/hpd,end:null,load:sme>0&&build>0?Math.min(1,o.smeUsed/(sme*P.phw*build)):null,status:sme>0?"Accelerator":"Not assigned",need:alloc?Math.ceil((o.smeRec||0)/alloc-1e-9):Math.ceil((o.smeRec||0)/0.5-1e-9),
    note:sme>0?`${alloc?`${smeN} × ${alloc} FTE`:`${fq(sme)} FTE`} · decides what needs fixing: takes ${fmt(o.smeTri/hpd)} PD triage + ${fmt(o.smeFa/hpd)} PD FA decisions off the team`:"add an SME to speed up triage and FA decisions"});
  rows.push({role:"PM / coordination",head:o.pm,pd:o.pmH/hpd,end:null,load:null,status:"Calculated",need:o.pmNeed,note:""});
  return rows;
}
function capHTML(rows,needLabel){
  return `<thead><tr><th>Role</th><th class="n">Headcount</th><th class="n">Effort PD</th><th class="n">Role finishes (months)</th><th>Load</th><th>Status</th><th class="n">${needLabel}</th></tr></thead><tbody>`+
    rows.map(c=>{const bn=c.status==="Bottleneck",st=c.status==="No work"?'<span class="chip idle">no work</span>':c.status==="Calculated"?'<span class="chip idle">calculated</span>':c.status==="Accelerator"?'<span class="chip ok">accelerator</span>':c.status==="Not assigned"?'<span class="chip idle">not assigned</span>':bn?'<span class="chip bn">bottleneck</span>':'<span class="chip ok">has slack</span>';
      return `<tr><td>${c.role}${c.note?` <span class="note">${c.note}</span>`:""}</td><td class="n">${fq(c.head)}</td><td class="n">${fmt(c.pd)}</td><td class="n">${c.end==null?"–":mo(c.end)}</td><td>${c.load==null?"":`<span class="util"><i class="${bn?"bn":""}" style="width:${(c.load*100).toFixed(0)}%"></i></span>${fmt(c.load*100)}%`}</td><td>${st}</td><td class="n">${c.need==null?"–":isFinite(c.need)?fq(c.need):"target too short"}</td></tr>`;}).join("")+`</tbody>`;
}
function optHTML(o,team,label,btnId){
  const d=[["lead","lead"],["fa","FA"],["ba","BA"],["smeN","SME"]].map(([k,l])=>{const x=(o[k]||0)-(+team[k]||0);return Math.abs(x)>1e-9?`${x>0?"+":"−"}${fq(Math.abs(x))} ${l}`:""}).filter(Boolean),same=!d.length;
  return `<span class="lbl">${label}</span><span><b>${o.lead}</b> leads · <b>${o.fa}</b> FA · <b>${o.ba}</b> BA · <b>${o.smeN}</b> SME × ${o.smeAlloc} · <b>${o.pm}</b> PM = <b>${fq(o.total)}</b> people</span><span><b>${fmt(o.dur/WPM,1)}</b> months</span><span class="delta">${same?"Already matches the optimal mix":"vs current: "+d.join(", ")}</span>${same?"":`<button type="button" class="btn" id="${btnId}">Use optimal team</button>`}`;
}
function applyOptimal(i,o){const t=S.areas[i].team;t.lead=o.lead;t.fa=o.fa;t.ba=o.ba;t.smeN=o.smeN;t.smeAlloc=o.smeAlloc;t.sme=o.sme;}

let LAST=null,LAST_OPT=null;
const mo=w=>isFinite(w)?fmt(w/WPM,1):"∞";
function compute(){
  const P=S.params,hpd=P.hpd||8,p=planAll();LAST=p;const {act,dur,tot}=p,finite=isFinite(dur);
  const bnName=p.bnArea>=0?nm(S.areas[p.bnArea],p.bnArea):"";
  const T=p.team,team=T.dev+T.lead+T.fa+T.ba+T.smeN+p.pm;
  // recommended plan note + programme optimal team (sum of areas)
  const on=S.fpOn!==false,fp=fpOf(P);
  document.getElementById("fp-on").checked=on;const fpi=document.getElementById("fp-pct");fpi.disabled=!on;fpi.parentElement.setAttribute("aria-disabled",String(!on));
  if(document.activeElement!==fpi)fpi.value=+(P.fp??25);
  let rngTxt="";if(on&&act.length){const lo=planAll({fp:20}),hi=planAll({fp:30});
    rngTxt=isFinite(lo.dur)&&isFinite(hi.dur)?` At 20–30% false positives the programme ranges ${fmt(hi.dur/WPM,1)}–${fmt(lo.dur/WPM,1)} months, ${fmt(hi.tot("total")/hpd)}–${fmt(lo.tot("total")/hpd)} PD.`:"";}
  document.getElementById("rec-note").textContent=!act.length?"Add data to an area to see the recommended plan.":(on?`Assumes ${fmt(fp)}% of findings are false positives (confirmed in triage, no fix needed).${rngTxt}`:"False positives are not considered: every finding is fixed and tested.")+(act.length?` Programme: ${finite?fmt(dur/WPM,1)+" months":"no end date"} (slowest area: ${p.bnArea>=0?nm(S.areas[p.bnArea],p.bnArea):"–"}) · ${fmt(tot("total")/hpd)} PD · ${fmt(team)} people. All areas run in parallel, each with its own team.`:"");
  const opts=S.areas.map((a,i)=>p.per[i]?areaOptimal(i):null);
  const live=opts.filter(Boolean),ub=document.getElementById("use-opt");LAST_OPT=null;
  if(live.length){const po={lead:0,fa:0,ba:0,sme:0,smeN:0,pm:0,total:0,dur:Math.max(...live.map(o=>o.dur))};live.forEach(o=>{for(const k of ["lead","fa","ba","sme","smeN","pm","total"])po[k]+=o[k];});LAST_OPT=po;}
  const diff=opts.some((o,i)=>o&&["lead","fa","ba","smeN","smeAlloc"].some(k=>Math.abs((o[k]||0)-(+S.areas[i].team[k]||0))>1e-9));
  ub.hidden=!diff;ub.onclick=()=>{opts.forEach((o,i)=>{if(o)applyOptimal(i,o);});save();renderAreas();compute();toast("Optimal team applied to every area");};
  document.getElementById("overview").hidden=!act.length;
  // team by area table + programme capacity
  const tb=document.getElementById("teamtbl");
  const sgn=(v,d=0)=>Math.abs(v)<1e-9?"–":`${v>0?"+":"−"}${d?fmt(Math.abs(v),d):fq(Math.abs(v))}`;
  const mix=(t,pm)=>`${fmt(+t.dev||0)} / ${fmt(+t.lead||0)} / ${fmt(+t.fa||0)} / ${fmt(+t.ba||0)} / ${t.smeAlloc===undefined?fmt(+t.smeN||0):smeTxt(t)} / ${fmt(pm)}`;
  let sum={cur:0,opt:0},optDur=0,anyDiff=false;
  const rowsH=S.areas.map((a,i)=>{const r=p.per[i];if(!r)return"";const t=a.team,o=opts[i],cur=(+t.dev||0)+(+t.lead||0)+(+t.fa||0)+(+t.ba||0)+(+t.smeN||0)+r.pm;
    sum.cur+=cur;if(o){sum.opt+=o.total;optDur=Math.max(optDur,o.dur);}else{sum.opt+=cur;optDur=Math.max(optDur,r.dur);}
    const diff=o&&["lead","fa","ba","smeN"].some(k=>Math.abs((o[k]||0)-(+t[k]||0))>1e-9);if(diff)anyDiff=true;
    const dp=o?o.total-cur:0,dm=o&&isFinite(r.dur)?(o.dur-r.dur)/WPM:0;
    return `<tr><td>${nm(a,i).replace(/</g,"&lt;")}</td><td class="n">${mix(t,r.pm)}</td><td class="n"><b>${fq(cur)}</b></td><td class="n">${fmt(+t.target||0,1)}</td><td class="n"><b>${mo(r.dur)}</b></td><td><span class="chip ${i===p.bnArea?"bn":"idle"}">${r.bn}</span></td>
      <td class="n opt">${o?mix({dev:o.dev,lead:o.lead,fa:o.fa,ba:o.ba,smeN:o.smeN,smeAlloc:o.smeAlloc},o.pm):"–"}</td><td class="n opt"><b>${o?fq(o.total):"–"}</b></td><td class="n opt"><b>${o?mo(o.dur):"–"}</b></td>
      <td class="n ${dp<0?"good":dp>0?"warn":""}">${sgn(dp)}</td><td class="n ${dm<-0.05?"good":dm>0.05?"warn":""}">${Math.abs(dm)<0.05?"–":sgn(dm,1)}</td>
      <td>${diff?`<button type="button" class="linkbtn" id="opt-row-${i}">Apply</button>`:'<span class="note">optimal</span>'}</td></tr>`;}).join("");
  const dpT=sum.opt-sum.cur,dmT=act.length&&finite?(optDur-dur)/WPM:0;
  tb.innerHTML=`<thead><tr><th rowspan="2">Area</th><th colspan="5" class="grp-h">Current plan</th><th colspan="3" class="grp-h opt">Optimal plan</th><th colspan="2" class="grp-h">Change</th><th rowspan="2"></th></tr>
    <tr><th class="n">Dev / Lead / FA / BA / SME (no.×FTE) / PM</th><th class="n">People</th><th class="n">Target (mo)</th><th class="n">Duration (mo)</th><th>Bottleneck</th><th class="n opt">Dev / Lead / FA / BA / SME (no.×FTE) / PM</th><th class="n opt">People</th><th class="n opt">Duration (mo)</th><th class="n">People</th><th class="n">Months</th></tr></thead><tbody>`+
    (act.length?rowsH+`<tr class="total"><td>Project (all areas)</td><td class="n">${mix(T,p.pm)}</td><td class="n">${fq(sum.cur)}</td><td class="n">–</td><td class="n">${finite?fmt(dur/WPM,1):"∞"}</td><td>${p.bn}</td>
      <td class="n opt">${LAST_OPT?mix({dev:T.dev,lead:LAST_OPT.lead,fa:LAST_OPT.fa,ba:LAST_OPT.ba,smeN:LAST_OPT.smeN},LAST_OPT.pm):"–"}</td><td class="n opt">${fq(sum.opt)}</td><td class="n opt">${mo(optDur)}</td>
      <td class="n ${dpT<0?"good":dpT>0?"warn":""}">${sgn(dpT)}</td><td class="n ${dmT<-0.05?"good":dmT>0.05?"warn":""}">${Math.abs(dmT)<0.05?"–":sgn(dmT,1)}</td><td></td></tr>`
     :`<tr><td colspan="12">Load a findings sheet or enter counts for at least one area.</td></tr>`)+`</tbody>`;
  S.areas.forEach((a,i)=>{const b=document.getElementById("opt-row-"+i);if(b&&opts[i])b.onclick=()=>{applyOptimal(i,opts[i]);save();renderAreas();compute();toast("Optimal team applied to "+nm(a,i));};});
  ub.hidden=!anyDiff;
  // area cards
  p.areas.forEach((a,i)=>{const al=document.getElementById("al-"+i),ad=document.getElementById("ad-"+i);if(!al)return;
    if(!a.has){al.innerHTML="";ad.textContent="";return;}
    al.innerHTML=`<span>Devs <b>${a.devT}</b> tech · <b>${a.devR}</b> redesign</span>${a.lead>0?`<span>Lead hands-on <b>${fmt(a.lead,1)}</b></span>`:""}`;
    ad.textContent=isFinite(a.end)?`${mo(a.end)} months · ${fmt(a.h.total/hpd)} PD`:"needs more people";});
  const cu=(S.basis==="cons"&&P.cont===10?15:P.cont);
  document.getElementById("plan-note").textContent=`Basis: ${S.basis==="real"?"Realistic":"Conservative"} · ${on?fmt(fp)+"% false positives":"false positives not considered"} · ${P.phw} productive h/week · contingency ${cu}% · PM ${P.pm}%. Duration = the latest of developer build, FA decisions (+${P.falead} wks build) and BA testing, plus ${P.su} start-up week and a ${P.lag}-week test tail.`;
  renderAreaPlans(p,opts);
}
function setBasis(b){S.basis=b;document.getElementById("sc-real").setAttribute("aria-pressed",b==="real");document.getElementById("sc-cons").setAttribute("aria-pressed",b==="cons");save();renderRates();compute();}
document.getElementById("sc-real").addEventListener("click",()=>setBasis("real"));
document.getElementById("sc-cons").addEventListener("click",()=>setBasis("cons"));
document.getElementById("p12").addEventListener("change",e=>{S.p12=e.target.checked;save();});
function toast(m){const t=document.getElementById("toast");t.textContent=m;t.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>t.hidden=true,2200);}
document.getElementById("copy").addEventListener("click",()=>{
  const hpd=S.params.hpd||8,p=LAST;const L=[["Area","Developers","Tech leads","FA","BA","SMEs","SME allocation","PM","Tech items","Redesign items","Tech track (months)","Redesign track (months)","Area done (months)","Bottleneck","Dev PD","FA PD","Testing PD","Total PD"].join("\t")];
  p.areas.forEach((a,i)=>{if(!a.has)return;const r=p.per[i],t=S.areas[i].team,m=v=>isFinite(v)?(v/WPM).toFixed(1):"";
    L.push([nm(S.areas[i],i),t.dev,t.lead,t.fa,t.ba,t.smeN,t.smeAlloc,r.pm,a.h.t.T.items,a.h.t.R.items,m(a.durT),m(a.durR),m(r.dur),r.bn,Math.round(a.h.devPlain/hpd),Math.round(a.h.t.R.fa/hpd),Math.round((a.h.testPlain+a.h.utH)/hpd),Math.round(a.h.total/hpd)].join("\t"));});
  L.push("");L.push(["Programme duration (months)",isFinite(p.dur)?(p.dur/WPM).toFixed(1):""].join("\t"));
  const txt=L.join("\n");
  const fb=()=>{const ta=document.createElement("textarea");ta.value=txt;ta.style.position="fixed";ta.style.opacity="0";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");toast("Copied – paste into Excel");}catch(e){toast("Copy did not work in this view");}ta.remove();};
  try{navigator.clipboard.writeText(txt).then(()=>toast("Copied – paste into Excel"),fb);}catch(e){fb();}
});
/* ---------- export (Excel / PowerPoint) ---------- */
let DL=null;try{if(window.claude&&window.claude.use)window.claude.use("downloads").then(d=>{DL=d;}).catch(()=>{});}catch(e){}
function loadScript(urls,globalName){
  if(window[globalName])return Promise.resolve();
  return new Promise((res,rej)=>{let i=0;const next=()=>{if(i>=urls.length)return rej(new Error("The export library could not load. Check your internet connection."));
    const s=document.createElement("script");s.src=urls[i++];s.onload=()=>window[globalName]?res():next();s.onerror=()=>{s.remove();next();};document.head.appendChild(s);};next();});
}
async function saveFile(name,blob){
  // Inside Toolbox+ the host saves the file (browser download, or the Android share sheet)
  let host=null;try{host=window.parent!==window&&window.parent.DH&&window.parent.DH.saveBlob;}catch(e){}
  if(host){try{await host(blob,name);toast("Saved "+name);}catch(e){toast("Could not save the file ("+(e&&e.message||"error")+")");}return;}
  if(DL){try{await DL.save({filename:name,data:blob});toast("Saved "+name);return;}
    catch(e){const c=e&&e.code;if(c==="declined"){toast("Download cancelled");return;}
      if(c&&!["unavailable","not_granted","capability_disabled","capability_removed"].includes(c)){toast("Could not save the file ("+(e.message||c)+")");return;}}}
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);toast("Downloaded "+name);
}
const r1=v=>Math.round(v*10)/10, r0=v=>Math.round(v);
function areaDetails(p,opts){
  const P=S.params,hpd=P.hpd||8,u=redF(P),R=S.rates[S.basis];
  const gh=(k,n)=>{const r=R[k];return n*(r[0]+r[1]*(1-u)*(1+P.ut/100+P.rev/100)+(r[2]+r[3])*(1-u));};
  return p.areas.map((a,i)=>{if(!a.has)return null;const ar=S.areas[i],r=p.per[i],rows=[];let techPD=0,rdPD=0;
    [["T","Pure technical fix"],["R","Needs redesign (FA/SME input)"]].forEach(([c,label])=>{
      const ks=GROUPS.map((g,k)=>g.cat===c?k:-1).filter(k=>k>=0);
      const items=ks.reduce((x,k)=>x+(+ar.counts[k]||0),0),pd=ks.reduce((x,k)=>x+gh(k,+ar.counts[k]||0),0)/hpd;
      if(c==="T")techPD=pd;else rdPD=pd;
      rows.push({grp:c,name:label,items,pd});
      ks.forEach(k=>{const n=+ar.counts[k]||0;if(n)rows.push({grp:null,cat:c,name:GROUPS[k].name,how:HOW[k],items:n,pd:gh(k,n)/hpd});});});
    const t=ar.team,peopleAll=(+t.dev||0)+(+t.lead||0)+(+t.fa||0)+(+t.ba||0)+(+t.smeN||0)+r.pm,allIt=(a.h.t.T.items+a.h.t.R.items)||1;
    rows.forEach(x=>x.share=x.items/allIt);
    const h=a.h,roles=[["Developers (triage, build, unit test)",h.devPlain-a.smeTri],["Functional analysts (FA)",h.t.R.fa-a.smeFa],["SME (area expert: triage & decisions)",a.smeUsed],["Business analysts (functional testing)",h.testPlain],
      ["Tech leads (review & sign-off)",h.t.T.rev+h.t.R.rev],["PM / coordination",h.t.T.pm+h.t.R.pm],["Contingency",h.contH]].map(([l,x])=>({role:l,h:x,pd:x/hpd,share:x/(h.total||1)}));
    return{i,name:nm(ar,i),src:ar.src||"",a,r,rows,roles,totalH:h.total,tech:a.h.t.T.items,rd:a.h.t.R.items,techPD,rdPD,team:{...t},people:peopleAll,
      caps:capRows(areaCapCtx(i,r)),opt:opts?opts[i]:areaOptimal(i),bn:r.bn,
      months:isFinite(r.dur)?r.dur/WPM:null,totalPD:a.h.total/hpd,testPD:(a.h.testPlain+a.h.utH)/hpd,devPD:a.h.devPlain/hpd,faPD:a.h.t.R.fa/hpd};}).filter(Boolean);
}
const AP_CLOSED=new Set();
function renderAreaPlans(p,opts){
  const box=document.getElementById("areaplans"),ds=areaDetails(p,opts);
  if(!ds.length){box.innerHTML='<p class="note">Load a findings sheet or enter counts for an area to see its plan.</p>';return;}
  const mo2=v=>v==null?"∞":fmt(v,1);
  box.innerHTML=ds.map(d=>{const a=d.a,tot=d.tech+d.rd||1,maxM=Math.max(d.months||0,a.durT/WPM||0,a.durR/WPM||0,0.1),t=d.team;
    const bar=(v,c,l)=>v>0?`<div style="display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center"><span>${l}</span><div class="bar ${c}" style="width:${Math.max(2,v/maxM*78)}%"><span>${fmt(v,1)} mo</span></div></div>`:"";
    return `<details class="aplan" data-k="${d.i}" ${AP_CLOSED.has(d.i)?"":"open"}><summary><h3>${d.name.replace(/</g,"&lt;")}</h3>
      <span class="sm"><b>${mo2(d.months)}</b> months</span><span class="sm"><b>${fmt(d.totalPD)}</b> PD</span><span class="sm"><b>${fq(d.people)}</b> people</span><span class="sm"><b>${fmt(d.tech)}</b> tech · <b>${fmt(d.rd)}</b> redesign</span></summary>
      <div class="abody">
        <div class="eyebrow" style="color:var(--accent)">Recommended plan – ${d.name.replace(/</g,"&lt;")}</div>
        <div class="strip sm2">
          <div class="kpi"><span class="eyebrow">Duration</span><span class="v num">${mo2(d.months)}<small>months</small></span><span class="d">target ${fmt(+t.target||0,1)} months</span></div>
          <div class="kpi"><span class="eyebrow">Bottleneck</span><span class="v"><span class="chip bn">${d.bn}</span></span><span class="d">role that finishes last</span></div>
          <div class="kpi"><span class="eyebrow">Total effort</span><span class="v num">${fmt(d.totalPD)}<small>PD</small></span><span class="d">incl. PM & contingency</span></div>
          <div class="kpi"><span class="eyebrow">Testing effort</span><span class="v num">${fmt(d.testPD)}<small>PD</small></span><span class="d">unit + functional</span></div>
          <div class="kpi"><span class="eyebrow">Team</span><span class="v num">${fq(d.people)}<small>people</small></span><span class="d">${fmt(+t.dev||0)} dev · ${fmt(+t.lead||0)} lead · ${fmt(+t.fa||0)} FA · ${fmt(+t.ba||0)} BA · ${smeTxt(t)} SME · ${fmt(d.r.pm)} PM</span></div>
        </div>
        ${d.opt?`<div class="optbar">${optHTML(d.opt,t,`Optimal team for ${fmt(+t.dev||0)} developers`,"use-opt-"+d.i)}</div>`:""}
        <div class="tw"><table>${capHTML(d.caps,`Recommended for ${fmt(+t.target||0,1)} months`)}</table></div>
        <div class="body"><div style="min-width:0">
          <h4 class="sub4">Technical fix vs redesign</h4>
          <div class="tw"><table><thead><tr><th>Check type</th><th>Fix approach</th><th class="n">Work items</th><th class="n">Share</th><th class="n">Effort PD*</th></tr></thead><tbody>
          ${d.rows.map(r=>r.grp?`<tr class="grp ${r.grp.toLowerCase()}"><td>${r.name}</td><td></td><td class="n">${fmt(r.items)}</td><td class="n">${fmt(r.share*100)}%</td><td class="n">${fmt(r.pd)}</td></tr>`:`<tr><td>${r.name}</td><td class="how">${r.how}</td><td class="n">${fmt(r.items)}</td><td class="n">${fmt(r.share*100)}%</td><td class="n">${fmt(r.pd)}</td></tr>`).join("")}
          <tr class="total"><td>Total</td><td></td><td class="n">${fmt(d.tech+d.rd)}</td><td class="n">100%</td><td class="n">${fmt(d.techPD+d.rdPD)}</td></tr>
          </tbody></table></div><p class="note" style="margin:.4rem 0 0">* excludes PM and contingency${d.src?" · "+d.src.replace(/</g,"&lt;"):""}</p></div>
        <div class="side">
          <div><h4>Technical fix vs redesign</h4><div class="split"><i class="t" style="width:${d.tech/tot*100}%"></i><i class="r" style="width:${d.rd/tot*100}%"></i></div>
            <span class="note">${fmt(d.tech/tot*100)}% technical · ${fmt(d.rd/tot*100)}% redesign</span></div>
          <div><h4>Developer split</h4><div class="alloc"><span>Devs <b>${a.devT}</b> technical · <b>${a.devR}</b> redesign</span>${a.lead>0?`<span>Lead hands-on <b>${fmt(a.lead,1)}</b></span>`:""}</div></div>
          <div><h4>Timeline</h4><div style="display:flex;flex-direction:column;gap:6px">${bar(a.durT/WPM,"t","Technical track")}${bar(a.durR/WPM,"r","Redesign track")}</div>
            <span class="note">Area finishes at ${mo2(d.months)} months · set by ${d.bn.toLowerCase()}</span></div>
          <div><h4>Effort by role</h4><div class="tw"><table><thead><tr><th>Role</th><th class="n">PD</th><th class="n">Share</th></tr></thead><tbody>
            ${d.roles.map(x=>`<tr><td>${x.role}</td><td class="n">${fmt(x.pd)}</td><td class="n">${fmt(x.share*100)}%</td></tr>`).join("")}
            <tr class="total"><td>Total</td><td class="n">${fmt(d.totalPD)}</td><td class="n">100%</td></tr></tbody></table></div></div>
        </div></div></div></details>`;}).join("");
  box.querySelectorAll("details.aplan").forEach(el=>el.addEventListener("toggle",()=>{const k=+el.dataset.k;if(el.open)AP_CLOSED.delete(k);else AP_CLOSED.add(k);}));
  ds.forEach(d=>{const b=document.getElementById("use-opt-"+d.i);if(b&&d.opt)b.onclick=()=>{applyOptimal(d.i,d.opt);save();renderAreas();compute();toast("Optimal team applied to "+d.name);};});
}
function exportModel(){
  const P=S.params,hpd=P.hpd||8,p=planAll(),{act,dur,tot}=p,u=redF(P),R=S.rates[S.basis];
  const ix=p.areas.map((a,i)=>a.has?i:-1).filter(i=>i>=0);
  const moN=w=>isFinite(w)?r1(w/WPM):null;
  const fixCap=c=>({...c,pd:r0(c.pd),end:c.end==null?null:moN(c.end),need:c.need==null||!isFinite(c.need)?null:c.need});
  const caps=capRows(p).map(fixCap);
  const areas=ix.map(i=>{const a=p.areas[i];return{name:nm(S.areas[i],i),tech:a.h.t.T.items,rd:a.h.t.R.items,devT:a.devT,devR:a.devR,leads:+S.areas[i].team.lead||0,lead:r1(a.lead||0),fa:a.fa,ba:a.ba,
    techMo:a.durT?moN(a.durT):null,rdMo:a.durR?moN(a.durR):null,doneMo:moN(p.per[i].dur),devPD:r0(a.h.devPlain/hpd),faPD:r0(a.h.t.R.fa/hpd),testPD:r0((a.h.testPlain+a.h.utH)/hpd),
    revPD:r0((a.h.t.T.rev+a.h.t.R.rev)/hpd),totalPD:r0(a.h.total/hpd)};});
  const sumA=k=>areas.reduce((x,a)=>x+(a[k]||0),0);
  const areaTotal={name:"All areas (parallel)",tech:sumA("tech"),rd:sumA("rd"),devT:sumA("devT"),devR:sumA("devR"),leads:sumA("leads"),lead:r1(sumA("lead")),fa:sumA("fa"),ba:sumA("ba"),
    techMo:moN(Math.max(0,...act.map(a=>a.durT))),rdMo:moN(Math.max(0,...act.map(a=>a.durR))),doneMo:moN(dur),devPD:sumA("devPD"),faPD:sumA("faPD"),testPD:sumA("testPD"),revPD:sumA("revPD"),totalPD:sumA("totalPD")};
  const gh=(k,n)=>{const r=R[k];return n*(r[0]+r[1]*(1-u)*(1+P.ut/100+P.rev/100)+(r[2]+r[3])*(1-u));};
  const allItems=areas.reduce((x,a)=>x+a.tech+a.rd,0)||1;const cat=[];
  [["T","Pure technical fix"],["R","Needs redesign (FA/SME input)"]].forEach(([c,label])=>{
    const ks=GROUPS.map((g,k)=>g.cat===c?k:-1).filter(k=>k>=0);
    const per=ix.map(i=>ks.reduce((x,k)=>x+(+S.areas[i].counts[k]||0),0)),t=per.reduce((x,y)=>x+y,0);
    cat.push({grp:c,name:label,how:"",per,total:t,share:t/allItems,pd:r0(ks.reduce((x,k)=>x+ix.reduce((y,i)=>y+gh(k,+S.areas[i].counts[k]||0),0),0)/hpd)});
    ks.forEach(k=>{const v=ix.map(i=>+S.areas[i].counts[k]||0),tt=v.reduce((x,y)=>x+y,0);if(!tt)return;
      cat.push({grp:null,cat:c,name:GROUPS[k].name,how:HOW[k],per:v,total:tt,share:tt/allItems,pd:r0(ix.reduce((y,i)=>y+gh(k,+S.areas[i].counts[k]||0),0)/hpd)});});});
  const roles=[["Developers (triage, build, unit test)",tot("devPlain")-p.smeTri],["Functional analysts (FA)",act.reduce((x,a)=>x+a.h.t.R.fa,0)-p.smeFa],["SME (area expert: triage & decisions)",p.smeUsed],["Business analysts (functional testing)",tot("testPlain")],
    ["Tech leads (review & sign-off)",act.reduce((x,a)=>x+a.h.t.T.rev+a.h.t.R.rev,0)],["PM / coordination",tot("pmH")],["Contingency",tot("contH")]].map(([l,h])=>({role:l,h:r0(h),pd:r0(h/hpd)}));
  const T=p.team,team=T.dev+T.lead+T.fa+T.ba+T.smeN+p.pm;
  const on=S.fpOn!==false,lo=planAll({fp:20}),hi=planAll({fp:30});
  const fpInfo={on,fp:fpOf(P),minMo:isFinite(hi.dur)?(hi.dur/WPM).toFixed(1):null,maxMo:isFinite(lo.dur)?(lo.dur/WPM).toFixed(1):null,minPD:r0(hi.tot("total")/hpd),maxPD:r0(lo.tot("total")/hpd)};
  const opts=S.areas.map((a,i)=>p.per[i]?areaOptimal(i):null),live=opts.filter(Boolean);
  const opt=live.length?(()=>{const o={lead:0,fa:0,ba:0,sme:0,smeN:0,pm:0,total:0};live.forEach(x=>{for(const k in o)o[k]+=x[k];});o.months=(Math.max(...live.map(x=>x.dur))/WPM).toFixed(1);return o;})():null;
  const details=areaDetails(p,opts).map(d=>({...d,caps:d.caps.map(fixCap),opt:d.opt?{...d.opt,months:(d.opt.dur/WPM).toFixed(1)}:null}));
  const tg=[...new Set(ix.map(i=>+S.areas[i].team.target||0))];
  return{details,fpInfo,opt,date:new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"}),basis:S.basis==="real"?"Realistic":"Conservative",
    team:{dev:T.dev,lead:T.lead,fa:T.fa,ba:T.ba,sme:T.sme,smeN:T.smeN,pm:p.pm,total:team,target:tg.length===1?tg[0]:"each area's target"},
    needLabel:tg.length===1?`Recommended for ${tg[0]} months`:"Recommended for area targets",
    bnArea:p.bnArea>=0?nm(S.areas[p.bnArea],p.bnArea):"",
    kpi:{months:isFinite(dur)?r1(dur/WPM):null,weeks:isFinite(dur)?r1(dur):null,bn:act.length?p.bn:"–",totalPD:r0(tot("total")/hpd),totalH:r0(tot("total")),testPD:r0((tot("testPlain")+tot("utH"))/hpd),
      items:areas.reduce((x,a)=>x+a.tech+a.rd,0),techItems:areaTotal.tech,rdItems:areaTotal.rd,nAreas:areas.length},
    caps,areas,areaTotal,cat,areaNames:areas.map(a=>a.name),roles,
    params:PARAMS.map(([k,l])=>[l,S.params[k]]),contUsed:(S.basis==="cons"&&P.cont===10?15:P.cont),
    rates:GROUPS.map((g,i)=>({name:g.name,track:g.cat==="T"?"Technical fix":"Redesign",how:HOW[i],tri:R[i][0],dev:R[i][1],fa:R[i][2],test:R[i][3]}))};
}
const stamp=()=>new Date().toISOString().slice(0,10);
function needData(){if(!planAll().act.length){toast("Add data to at least one area first");return false;}return true;}

async function exportExcel(btn){
  if(!needData())return;btn.disabled=true;const old=btn.textContent;btn.textContent="Building…";
  try{
    await loadScript(["vendor/exceljs.min.js","https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js","https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"],"ExcelJS");
    const m=exportModel(),wb=new ExcelJS.Workbook();wb.creator="Remediation Project Planner";wb.created=new Date();
    const F={name:"Arial",size:10},NAVY="FF1F3864",GRID={style:"thin",color:{argb:"FFD0D7DE"}},B={top:GRID,left:GRID,bottom:GRID,right:GRID};
    const fill=c=>({type:"pattern",pattern:"solid",fgColor:{argb:c}});
    const title=(ws,t,sub)=>{ws.getCell("A1").value=t;ws.getCell("A1").font={name:"Arial",size:16,bold:true,color:{argb:NAVY}};
      ws.getCell("A2").value=sub;ws.getCell("A2").font={name:"Arial",size:9,italic:true,color:{argb:"FF5B6876"}};};
    const h2=(ws,r,t)=>{const c=ws.getCell(r,1);c.value=t;c.font={name:"Arial",size:12,bold:true,color:{argb:NAVY}};return r+1;};
    function table(ws,row,cols,rows){
      const hr=ws.getRow(row);cols.forEach((c,j)=>{const cell=hr.getCell(j+1);cell.value=c.h;cell.font={...F,bold:true,color:{argb:"FFFFFFFF"}};cell.fill=fill(NAVY);
        cell.alignment={vertical:"middle",horizontal:c.n?"right":"left",wrapText:true};cell.border=B;});hr.height=30;
      rows.forEach((r,k)=>{const xr=ws.getRow(row+1+k);cols.forEach((c,j)=>{const cell=xr.getCell(j+1);let v=c.v(r);cell.value=(v===null||v===undefined)?"–":v;
        cell.font={...F,bold:!!r.__bold};cell.border=B;if(c.fmt&&typeof v==="number")cell.numFmt=c.fmt;
        cell.alignment={vertical:"top",horizontal:c.n?"right":"left",wrapText:!!c.wrap};
        if(r.__fill)cell.fill=fill(r.__fill);if(r.__total)cell.border={...B,top:{style:"medium",color:{argb:"FF18212B"}}};});});
      return row+rows.length+2;
    }
    const kv=(ws,r,pairs)=>{pairs.forEach(([l,v,f],j)=>{const c1=ws.getCell(r+j,1),c2=ws.getCell(r+j,2);c1.value=l;c1.font=F;c2.value=v??"–";c2.font={...F,bold:true};
      if(f&&typeof v==="number")c2.numFmt=f;c2.alignment={horizontal:typeof v==="number"?"right":"left"};[c1,c2].forEach(c=>c.border=B);});return r+pairs.length+1;};
    const sub=`Generated ${m.date} · ${m.basis} basis · ${m.fpInfo.on?m.fpInfo.fp+"% false positives":"false positives not considered"}`;
    const mo1=v=>v==null?null:Math.round(v*10)/10;
    // Overview
    const o=wb.addWorksheet("Overview",{views:[{showGridLines:false}]});title(o,"Remediation Project Plan – overview",sub);
    [34,12,12,10,10,10,10,12,12,22,12,12,12,12,20].forEach((w,j)=>o.getColumn(j+1).width=w);
    let r=h2(o,4,"Optimisation by area (each area has its own team; all areas run in parallel)");
    const optRows=m.details.map(d=>({...d,optPeople:d.opt?d.opt.total:d.people,optMo:d.opt?+d.opt.months:mo1(d.months),dPeople:d.opt?d.opt.total-d.people:0,dMo:d.opt&&d.months!=null?Math.round((+d.opt.months-d.months)*10)/10:0}));
    const tot={name:"Project (all areas)",team:{dev:m.team.dev,lead:m.team.lead,fa:m.team.fa,ba:m.team.ba,sme:m.team.sme,smeN:m.team.smeN,target:"–"},r:{pm:m.team.pm},people:m.team.total,months:m.kpi.months,bn:m.kpi.bn,
      tech:m.kpi.techItems,rd:m.kpi.rdItems,totalPD:m.kpi.totalPD,testPD:m.kpi.testPD,opt:m.opt,optPeople:optRows.reduce((x,d)=>x+d.optPeople,0),optMo:Math.max(...optRows.map(d=>d.optMo||0)),__bold:1,__total:1};
    tot.dPeople=tot.optPeople-tot.people;tot.dMo=m.kpi.months==null?0:Math.round((tot.optMo-m.kpi.months)*10)/10;
    r=table(o,r,[{h:"Area",v:x=>x.name},{h:"Developers",v:x=>+x.team.dev||0,n:1,fmt:"0"},{h:"Tech leads",v:x=>+x.team.lead||0,n:1,fmt:"0"},{h:"FA",v:x=>+x.team.fa||0,n:1,fmt:"0"},
      {h:"BA",v:x=>+x.team.ba||0,n:1,fmt:"0"},{h:"SMEs (no.)",v:x=>+x.team.smeN||0,n:1,fmt:"0"},{h:"SME allocation (FTE each)",v:x=>x.team.smeAlloc===undefined?"–":+x.team.smeAlloc,n:1,fmt:"0.00"},{h:"PM (calc.)",v:x=>x.r.pm,n:1,fmt:"0"},{h:"Team",v:x=>x.people,n:1,fmt:"0.##"},{h:"Target (months)",v:x=>x.team.target==="–"?"–":(+x.team.target||0),n:1,fmt:"0.0"},
      {h:"Duration (months)",v:x=>mo1(x.months),n:1,fmt:"0.0"},{h:"Bottleneck",v:x=>x.bn},{h:"Tech items",v:x=>x.tech,n:1,fmt:"#,##0"},{h:"Redesign items",v:x=>x.rd,n:1,fmt:"#,##0"},
      {h:"Total PD",v:x=>Math.round(x.totalPD),n:1,fmt:"#,##0"},{h:"Testing PD",v:x=>Math.round(x.testPD),n:1,fmt:"#,##0"},
      {h:"Optimal leads / FA / BA / SME (no.×FTE) / PM",v:x=>x.opt?`${x.opt.lead} / ${x.opt.fa} / ${x.opt.ba} / ${x.opt.smeAlloc?x.opt.smeN+"×"+x.opt.smeAlloc:x.opt.smeN} / ${x.opt.pm}`:"–"},{h:"Optimal people",v:x=>x.optPeople,n:1,fmt:"0.##"},{h:"Optimal duration (months)",v:x=>x.optMo,n:1,fmt:"0.0"},
      {h:"Change – people",v:x=>x.dPeople,n:1,fmt:"+0.##;-0.##;–"},{h:"Change – months",v:x=>x.dMo,n:1,fmt:"+0.0;-0.0;–"}],[...optRows.map(d=>({...d,__fill:d.dPeople<0?"FFE2EFDA":null})),tot]);
    [15,16,17,18,19].forEach(c=>o.getColumn(c).width=14);o.getColumn(15).width=20;
    kv(o,r,[["Programme duration (months) – slowest area",m.kpi.months,"0.0"],["Slowest area",m.bnArea],["Total effort (PD)",m.kpi.totalPD,"#,##0"],["Total people",m.team.total,"0"]]);
    // one sheet per area – everything for that area
    const used=new Set(["Overview","Assumptions"]);
    m.details.forEach(d=>{let base=d.name.replace(/[\\\/\?\*\[\]:]/g," ").slice(0,31)||"Area",nmx=base,k=2;while(used.has(nmx)){nmx=base.slice(0,28)+" "+k++;}used.add(nmx);
      const w=wb.addWorksheet(nmx,{views:[{showGridLines:false}]});title(w,`Remediation plan – ${d.name}`,(d.src?d.src+" · ":"")+sub);
      [44,12,12,14,46,14,18,34].forEach((x,j)=>w.getColumn(j+1).width=x);
      const a=d.a,t=d.team;let rr=h2(w,4,"Recommended plan");
      rr=kv(w,rr,[["Duration (months)",mo1(d.months),"0.0"],["Target duration (months)",+t.target||0,"0.0"],["Bottleneck (role that finishes last)",d.bn],
        ["Total effort (PD, incl. PM & contingency)",Math.round(d.totalPD),"#,##0"],["Testing effort (PD)",Math.round(d.testPD),"#,##0"],
        ["Team",`${t.dev} developers · ${t.lead} tech leads · ${t.fa} FA · ${t.ba} BA · ${t.smeN} SME × ${t.smeAlloc} FTE · ${d.r.pm} PM = ${d.people} people`],
        ["Optimal team",d.opt?`${d.opt.lead} leads · ${d.opt.fa} FA · ${d.opt.ba} BA · ${d.opt.smeN} SME × ${d.opt.smeAlloc} FTE · ${d.opt.pm} PM = ${d.opt.total} people (${d.opt.months} months)`:"–"],
        ["Developer split",`${a.devT} technical · ${a.devR} redesign${a.lead>0?` · ${fmt(a.lead,1)} lead FTE fixing code`:""}`],
        ["Technical track (months)",a.durT?mo1(a.durT/WPM):null,"0.0"],["Redesign track (months)",a.durR?mo1(a.durR/WPM):null,"0.0"]]);
      rr=h2(w,rr,"Team capacity");
      rr=table(w,rr,[{h:"Role",v:x=>x.role},{h:"Headcount",v:x=>x.head,n:1,fmt:"0.##"},{h:"Effort (PD)",v:x=>x.pd,n:1,fmt:"#,##0"},{h:"Finishes (months)",v:x=>x.end,n:1,fmt:"0.0"},
        {h:"Load",v:x=>x.load,n:1,fmt:"0%"},{h:"Status",v:x=>x.status},{h:`Recommended for ${+t.target||0} months`,v:x=>x.need,n:1,fmt:"0.##"},{h:"Note",v:x=>x.note}],
        d.caps.map(c=>({...c,__fill:c.status==="Bottleneck"?"FFF8E1DC":null})));
      rr=h2(w,rr,"Technical fix vs redesign");
      rr=table(w,rr,[{h:"Check type",v:x=>x.name,wrap:1},{h:"Work items",v:x=>x.items,n:1,fmt:"#,##0"},{h:"Share",v:x=>x.share,n:1,fmt:"0%"},{h:"Effort PD*",v:x=>Math.round(x.pd),n:1,fmt:"#,##0"},{h:"Fix approach",v:x=>x.how||"",wrap:1}],
        [...d.rows.map(x=>x.grp?{...x,__bold:1,__fill:x.grp==="T"?"FFE2EFDA":"FFFCE4D6"}:x),{name:"Total",items:d.tech+d.rd,share:1,pd:d.techPD+d.rdPD,how:"* excludes PM and contingency",__bold:1,__total:1}]);
      rr=h2(w,rr,"Effort by role");
      table(w,rr,[{h:"Role",v:x=>x.role},{h:"Hours",v:x=>Math.round(x.h),n:1,fmt:"#,##0"},{h:"Person-days",v:x=>Math.round(x.pd),n:1,fmt:"#,##0"},{h:"Share",v:x=>x.share,n:1,fmt:"0%"}],
        [...d.roles,{role:"Total",h:d.totalH,pd:d.totalPD,share:1,__bold:1,__total:1}]);
    });
    // Assumptions
    const as=wb.addWorksheet("Assumptions",{views:[{showGridLines:false}]});title(as,"Planning assumptions",sub);
    [46,14,10,10,10,10,52].forEach((x,j)=>as.getColumn(j+1).width=x);
    let ar=table(as,4,[{h:"Parameter",v:x=>x[0]},{h:"Value",v:x=>x[1],n:1}],[...m.params,["Estimate basis",m.basis],["Contingency applied (%)",m.contUsed],["False positives considered",m.fpInfo.on?"Yes":"No"]]);
    ar=h2(as,ar,"Rate card – hours per work item");
    table(as,ar,[{h:"Check type",v:x=>x.name,wrap:1},{h:"Track",v:x=>x.track},{h:"Triage h",v:x=>x.tri,n:1,fmt:"0.00"},{h:"Build h",v:x=>x.dev,n:1,fmt:"0.00"},
      {h:"FA h",v:x=>x.fa,n:1,fmt:"0.00"},{h:"Test h",v:x=>x.test,n:1,fmt:"0.00"},{h:"Fix approach",v:x=>x.how,wrap:1}],m.rates);
    const buf=await wb.xlsx.writeBuffer();
    await saveFile(`Remediation_Plan_${stamp()}.xlsx`,new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  }catch(e){toast(e.message||"Excel export failed");}
  finally{btn.disabled=false;btn.textContent=old;}
}

async function exportPpt(btn){
  if(!needData())return;btn.disabled=true;const old=btn.textContent;btn.textContent="Building…";
  try{
    await loadScript(["vendor/pptxgen.bundle.js","https://cdnjs.cloudflare.com/ajax/libs/pptxgenjs/3.12.0/pptxgen.bundle.js","https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js"],"PptxGenJS");
    const m=exportModel(),pp=new PptxGenJS();pp.layout="LAYOUT_WIDE";pp.title="Remediation Project Plan";
    const NAVY="1F3864",ACC="1D5FA8",TECH="2F8A5B",RD="C07A12",INK="18212B",MUT="5B6876",SOFT="E9EDF1",WARN="B3361F",FONT="Arial";
    const nq=v=>v==null?"–":(+v%1?String(Math.round(+v*100)/100):String(Math.round(+v))),n0=v=>v==null?"–":Math.round(v).toLocaleString("en-GB"),n1=v=>v==null?"–":(+v).toFixed(1);
    const basisTxt=`${m.basis} basis · ${m.fpInfo.on?m.fpInfo.fp+"% false positives":"false positives not considered"}`;
    pp.defineSlideMaster({title:"BODY",background:{color:"FFFFFF"},objects:[{rect:{x:0,y:0,w:13.33,h:0.12,fill:{color:NAVY}}},
      {text:{text:`Remediation Project Plan · ${m.date} · ${basisTxt}`,options:{x:0.5,y:7.05,w:10,h:0.3,fontFace:FONT,fontSize:9,color:MUT}}}],
      slideNumber:{x:12.4,y:7.05,w:0.5,h:0.3,fontFace:FONT,fontSize:9,color:MUT}});
    const head=(sl,t,sub)=>{sl.addText(t,{x:0.5,y:0.35,w:12.3,h:0.6,fontFace:FONT,fontSize:26,bold:true,color:NAVY,fit:"shrink"});
      if(sub)sl.addText(sub,{x:0.5,y:0.95,w:12.3,h:0.4,fontFace:FONT,fontSize:13,color:MUT});};
    const H=(t,al="left")=>({text:t,options:{bold:true,color:"FFFFFF",fill:{color:NAVY},align:al,valign:"middle"}});
    const C=(t,o={})=>({text:String(t),options:o});
    const tblOpt=(x,y,colW,fs=11)=>({x,y,w:colW.reduce((a,b)=>a+b,0),colW,fontFace:FONT,fontSize:fs,color:INK,border:{type:"solid",pt:0.5,color:"D0D7DE"},valign:"middle",margin:0.04,autoPage:true,autoPageRepeatHeader:true,autoPageSlideStartY:1.5});
    // title
    const s1=pp.addSlide();s1.background={color:NAVY};
    s1.addText("SAP CODE REMEDIATION · P1/P2 FINDINGS",{x:0.8,y:2.1,w:11,h:0.4,fontFace:FONT,fontSize:14,color:"A9C4E8",charSpacing:2});
    s1.addText("Remediation Project Plan",{x:0.8,y:2.6,w:11.5,h:1.1,fontFace:FONT,fontSize:44,bold:true,color:"FFFFFF"});
    s1.addText(m.details.map(d=>d.name).join(" · "),{x:0.8,y:3.8,w:11.5,h:0.9,fontFace:FONT,fontSize:18,color:"DCE6F2",fit:"shrink",valign:"top"});
    s1.addText(`${m.date} · ${basisTxt}`,{x:0.8,y:6.4,w:11,h:0.4,fontFace:FONT,fontSize:12,color:"A9C4E8"});
    // overview (only when several areas)
    {const so=pp.addSlide({masterName:"BODY"});
      head(so,"Optimisation by area",`Current vs optimal team per area. All areas run in parallel; the project ends at ${n1(m.kpi.months)} months (slowest area: ${m.bnArea}).`);
      const OPT={color:"E2EFDA"},sg=(v,d=0)=>Math.abs(v)<1e-9?"–":(v>0?"+":"−")+(d?Math.abs(v).toFixed(d):nq(Math.abs(v)));
      let cp=0,op=0,od=0;
      const rws=m.details.map(d=>{const t=d.team,o=d.opt,opP=o?o.total:d.people,opM=o?+o.months:d.months,dp=opP-d.people,dm=o&&d.months!=null?+o.months-d.months:0;cp+=d.people;op+=opP;od=Math.max(od,opM||0);
        return[C(d.name),C(`${t.dev} / ${t.lead} / ${t.fa} / ${t.ba} / ${t.smeN}×${t.smeAlloc} / ${d.r.pm}`,{align:"center"}),C(nq(d.people),{align:"right",bold:true}),C(n1(d.months),{align:"right",bold:true}),C(d.bn,{align:"center",color:WARN,bold:true,fontSize:10}),
          C(o?`${t.dev} / ${o.lead} / ${o.fa} / ${o.ba} / ${o.smeN}×${o.smeAlloc} / ${o.pm}`:"–",{align:"center",fill:OPT}),C(nq(opP),{align:"right",bold:true,fill:OPT}),C(n1(opM),{align:"right",bold:true,fill:OPT}),
          C(sg(dp),{align:"right",bold:true,color:dp<0?TECH:dp>0?WARN:MUT}),C(Math.abs(dm)<0.05?"–":sg(dm,1),{align:"right",bold:true,color:dm<0?TECH:dm>0?WARN:MUT})];});
      const S0={bold:true,fill:{color:SOFT}};
      rws.push([C("Project (all areas)",S0),C(`${m.team.dev} / ${m.team.lead} / ${m.team.fa} / ${m.team.ba} / ${m.team.smeN} / ${m.team.pm}`,{...S0,align:"center"}),C(nq(cp),{...S0,align:"right"}),C(n1(m.kpi.months),{...S0,align:"right"}),C(m.kpi.bn,{...S0,align:"center",fontSize:10}),
        C(m.opt?`${m.team.dev} / ${m.opt.lead} / ${m.opt.fa} / ${m.opt.ba} / ${m.opt.smeN} / ${m.opt.pm}`:"–",{...S0,align:"center"}),C(nq(op),{...S0,align:"right"}),C(n1(od),{...S0,align:"right"}),C(sg(op-cp),{...S0,align:"right"}),C(m.kpi.months==null||Math.abs(od-m.kpi.months)<0.05?"–":sg(od-m.kpi.months,1),{...S0,align:"right"})]);
      so.addTable([[H("Area"),H("Current: Dev / Lead / FA / BA / SME / PM","center"),H("People","right"),H("Months","right"),H("Bottleneck","center"),H("Optimal: Dev / Lead / FA / BA / SME / PM","center"),H("People","right"),H("Months","right"),H("Δ people","right"),H("Δ months","right")],...rws],
        tblOpt(0.5,1.6,[2.3,1.9,0.8,0.85,1.6,1.9,0.8,0.85,0.75,0.8],11));}
    m.details.forEach(d=>{const a=d.a,t=d.team;
      // 1 recommended plan
      const rp=pp.addSlide({masterName:"BODY"});
      head(rp,`${d.name} – recommended plan`,`${d.months==null?"No end date":n1(d.months)+" months"} (target ${t.target}) with a team of ${nq(d.people)}; ${d.bn.toLowerCase()} set the end date.`);
      [["Duration",d.months==null?"–":n1(d.months),"months",ACC],["Total effort",n0(d.totalPD),"person-days",ACC],["Testing effort",n0(d.testPD),"person-days",ACC],["Team",nq(d.people),`${t.dev} dev · ${t.lead} lead · ${t.fa} FA · ${t.ba} BA · ${t.smeN}×${t.smeAlloc} SME · ${d.r.pm} PM`,ACC],["Bottleneck",d.bn,"",WARN]]
        .forEach(([l,v,u2,col],k)=>{const x=0.5+k*2.5;rp.addShape(pp.ShapeType.rect,{x,y:1.5,w:2.3,h:1.45,fill:{color:"F3F5F7"},line:{color:"D8DEE5",width:0.75}});
          rp.addShape(pp.ShapeType.rect,{x,y:1.5,w:0.07,h:1.45,fill:{color:col},line:{color:col,width:0}});
          rp.addText(l.toUpperCase(),{x:x+0.2,y:1.58,w:2,h:0.3,fontFace:FONT,fontSize:9,color:MUT,bold:true});
          rp.addText(v,{x:x+0.2,y:1.88,w:2.05,h:0.6,fontFace:FONT,fontSize:k===4?16:26,bold:true,color:k===4?WARN:INK,fit:"shrink"});
          if(u2)rp.addText(u2,{x:x+0.2,y:2.5,w:2.05,h:0.35,fontFace:FONT,fontSize:k===3?8.5:10,color:MUT});});
      if(d.opt)rp.addText(`Optimal team for ${t.dev} developers: ${d.opt.lead} leads · ${d.opt.fa} FA · ${d.opt.ba} BA · ${d.opt.smeN} SME × ${d.opt.smeAlloc} FTE · ${d.opt.pm} PM = ${d.opt.total} people (${d.opt.months} months)`,
        {x:0.5,y:3.1,w:12.3,h:0.45,fontFace:FONT,fontSize:13,bold:true,color:TECH,fill:{color:"E2EFDA"},margin:0.1});
      rp.addTable([[H("Role"),H("Headcount","right"),H("Effort (PD)","right"),H("Finishes (months)","right"),H("Load","right"),H("Status","center"),H(`Recommended for ${t.target} mo`,"right"),H("Note")],
        ...d.caps.map(c=>{const bn=c.status==="Bottleneck",o={bold:bn,fill:bn?{color:"F8E1DC"}:undefined};return[C(c.role,o),C(nq(c.head),{...o,align:"right"}),C(n0(c.pd),{...o,align:"right"}),C(n1(c.end),{...o,align:"right"}),
          C(c.load==null?"–":Math.round(c.load*100)+"%",{...o,align:"right"}),C(c.status,{...o,align:"center",color:bn?WARN:c.status==="Has slack"?TECH:MUT,bold:true}),C(c.need==null?"–":nq(c.need),{...o,align:"right"}),C(c.note||"",{...o,color:MUT,fontSize:10})];})],
        tblOpt(0.5,3.75,[2.6,1.2,1.3,1.5,1.0,1.4,1.6,1.7],12));
      // 2 technical fix vs redesign
      const sv=pp.addSlide({masterName:"BODY"});
      head(sv,`${d.name} – technical fix vs redesign`,`${Math.round(d.tech/((d.tech+d.rd)||1)*100)}% of work items are pure technical fixes; ${Math.round(d.rd/((d.tech+d.rd)||1)*100)}% need an FA/SME decision first.`);
      const rows=d.rows.map(r=>{const g=!!r.grp,f=g?{color:r.grp==="T"?"E2EFDA":"FCE4D6"}:undefined;return[C(r.name,{bold:g,fill:f}),C(n0(r.items),{bold:g,fill:f,align:"right"}),C(Math.round(r.share*100)+"%",{bold:g,fill:f,align:"right"}),C(n0(r.pd),{bold:g,fill:f,align:"right"})];});
      rows.push([C("Total",{bold:true,fill:{color:SOFT}}),C(n0(d.tech+d.rd),{bold:true,fill:{color:SOFT},align:"right"}),C("100%",{bold:true,fill:{color:SOFT},align:"right"}),C(n0(d.techPD+d.rdPD),{bold:true,fill:{color:SOFT},align:"right"})]);
      sv.addTable([[H("Check type"),H("Work items","right"),H("Share","right"),H("Effort PD*","right")],...rows],{...tblOpt(0.5,1.5,[4.7,1.1,0.8,1.1],10),margin:0.03,rowH:0.27});
      sv.addChart(pp.ChartType.doughnut,[{name:"Work items",labels:["Technical fix","Needs redesign"],values:[d.tech,d.rd]}],
        {x:8.6,y:1.5,w:4.3,h:3.4,chartColors:[TECH,RD],holeSize:55,showLegend:true,legendPos:"b",legendFontFace:FONT,legendFontSize:11,showPercent:true,showValue:false,dataLabelColor:"FFFFFF",dataLabelFontSize:12,dataLabelFontBold:true});
      sv.addText([{text:"Effort (PD, excl. PM & contingency)",options:{bold:true,color:NAVY,breakLine:true}},{text:`Technical fix: ${n0(d.techPD)}`,options:{color:TECH,breakLine:true}},{text:`Needs redesign: ${n0(d.rdPD)}`,options:{color:RD}}],
        {x:8.6,y:5.1,w:4.3,h:0.9,fontFace:FONT,fontSize:12,valign:"top"});
      // 3 timeline & effort by role
      const st=pp.addSlide({masterName:"BODY"});
      head(st,`${d.name} – timeline and effort`,`Developers: ${a.devT} on technical fixes, ${a.devR} on redesign${a.lead>0?`, plus ${n1(a.lead)} lead FTE fixing code`:""}. Area finishes at ${n1(d.months)} months.`);
      st.addChart(pp.ChartType.bar,[{name:"Months",labels:["Technical track","Redesign track","Area done"],values:[a.durT?r1(a.durT/WPM):0,a.durR?r1(a.durR/WPM):0,d.months==null?0:r1(d.months)]}],
        {x:0.5,y:1.6,w:6.3,h:3.2,barDir:"bar",chartColors:[TECH,RD,NAVY],varyColors:true,showValue:true,dataLabelFormatCode:"0.0",dataLabelFontSize:11,catAxisLabelFontFace:FONT,catAxisLabelFontSize:11,
         valAxisMinVal:0,valAxisLabelFontSize:10,showLegend:false,showTitle:true,title:"Months from start (incl. start-up and test tail)",titleFontFace:FONT,titleFontSize:11,titleColor:MUT,catAxisOrientation:"maxMin",valGridLine:{color:"E5E9EE",size:0.5}});
      st.addTable([[H("Role"),H("Person-days","right"),H("Share","right")],...d.roles.map(x=>[C(x.role),C(n0(x.pd),{align:"right"}),C(Math.round(x.share*100)+"%",{align:"right"})]),
        [C("Total",{bold:true,fill:{color:SOFT}}),C(n0(d.totalPD),{bold:true,fill:{color:SOFT},align:"right"}),C("100%",{bold:true,fill:{color:SOFT},align:"right"})]],tblOpt(0.5,5.0,[3.8,1.3,0.9],10));
      st.addChart(pp.ChartType.pie,[{name:"Effort",labels:d.roles.map(x=>x.role.replace(/ \(.*\)/,"")),values:d.roles.map(x=>Math.round(x.h))}],
        {x:7.4,y:1.5,w:5.4,h:5.3,chartColors:[ACC,RD,TECH,NAVY,"8A97A6","C9D1DA"],showLegend:true,legendPos:"b",legendFontFace:FONT,legendFontSize:10,showPercent:true,dataLabelColor:"FFFFFF",dataLabelFontSize:10,showTitle:true,title:"Effort by role",titleFontFace:FONT,titleFontSize:12,titleColor:MUT});
    });
    // assumptions
    const s8=pp.addSlide({masterName:"BODY"});head(s8,"Planning assumptions","Hours per work item come from the rate card; every value can be changed in the planner.");
    s8.addTable([[H("Parameter"),H("Value","right")],...m.params.map(([l,v])=>[C(l),C(String(v),{align:"right"})]),[C("Estimate basis"),C(m.basis,{align:"right"})],[C("False positives considered"),C(m.fpInfo.on?"Yes":"No",{align:"right"})]],
      {...tblOpt(0.5,1.6,[4.6,1.2],11),rowH:0.32});
    s8.addTable([[H("Check type"),H("Build h","right"),H("Test h","right")],...m.rates.map(x=>[C(x.name,{color:x.track==="Technical fix"?TECH:RD}),C(x.dev.toFixed(2),{align:"right"}),C(x.test.toFixed(2),{align:"right"})])],
      {x:6.8,y:1.6,w:6.0,colW:[4.1,0.95,0.95],fontFace:FONT,fontSize:9.5,color:INK,border:{type:"solid",pt:0.5,color:"D0D7DE"},margin:0.03,rowH:0.3});
    const blob=await pp.write({outputType:"blob"});
    await saveFile(`Remediation_Plan_${stamp()}.pptx`,blob);
  }catch(e){toast(e.message||"PowerPoint export failed");}
  finally{btn.disabled=false;btn.textContent=old;}
}
document.getElementById("exp-xlsx").addEventListener("click",e=>exportExcel(e.currentTarget));
document.getElementById("exp-pptx").addEventListener("click",e=>exportPpt(e.currentTarget));

document.getElementById("fp-on").addEventListener("change",e=>{S.fpOn=e.target.checked;save();compute();});
document.getElementById("fp-pct").addEventListener("input",e=>{S.params.fp=Math.min(90,Math.max(0,+e.target.value||0));save();const pi=document.getElementById("p-fp");if(pi)pi.value=S.params.fp;compute();});
document.getElementById("ap-open").addEventListener("click",()=>{AP_CLOSED.clear();document.querySelectorAll("details.aplan").forEach(d=>d.open=true);});
document.getElementById("ap-close").addEventListener("click",()=>{document.querySelectorAll("details.aplan").forEach(d=>{d.open=false;AP_CLOSED.add(+d.dataset.k);});});
document.getElementById("p12").checked=S.p12;
document.getElementById("add-area").addEventListener("click",()=>{S.areas.push(blank());save();renderAreas();compute();});
document.getElementById("load-ex").addEventListener("click",()=>{const i=S.areas.findIndex(a=>!a.counts.some(c=>+c>0));if(i>=0)S.areas[i]=example();else S.areas.push(example());save();renderAreas();compute();});
document.getElementById("reset").addEventListener("click",()=>{S.areas=Array.from({length:DEF_AREAS},blank);save();renderAreas();compute();toast("All areas cleared");});
renderParams();renderAreas();renderRates();setBasis(S.basis);
