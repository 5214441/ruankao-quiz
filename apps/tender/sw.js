const CACHE_NAME="tender-board-v1.3.1";
const STATIC_ASSETS=[
  "./","index.html","assets/style.css?v=131","assets/app.js?v=131",
  "config.json","manifest.webmanifest?v=131","icons/icon.svg"
];
const DATA_PATHS=["/data/projects.json","/data/meta.json","/data/monitor_status.json"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key!==CACHE_NAME && key.includes("tender")).map(key=>caches.delete(key))
  )));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  const isData=DATA_PATHS.some(path=>url.pathname.endsWith(path));
  if(isData || url.pathname.endsWith("/config.json")){
    event.respondWith(fetch(event.request,{cache:"no-store"}).then(response=>{
      const copy=response.clone();
      caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));
});