const CACHE='seaready-v35';
const CORE=['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png','./icon-180.png','./favicon-192.png','./favicon-96.png',
  './ocr/tesseract.min.js','./ocr/worker.min.js',
  './ocr/tesseract-core-simd-lstm.wasm.js','./ocr/tesseract-core-lstm.wasm.js',
  './ocr/eng.traineddata.gz'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(
    caches.match(e.request,{ignoreSearch:true}).then(hit=>hit||fetch(e.request).then(res=>{
      if(res.ok&&(e.request.url.startsWith(self.location.origin)||e.request.url.includes('jsdelivr'))){
        const clone=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone));
      }
      return res;
    }).catch(()=>caches.match('./index.html')))
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
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){ if('focus' in c) return c.focus(); }
    return clients.openWindow('./index.html');
  }));
});
