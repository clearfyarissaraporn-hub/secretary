/* Copyright © 2026 (พ.ศ. 2569) Clear. All rights reserved. สงวนลิขสิทธิ์ทุกประการ */
/* เลขาส่วนตัว · service worker
   - ไฟล์ของแอปโหลดจากเน็ตแบบไม่ใช้แคชของเบราว์เซอร์ (no-store) ทุกครั้ง เพื่อให้อัปเดตทันที ถ้าไม่มีเน็ตใช้ของที่เก็บไว้
   - รับแจ้งเตือน (Push) จากเซิร์ฟเวอร์ Cloudflare ของคุณ แล้วเด้งแม้ปิดแอป */
const CACHE = 'secretary-v1.31';
const CFG = 'tmm-cfg';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => fetch(u, {cache:'no-store'}).then(r => c.put(u, r)).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CFG).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin){
    if (url.pathname.endsWith('version.json')) return; /* ให้ตรวจเวอร์ชันจากเน็ตตรง ๆ */
    e.respondWith(fetch(req, {cache:'no-store'}).then(r => { if (r.ok){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(url.pathname.endsWith('/') ? './' : req, copy)); } return r; })
      .catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || caches.match('./index.html') || caches.match('./'))));
  } else if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host)){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
  }
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
/* ---------- Push: ถึงเวลาแล้วเซิร์ฟเวอร์ปลุก → ถามรายการที่ต้องเตือน → เด้ง ---------- */
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let items = [];
    try{
      const res = await (await caches.open(CFG)).match('/tmm-cfg');
      const c = res ? await res.json() : null;
      if (c && c.url){ const r = await fetch(`${c.url}/pending?dev=${encodeURIComponent(c.dev)}&key=${encodeURIComponent(c.key)}`, {cache:'no-store'}); items = ((await r.json()) || {}).items || []; }
    }catch(err){}
    if (!items.length) items = [{id:'secretary', title:'เลขาส่วนตัว', body:'มีการเตือนของคุณ แตะเพื่อเปิดแอป'}];
    await Promise.all(items.map(it => self.registration.showNotification(it.title, {body: it.body, tag: it.id, icon:'icon-192.png', badge:'icon-192.png', vibrate:[200, 100, 200], requireInteraction:false})));
  })());
});
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(cs => { const c = cs.find(x => 'focus' in x); return c ? c.focus() : self.clients.openWindow('./'); })); });
