# Builds dist/ToolboxPlus.html: the whole Toolbox+ app (all tools, libraries, workers) in ONE file that runs by double-click, offline.
# Usage: python3 portable/build-single-file.py [output.html]
import base64,json,re,os
import sys
R=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),'..'))+'/'
OUT=sys.argv[1] if len(sys.argv)>1 else os.path.join(R,'dist','ToolboxPlus.html')
rd=lambda p:open(R+p,encoding='utf-8').read()
rb=lambda p:open(R+p,'rb').read()
VER=re.search(r'Build ([\d.\-]+)',rd('index.html')).group(1)

# ---- virtual files (loaded lazily by workers / dynamic script tags / fetch) ----
def patch_locate(t): 
    assert "locateFile: f => 'vendor/' + f" in t
    return t.replace("locateFile: f => 'vendor/' + f","locateFile: f => (self.__vfsUrl ? self.__vfsUrl('vendor/' + f) : 'vendor/' + f)")
vfs={}
for p in ['papaparse.min.js','xlsx.full.min.js','fxp.min.js','js-yaml.min.js','beautifier.min.js','sql-formatter.min.js','xlsx-style.min.js','sql-wasm.js','sql-wasm.wasm','exceljs.min.js','pptxgen.bundle.js']:
    vfs['vendor/'+p]=rb('vendor/'+p)
vfs['worker.js']=rd('worker.js').encode()
mj=rd('migrate.js'); m_old="initSqlJs({ locateFile: f => 'vendor/' + f })"; assert m_old in mj
mj=mj.replace(m_old,"initSqlJs({ wasmBinary: self.__vfsBytes ? self.__vfsBytes('vendor/sql-wasm.wasm') : undefined, locateFile: f => 'vendor/' + f })")
mj=mj.replace("'use strict';",'',1)   # worker loads this with eval, where strict mode would keep its functions private
vfs['migrate.js']=mj.encode()
vfs['sap-cva-core.js']=rd('sap-cva-core.js').encode()
vfs['seed/links.json']=rb('seed/links.json')
mime=lambda k:'application/wasm' if k.endswith('.wasm') else 'application/json' if k.endswith('.json') else 'text/javascript'
vfs_js='window.__VFS_DATA={'+','.join(json.dumps(k)+':"'+base64.b64encode(v).decode()+'"' for k,v in vfs.items())+'};'

shim=r'''
(function(){
  var D=window.__VFS_DATA,B={},U={};
  var mime=function(k){return /\.wasm$/.test(k)?'application/wasm':/\.json$/.test(k)?'application/json':'text/javascript'};
  var norm=function(u){return String(u).replace(/[?#].*$/,'').replace(/^\.\//,'')};
  var bytes=function(k){if(!B[k]){var s=atob(D[k]),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);B[k]=a;}return B[k];};
  var url=function(u){var k=norm(u);if(!(k in D))return null;if(!U[k])U[k]=URL.createObjectURL(new Blob([bytes(k)],{type:mime(k)}));return U[k];};
  window.__vfsUrl=function(p){return url(p)||p;};
  var text=function(k){return new TextDecoder().decode(bytes(k));};
  function patch(w){var d=Object.getOwnPropertyDescriptor(w.HTMLScriptElement.prototype,'src');
    Object.defineProperty(w.HTMLScriptElement.prototype,'src',{get:d.get,configurable:true,set:function(v){var u=url(v);d.set.call(this,u||v);}});}
  window.__vfsPatch=patch; patch(window);
  var of=window.fetch;
  window.fetch=function(u,o){var k=typeof u==='string'?norm(u):null;if(k&&(k in D))return Promise.resolve(new Response(bytes(k),{headers:{'Content-Type':mime(k)}}));return of.apply(this,arguments);};
  var OW=window.Worker;
  var NOW={'vendor/exceljs.min.js':1,'vendor/pptxgen.bundle.js':1};
  window.Worker=function(u,o){var k=norm(u);
    if(k in D){var sub={};Object.keys(D).forEach(function(x){if(!NOW[x])sub[x]=D[x];});
      var pre='self.__D='+JSON.stringify(sub)+';(function(){var C={};'
        +'function by(k){var s=atob(self.__D[k]),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}'
        +'self.__vfsBytes=function(p){return (p in self.__D)?by(p):undefined;};'
        +'self.importScripts=function(){for(var i=0;i<arguments.length;i++){var k=String(arguments[i]).replace(/^\\.\\//,"");if(!(k in self.__D))throw new Error("Script not bundled: "+k);if(C[k])continue;C[k]=1;(0,eval)(new TextDecoder().decode(by(k)));}};'
        +'})();\n';
      u=URL.createObjectURL(new Blob([pre+text(k)],{type:'text/javascript'}));}
    return new OW(u,o);};
  window.Worker.prototype=OW.prototype;
})();
'''

# ---- planner page for the srcdoc iframe ----
pl=rd('remediation-planner.html')
pl=pl.replace('<script src="vendor/xlsx.full.min.js"></script>',"<script>parent.__vfsPatch(window);(function(){var s=document.createElement('script');s.src='vendor/xlsx.full.min.js';document.head.appendChild(s);})();</script>")
pj=rd('remediation-planner.js')
tag=re.search(r'<script src="remediation-planner\.js[^"]*"></script>',pl).group(0)
pl=pl.replace(tag,'<script>'+pj.replace('</script','<\\/script')+'</script>')
planner='window.__plannerDoc=function(){return '+json.dumps(pl).replace('</','<\\/')+';};'

# ---- app scripts, patched for the single-file build ----
app=rd('app.js')
a="""        el.innerHTML = '<div class="planner-bar"><span class="hint">The planner keeps its plans on this device. </span><a href="remediation-planner.html" target="_blank" rel="noopener">Open in a full window</a></div><iframe class="planner-frame" src="remediation-planner.html" title="Remediation Project Planner"></iframe>';
        const f = el.querySelector('iframe'), fit"""
assert a in app
app=app.replace(a,"""        el.innerHTML = '<div class="planner-bar"><span class="hint">The planner keeps its plans on this device.</span></div><iframe class="planner-frame" title="Remediation Project Planner"></iframe>';
        const f = el.querySelector('iframe'); f.srcdoc = window.__plannerDoc(); const fit""".replace('const fit','fit') if False else """        el.innerHTML = '<div class="planner-bar"><span class="hint">The planner keeps its plans on this device.</span></div><iframe class="planner-frame" title="Remediation Project Planner"></iframe>';
        const f = el.querySelector('iframe'); f.srcdoc = window.__plannerDoc();
        const fit""")
assert "const fit = () =>" in app or "fit = () =>" in app
sw_old="if ('serviceWorker' in navigator && !isNative())"; assert sw_old in app
app=app.replace(sw_old,"if ('serviceWorker' in navigator && !isNative() && location.protocol !== 'file:')")
off=patch_locate(rd('offline-db.js'))
order=[('config.js',rd('config.js')),('offline-db.js',off),('adapter.js',rd('adapter.js')),('sap-cva-core.js',rd('sap-cva-core.js')),('sap-cva.js',rd('sap-cva.js')),('sap-delta.js',rd('sap-delta.js')),('app.js',app),('tasks.js',rd('tasks.js')),('insurance.js',rd('insurance.js')),('home.js',rd('home.js')),('notify.js',rd('notify.js')),('biolock.js',rd('biolock.js'))]
css=rd('styles.css')
idx=rd('index.html')
body=re.search(r'<body>(.*?)<script src="config\.js',idx,re.S).group(1)
icon=base64.b64encode(rb('icons/icon.svg')).decode()
esc=lambda s:s.replace('</script','<\\/script')
out=['<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Toolbox+ — tools, tasks, links &amp; policies</title>\n<meta name="theme-color" content="#3346D3">\n<link rel="icon" href="data:image/svg+xml;base64,%s">\n'%icon,
 '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">\n',
 '<style>\n'+css+'\n</style>\n</head>\n<body>'+body,
 '<script>'+esc(vfs_js)+'</script>\n<script>'+shim+'</script>\n<script>'+esc(planner)+'</script>\n']
for n,t in order: out.append('<script>/* '+n+' */\n'+esc(t)+'\n</script>\n')
out.append('</body></html>')
html=''.join(out)
os.makedirs(os.path.dirname(OUT),exist_ok=True)
open(OUT,'w',encoding='utf-8').write(html)
print(len(html)//1024,'KB',VER)
