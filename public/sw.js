// Tony's service worker. Its job is to make the app installable; it does not
// cache anything, because tasks must always come fresh from the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
