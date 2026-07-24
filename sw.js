const CACHE="toolbox-v1.0.0";
const CORE=["./","index.html","assets/portal.css","assets/portal.js","manifest.webmanifest","icons/toolbox.svg"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE&&!x.startsWith("ruankao-")&&!x.startsWith("luan-tender")).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;const u=new URL(e.request.url);if(u.origin!==location.origin)return;if(e.request.mode==="navigate"){e.respondWith(fetch(e.request).catch(()=>caches.match("./index.html")));return}if(CORE.some(x=>u.pathname.endsWith(x.replace("./","")))){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));}});
