// Минимальный service worker — нужен, чтобы Android предлагал «Установить приложение».
// Ничего не кэшируем (игра онлайн и должна быть всегда свежей), просто пропускаем запросы.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough: обработчик есть, сеть работает как обычно */ });
