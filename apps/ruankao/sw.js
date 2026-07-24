const CACHE_NAME='ruankao-v3.5.0-static';
const DATA_CACHE='ruankao-v3.5.0-data';
const CORE=[
  './','./index.html','./offline.html','./css/app.css','./js/storage.js','./js/app.js',
  './manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png',
  './data/questions.json','./data/cases.json','./data/formulas.json','./data/version.json'
];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>![CACHE_NAME,DATA_CACHE].includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',event=>{if(event.data&&event.data.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);if(url.origin!==location.origin)return;
  if(url.pathname.endsWith('/data/version.json')){
    event.respondWith(fetch(req,{cache:'no-store'}).then(r=>{const copy=r.clone();caches.open(DATA_CACHE).then(c=>c.put(req,copy));return r;}).catch(()=>caches.match(req)));
    return;
  }
  if(url.pathname.includes('/data/')){
    event.respondWith(caches.match(req).then(cached=>{const network=fetch(req).then(r=>{const copy=r.clone();caches.open(DATA_CACHE).then(c=>c.put(req,copy));return r;}).catch(()=>cached);return cached||network;}));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(r=>{const copy=r.clone();caches.open(CACHE_NAME).then(c=>c.put('./index.html',copy));return r;}).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')).then(r=>r||caches.match('./offline.html'))));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(r=>{const copy=r.clone();caches.open(CACHE_NAME).then(c=>c.put(req,copy));return r;})));
});
