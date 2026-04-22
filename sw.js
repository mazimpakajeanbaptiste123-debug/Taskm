// ─────────────────────────────────────────────────────────────────
// OLUXY Task Manager — Service Worker  v1.0.0
//
// HOW TO RELEASE A NEW VERSION:
//   1. Bump APP_VERSION below  (e.g. "1.0.1" → "1.0.2")
//   2. Deploy both sw.js AND index.html
//
// BACKGROUND NOTIFICATIONS (works when app is closed):
//   The SW stores the logged-in user + Firebase config in IndexedDB.
//   When the OS wakes the SW via periodicsync / push / sync, it
//   fetches Firestore directly (no page needed), checks pending
//   notifications, shows them, and clears the queued items.
// ─────────────────────────────────────────────────────────────────
const APP_VERSION = '1.0.0';
const CACHE_NAME  = `oluxy-${APP_VERSION}`;
const IDB_NAME    = 'oluxy_v6';
const IDB_STORE   = 'kv';

const CORE_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ── INSTALL ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Installing v${APP_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_FILES))
      .then(() => console.log(`[SW] Installed v${APP_VERSION}`))
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW] Activating v${APP_VERSION}`);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log(`[SW] Removing old cache: ${k}`);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ includeUncontrolled: true, type: 'window' }))
      .then(clients => clients.forEach(c =>
        c.postMessage({ type: 'SW_ACTIVATED', version: APP_VERSION })
      ))
  );
});

// ── FETCH ─────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isHTML = url.pathname === '/' || url.pathname.endsWith('.html');
  if (isHTML) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        });
      })
    );
  }
});

// ═══════════════════════════════════════════════════════════════════
// INDEXEDDB HELPERS  (SW can read the same IDB the page writes to)
// ═══════════════════════════════════════════════════════════════════
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = reject;
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = reject;
  });
}

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND NOTIFICATION CHECK
// Called from: periodicsync, push (no data), message CHECK_NOTIFS
// Works even when all app tabs are closed.
// ═══════════════════════════════════════════════════════════════════
async function checkAndFirePendingNotifs() {
  try {
    const db = await idbOpen();

    // Read local state and Firebase config
    const [state, fbcfg] = await Promise.all([
      idbGet(db, 'state'),
      idbGet(db, 'fbcfg')
    ]);

    // Need at least the state to know who is logged in
    if (!state) return;

    // ── Which users should we check? ──────────────────────────────
    // We check ALL users who have granted permission, because any of
    // them might have pending notifications (e.g. owner offline while
    // a worker completed tasks, or workers offline while owner sent tasks).
    const usersToCheck = [];
    const perms = state.notifPerms || {};
    for (const [user, perm] of Object.entries(perms)) {
      if (perm === 'granted') usersToCheck.push(user);
    }
    if (usersToCheck.length === 0) return;

    // ── Try to fetch fresh state from Firestore ────────────────────
    // This ensures we get events that happened on other devices while
    // this device was offline / app was closed.
    let freshState = state;
    if (fbcfg) {
      try {
        freshState = await fetchFirestoreState(fbcfg, state) || state;
        // Persist the fresher state locally
        if (freshState !== state) await idbSet(db, 'state', freshState);
      } catch (e) {
        console.warn('[SW] Firestore fetch failed, using local state:', e.message);
        // Use local state — still useful if there are locally-queued notifs
      }
    }

    let stateChanged = false;

    // ── Deliver for each user that has permission ──────────────────
    for (const user of usersToCheck) {
      if (user !== 'owner') {
        // Worker: check if owner sent tasks
        const pending = freshState.pendingWorkerNotif?.[user];
        if (pending && Date.now() - pending.ts < 24 * 60 * 60 * 1000) {
          await showBgNotification(pending.title, pending.body, 'tasks-assigned');
          delete freshState.pendingWorkerNotif[user];
          stateChanged = true;
        }
      } else {
        // Owner: check if workers completed tasks
        const pendingList = freshState.pendingOwnerNotif || [];
        const fresh = pendingList.filter(n => Date.now() - n.ts < 24 * 60 * 60 * 1000);
        if (fresh.length === 1) {
          await showBgNotification(fresh[0].title, fresh[0].body, 'task-done');
          freshState.pendingOwnerNotif = [];
          stateChanged = true;
        } else if (fresh.length > 1) {
          const brand = freshState.brand?.name || 'Oluxy';
          await showBgNotification(
            `✅ ${brand} — ${fresh.length} tasks completed`,
            fresh.slice(0, 3).map(n => n.body).join('\n'),
            'tasks-done-multi'
          );
          freshState.pendingOwnerNotif = [];
          stateChanged = true;
        }
      }
    }

    // ── Persist cleared state back ─────────────────────────────────
    if (stateChanged) {
      await idbSet(db, 'state', freshState);
      // Push cleared state back to Firestore so other devices don't re-fire
      if (fbcfg) {
        try { await pushStateToFirestore(fbcfg, freshState); } catch (e) { /* best-effort */ }
      }
    }

  } catch (e) {
    console.warn('[SW] checkAndFirePendingNotifs error:', e);
  }
}

// Show a notification from the SW background (works when app is closed)
function showBgNotification(title, body, tag) {
  return self.registration.showNotification(title, {
    body,
    icon:     '/icon-192.png',
    badge:    '/icon-192.png',
    tag,
    renotify: true,
    vibrate:  [200, 100, 200],
    data:     { url: self.location.origin }
  });
}

// ── Minimal Firestore REST fetch (no Firebase SDK needed in SW) ───
// Reads oluxy/state document using the Firestore REST API.
async function fetchFirestoreState(fbcfg, localState) {
  const url = `https://firestore.googleapis.com/v1/projects/${fbcfg.projectId}/databases/(default)/documents/oluxy/state?key=${fbcfg.apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const doc = await res.json();
  if (!doc.fields) return null;

  // Firestore REST returns a typed JSON format — convert it to plain JS
  const plain = firestoreDocToPlain(doc.fields);

  // Only use remote if it's strictly newer (same ver logic as main app)
  const remoteVer = plain.ver ?? 0;
  const localVer  = localState?.ver ?? 0;
  return remoteVer >= localVer ? plain : localState;
}

// Push plain JS object back to Firestore via REST PATCH
async function pushStateToFirestore(fbcfg, state) {
  // Only push the fields we modified (pendingWorkerNotif / pendingOwnerNotif)
  const patch = {
    fields: {
      pendingWorkerNotif: plainToFirestoreValue(state.pendingWorkerNotif || {}),
      pendingOwnerNotif:  plainToFirestoreValue(state.pendingOwnerNotif  || []),
      ver:                { integerValue: String(state.ver || 1) },
      ts:                 { integerValue: String(Date.now()) }
    }
  };
  const fields = Object.keys(patch.fields).map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${fbcfg.projectId}/databases/(default)/documents/oluxy/state?${fields}&key=${fbcfg.apiKey}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5000)
  });
}

// ── Firestore REST type converters ────────────────────────────────
function firestoreDocToPlain(fields) {
  const result = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = firestoreValueToPlain(v);
  }
  return result;
}

function firestoreValueToPlain(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue    !== undefined) return null;
  if (v.arrayValue) {
    return (v.arrayValue.values || []).map(firestoreValueToPlain);
  }
  if (v.mapValue) {
    return firestoreDocToPlain(v.mapValue.fields || {});
  }
  return null;
}

function plainToFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean')  return { booleanValue: v };
  if (typeof v === 'number')   return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string')   return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(plainToFirestoreValue) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = plainToFirestoreValue(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// ═══════════════════════════════════════════════════════════════════
// TRIGGER POINTS — background check is woken up by multiple events
// ═══════════════════════════════════════════════════════════════════

// 1. PERIODIC BACKGROUND SYNC — OS wakes SW every ~15 min (Chrome Android)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'oluxy-notif-check') {
    console.log('[SW] periodicsync fired');
    event.waitUntil(checkAndFirePendingNotifs());
  }
});

// 2. ONE-SHOT BACKGROUND SYNC — fires when device comes back online
self.addEventListener('sync', event => {
  if (event.tag === 'oluxy-notif-check') {
    console.log('[SW] sync fired');
    event.waitUntil(checkAndFirePendingNotifs());
  }
});

// 3. SERVER PUSH — fires instantly when a push is sent from a server.
//    If the push has notification data, show it directly.
//    If the push has no data (just a wake-up ping), run the full check.
self.addEventListener('push', event => {
  if (event.data) {
    try {
      const d = event.data.json();
      event.waitUntil(
        self.registration.showNotification(d.title || 'Oluxy', {
          body:     d.body     || '',
          icon:     d.icon     || '/icon-192.png',
          badge:                  '/icon-192.png',
          tag:      d.tag      || 'oluxy-push',
          renotify: true,
          vibrate:  [200, 100, 200],
          data:     { url: self.location.origin }
        })
      );
      return;
    } catch (_) { /* not JSON — fall through to full check */ }
  }
  // Empty / non-JSON push = wake-up ping → run the full state check
  event.waitUntil(checkAndFirePendingNotifs());
});

// ── MESSAGES FROM PAGE ────────────────────────────────────────────
self.addEventListener('message', event => {
  const data = event.data || {};

  // User tapped "Update Now"
  if (data.type === 'SKIP_WAITING') {
    console.log(`[SW] Activating v${APP_VERSION}`);
    self.skipWaiting();
    return;
  }

  // Page asks "what version are you?"
  if (data.type === 'GET_VERSION') {
    event.source.postMessage({ type: 'SW_VERSION', version: APP_VERSION });
    return;
  }

  // Page sends a notification through the SW so it shows even when the
  // page goes into background immediately after (e.g. user locks phone)
  if (data.type === 'LOCAL_NOTIF') {
    event.waitUntil(
      self.registration.showNotification(data.title, {
        body:     data.body,
        icon:     '/icon-192.png',
        badge:    '/icon-192.png',
        tag:      data.tag || 'oluxy-local',
        renotify: true,
        vibrate:  [200, 100, 200],
        data:     { url: self.location.origin }
      })
    );
    return;
  }

  // Page tells SW to check Firestore for pending notifs right now
  // (called after every saveS() so we re-check as soon as a worker
  // completes a task, even if the target user is on a different device)
  if (data.type === 'CHECK_NOTIFS') {
    event.waitUntil(checkAndFirePendingNotifs());
    return;
  }
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      // Focus an existing tab if there is one
      const existing = cs.find(c => c.url && c.focus);
      if (existing) return existing.focus();
      // Otherwise open a new tab
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
