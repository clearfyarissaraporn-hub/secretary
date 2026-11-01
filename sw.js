/* เลขาส่วนตัว: เก็บไฟล์ไว้ในเครื่องเพื่อเปิดแบบออฟไลน์ได้ · เปลี่ยนเลขเวอร์ชันทุกครั้งที่อัปเดต index.html */
const CACHE = 'secretary-v1.6';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin){
    /* ไฟล์ของแอป: ใช้ของใหม่จากเน็ตก่อน ถ้าไม่มีเน็ตใช้ของที่เก็บไว้ */
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
  } else if (/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host)){
    /* ไลบรารีและฟอนต์: ใช้ของที่เก็บไว้ก่อน */
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
  }
});

/* แตะแจ้งเตือนแล้วเปิดแอป */
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(cs => { const c = cs.find(x => 'focus' in x); return c ? c.focus() : self.clients.openWindow('./'); })); });
