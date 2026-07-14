const CACHE='seaready-v47';
/* OCR engine lives in its OWN, UNVERSIONED cache so it survives shell updates.
   Bumping CACHE re-downloads only the small shell; the ~11MB engine is fetched once.
   Bump ASSETS only when the OCR files themselves change. */
const ASSETS='seaready-ocr-v2';
const KEEP=[CACHE,ASSETS];
/* App shell — small and critical. Must cache for the app to start offline. */
const SHELL=['./','./index.html','./manifest.json',
  './icon-192.png','./icon-512.png','./icon-180.png','./favicon-192.png','./favicon-96.png'];
/* OCR engine — large (~11MB). Cached best-effort so a download failure can NEVER block offline startup. */
const EXTRAS=['./ocr/tesseract.min.js','./ocr/worker.min.js',
  './ocr/tesseract-core-simd-lstm.wasm.js','./ocr/tesseract-core-relaxedsimd-lstm.wasm.js','./ocr/eng.traineddata.gz'];
const isExtra=u=>EXTRAS.some(x=>u.endsWith(x.replace('./','/')));
/* add only what is genuinely absent — never re-download an asset we already hold */
async function addMissing(cache,urls){
  const missing=[];
  for(const u of urls){ if(!(await cache.match(u,{ignoreSearch:true}))) missing.push(u); }
  if(!missing.length) return {missing:0,remaining:0};
  const res=await Promise.allSettled(missing.map(u=>cache.add(u)));
  return {missing:missing.length, remaining:res.filter(r=>r.status==='rejected').length};
}
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    await c.addAll(SHELL);                                  // must succeed → guarantees offline start
    const a=await caches.open(ASSETS);                      // separate cache: survives shell version bumps
    await addMissing(a,EXTRAS);                             // best-effort AND skips anything already cached
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const ks=await caches.keys();
    await Promise.all(ks.filter(k=>!KEEP.includes(k)).map(k=>caches.delete(k)));
    /* FIX 3: self-healing no longer depends solely on the page sending the
       'ensure-offline' message — run it at least once per SW version here.
       The message path still works and remains the retry mechanism. */
    await ensureCached().catch(()=>{});
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  /* App navigations: serve the cached shell FIRST — the fastest, most reliable offline start,
     so the service worker wins the cold-start race against Chrome's offline page more often. */
  if(e.request.mode==='navigate'){
    /* FIX 2: revalidate in the background. Startup still serves the cached
       shell instantly (never waits on the network), but the latest deployed
       index.html is fetched quietly and cached for the NEXT launch — so
       updates reach devices even between cache-name bumps. Failures (offline,
       lie-fi timeout) are silent and retried on the next online launch. */
    e.waitUntil(
      fetch('./index.html',{cache:'reload'}).then(res=>{
        if(res && res.ok) return caches.open(CACHE).then(c=>c.put('./index.html',res.clone()));
      }).catch(()=>{})
    );
    e.respondWith(
      caches.match('./index.html',{ignoreSearch:true})
        .then(shell=> shell || caches.match('./',{ignoreSearch:true}))
        .then(shell=> shell || caches.match(e.request,{ignoreSearch:true}))
        .then(cached=> cached || fetch(e.request))
        .catch(()=> caches.match('./index.html',{ignoreSearch:true}))
    );
    return;
  }
  /* Everything else: cache-first, then network (and cache it for next time). */
  e.respondWith(
    caches.match(e.request,{ignoreSearch:true}).then(hit=>{
      if(hit) return hit;
      return fetch(e.request).then(res=>{
        if(res.ok && e.request.url.startsWith(self.location.origin)){
          const clone=res.clone();
          caches.open(isExtra(e.request.url)?ASSETS:CACHE).then(c=>c.put(e.request,clone));
        }
        return res;
      }).catch(()=>
        /* FIX 1: an offline miss for a script/wasm/data file must NOT be
           answered with index.html — the OCR loader would receive HTML and
           fail with confusing parse/corrupt-model errors. Return a clean
           504 so the caller sees an honest network failure. */
        new Response('',{status:504,statusText:'Offline — resource not cached'})
      );
    })
  );
});
/* ---- background reminder check (Android/Chrome periodic sync) ---- */
function idb(){ return new Promise((res,rej)=>{ const q=indexedDB.open('seaready',1);
  q.onupgradeneeded=()=>q.result.createObjectStore('kv');
  q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }
function idbGet(k){ return idb().then(d=>new Promise((res,rej)=>{
  const q=d.transaction('kv').objectStore('kv').get(k);
  q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); })); }
function idbSet(k,v){ return idb().then(d=>new Promise((res,rej)=>{
  const t=d.transaction('kv','readwrite'); t.objectStore('kv').put(v,k);
  t.oncomplete=res; t.onerror=()=>rej(t.error); })); }
function crossings(items,notify,seen){
  const out=[], t0=new Date(); t0.setHours(0,0,0,0);
  items.forEach(it=>{
    const dl=Math.round((new Date(it.expiry+'T00:00:00')-t0)/86400000);
    const mo=(Math.max(0,dl)/30.44).toFixed(1);
    const d=it.expiry.split('-').reverse().join('.');
    if(dl<0&&notify.m3&&!seen[it.key+'|0'])
      out.push({k:it.key+'|0',title:'Expired: '+it.name,body:it.person+' — expired on '+d,also:[it.key+'|3',it.key+'|6']});
    else if(dl>=0&&dl<=91&&notify.m3&&!seen[it.key+'|3'])
      out.push({k:it.key+'|3',title:'3 months left: '+it.name,body:it.person+' — expires '+d+' ('+mo+' mo)',also:[it.key+'|6']});
    else if(dl>91&&dl<=183&&notify.m6&&!seen[it.key+'|6'])
      out.push({k:it.key+'|6',title:'6 months left: '+it.name,body:it.person+' — expires '+d+' ('+mo+' mo)',also:[]});
  });
  return out;
}
async function backgroundCheck(){
  const snap=await idbGet('snapshot').catch(()=>null);
  if(!snap||!snap.items||!snap.items.length) return;
  const seen=snap.seen||{};
  const due=crossings(snap.items, snap.notify||{m3:true,m6:true}, seen);
  for(const n of due){
    await self.registration.showNotification(n.title,{body:n.body,icon:'icon-192.png',badge:'icon-192.png',tag:n.k});
    seen[n.k]=true; n.also.forEach(k=>seen[k]=true);
  }
  if(due.length){ snap.seen=seen; await idbSet('snapshot',snap); }
}
self.addEventListener('periodicsync',e=>{ if(e.tag==='seaready-check') e.waitUntil(backgroundCheck()); });
/* ---- verify EVERY offline asset is cached; re-download any that are missing
   (runs on activate, and on demand via the 'ensure-offline' message) ---- */
async function ensureCached(){
  const c=await caches.open(CACHE), a=await caches.open(ASSETS);
  const s=await addMissing(c,SHELL);            // small: shell
  const x=await addMissing(a,EXTRAS);           // large: OCR engine, only if genuinely absent
  const missing=s.missing+x.missing, remaining=s.remaining+x.remaining;
  return {total:SHELL.length+EXTRAS.length, missing, cached:missing-remaining, remaining};
}
self.addEventListener('message',e=>{
  if(e.data && e.data.type==='ensure-offline'){
    e.waitUntil(ensureCached().then(r=>{
      if(e.source && e.source.postMessage) e.source.postMessage({type:'offline-status', ...r});
    }));
  }
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){ if('focus' in c) return c.focus(); }
    return clients.openWindow('./index.html');
  }));
});
