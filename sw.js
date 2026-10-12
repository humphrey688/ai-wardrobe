/* AI 衣柜 Service Worker
 * 策略：/libs/ 下的模型与运行时文件（约 28MB，内容不变）→ 缓存优先，下载一次永久生效
 *       页面资源（html/js/css）→ 不拦截走网络，保证更新即时生效
 */
const MODEL_CACHE = 'ai-wardrobe-models-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== MODEL_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 只缓存同源 /libs/ 的大文件（模型、wasm、运行时）
  if (url.origin === self.location.origin && url.pathname.includes('/libs/')) {
    e.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const hit = await cache.match(e.request, { ignoreVary: true });
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) {
          try { await cache.put(e.request, res.clone()); } catch (err) { /* 缓存写入失败不影响返回 */ }
        }
        return res;
      })
    );
  }
  // 其他请求不拦截：页面与逻辑更新即时生效
});
