const CACHE_NAME="luan-tender-board-v1";
const ASSETS=[
  "./","index.html","assets/style.css","assets/app.js",
  "config.json","data/projects.json","data/meta.json",
  "manifest.webmanifest","icons/icon.svg"
];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  if(url.pathname.endsWith("/data/projects.json") || url.pathname.endsWith("/data/meta.json")){
    event.respondWith(fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});
