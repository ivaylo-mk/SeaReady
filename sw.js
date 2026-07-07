const CACHE='seaready-v40';
/* App shell — small and critical. Must cache for the app to start offline. */
const SHELL=['./','./index.html','./manifest.json',
  './icon-192.png','./icon-512.png','./icon-180.png','./favicon-192.png','./favicon-96.png'];
/* OCR engine — large (~11MB). Cached best-effort so a download failure can NEVER block offline startup. */
const EXTRAS=['./ocr/tesseract.min.js','./ocr/worker.min.js',
  './ocr/tesseract-core-simd-lstm.wasm.js','./ocr/tesseract-core-lstm.wasm.js','./ocr/eng.traineddata.gz'];
self.addEventListener('install',e=>{
  e.waitUntil((async()=>{
    const c=await caches.open(CACHE);
    await c.addAll(SHELL);                                  // must succeed → guarantees offline start
    await Promise.allSettled(EXTRAS.map(u=>c.add(u)));      // best-effort; missing OCR won't break the app
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  /* App navigations: serve the cached shell FIRST — the fastest, most reliable offline start,
     so the service worker wins the cold-start race against Chrome's offline page more often. */
  if(e.request.mode==='navigate'){
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
          const clone=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone));
        }
        return res;
      }).catch(()=> caches.match('./index.html',{ignoreSearch:true}));
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
/* ---- verify EVERY offline asset is cached; re-download any that are missing (called by the app when online) ---- */
async function ensureCached(){
  const c=await caches.open(CACHE);
  const all=[...SHELL, ...EXTRAS];
  const missing=[];
  for(const u of all){ const hit=await c.match(u,{ignoreSearch:true}); if(!hit) missing.push(u); }
  let remaining=0;
  if(missing.length){
    const res=await Promise.allSettled(missing.map(u=>c.add(u)));
    remaining=res.filter(r=>r.status==='rejected').length;
  }
  return {total:all.length, missing:missing.length, cached:missing.length-remaining, remaining};
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
