# v447 — Fase 6 (plan de acción): bump `firebase-admin` 12 → 14

**Contexto:** DEP-01 de la auditoría 2026 (`AUDITORIA_2026/00_PLAN_MAESTRO.md`) —
aviso moderado de `npm audit` (`uuid <11.1.1`, transitivo vía `firebase-admin@12`,
GHSA-w5hq-g745-h8pq). No explotable en este proyecto (solo se usa Cloud
Messaging, nunca `uuid.v3/v5/v6` con buffer propio), pero quedaba documentado
como pendiente de bump, con la advertencia de que había que "probar
`admin.messaging()` en rama aparte antes de mergear".

## Hallazgo real durante la migración (no estaba documentado antes)

El único archivo que usa `firebase-admin` en todo el proyecto es
`lib/handlers/_push.js` (confirmado con grep sobre todo `lib/`+`api/`, único
caller). Usaba el import de namespace clásico:

```js
import admin from 'firebase-admin';
// ...
admin.initializeApp({ credential: admin.credential.cert(...) });
admin.messaging().send({...});
```

**Este patrón deja de funcionar a partir de `firebase-admin` v13+.** Se
confirmó con un test real contra v14.2.0 instalada en sandbox: con
`import admin from 'firebase-admin'`, tanto `admin.credential` como
`admin.messaging` son `undefined` — el paquete raíz ya no expone la API de
namespace, solo los métodos de `firebase-admin/app` (`initializeApp`, `cert`,
`getApps`, etc.). No es un cambio menor de compatibilidad: sin este fix, el
bump rompía el 100% de las notificaciones push (`enviarPush` y todo lo que
depende de ella: ofertas relámpago, deuda vencida, pedido entregado, pedido en
camino, puntos ganados) con un `TypeError` en el primer intento de envío.

Ninguna otra API de `firebase-admin` (`sendToDevice`, `sendMulticast`, Auth,
Firestore, Storage) se usa en el proyecto, así que el resto del changelog de
v13/v14 (remoción de FCM APIs deprecadas, mínimo de Node 18) no afecta —
el proyecto ya corre en Node 20.x (`package.json` → `engines.node`).

## Qué se cambió

**`package.json`:**
```diff
-    "firebase-admin": "^12.0.0",
+    "firebase-admin": "^14.2.0",
```

**`lib/handlers/_push.js`:**
- Import de namespace → imports nombrados desde los subpaths modulares:
  ```js
  import { initializeApp, cert, getApps } from 'firebase-admin/app';
  import { getMessaging } from 'firebase-admin/messaging';
  ```
- `asegurarFirebase()` ahora devuelve la instancia de la app (antes solo
  marcaba un flag booleano) y usa `getApps()[0] || initializeApp(...)` como
  resguardo defensivo equivalente al que ya existía.
- `enviarPush()` guarda la instancia devuelta y llama
  `getMessaging(firebaseApp).send({...})` en vez de `admin.messaging().send(...)`.
- Mismo comportamiento de error observado desde afuera: si falta o es
  inválida `FIREBASE_SERVICE_ACCOUNT_KEY`, sigue lanzando el mismo mensaje de
  error (`[_push] FIREBASE_SERVICE_ACCOUNT_KEY faltante o inválido: ...`), sin
  romper el arranque del resto de la lambda (mismo patrón lazy que ya existía,
  documentado en el comentario del incidente 2026-07-14).

## Cómo se probó (sin acceso al repo real, solo sandbox)

1. `npm install firebase-admin@14` en un sandbox aislado → confirmó la
   versión resuelta (14.2.0) y reprodujo el `TypeError` con el import viejo.
2. Se armó una clave de service account de prueba con un par RSA real
   (`crypto.generateKeyPairSync`) — no una credencial real, pero con formato
   válido para que `cert()` la parseara de verdad.
3. Se ejecutó el módulo `_push.js` ya parcheado, con `supabase-lazy.js` y
   `rate-limit.js` mockeados, en dos escenarios:
   - Usuario sin dispositivos registrados → `asegurarFirebase()` corrió
     `initializeApp`/`cert` reales sin error, `enviarPush` devolvió
     `{ enviadas: 0, razon: 'sin_dispositivos' }` como siempre.
   - Usuario con un dispositivo (token inválido, no podía ser real) →
     `getMessaging(app).send()` llegó hasta intentar el fetch real del token
     OAuth2 contra `oauth2.googleapis.com` (bloqueado solo por el allowlist de
     red del sandbox, no por un error de API) — confirma que toda la cadena
     `initializeApp → cert → getMessaging → send` es correcta de punta a
     punta; en Vercel, sin esa restricción de red, el envío real funcionaría
     igual que antes.
4. `node --check lib/handlers/_push.js` → sintaxis OK.

**Lo que falta para tener 100% de certeza (no accionable desde este
sandbox):** un envío real contra un token FCM válido de un dispositivo de
prueba, y correr `npm run test:integration` contra una rama/preview real de
Vercel con la env var `FIREBASE_SERVICE_ACCOUNT_KEY` cargada. Recomendado
antes de mergear a `main`.

## Verificación pendiente de tu parte
- [ ] `npm install` en el repo real y confirmar que no rompe el lockfile
      (aprovechar para cerrar también DEP-02 — `esbuild` sin entrada en
      `package-lock.json` — en el mismo commit, ya que ambos requieren tocar
      el lockfile).
- [ ] Deploy a un preview de Vercel y forzar un push real (ej. agregar un
      producto con stock bajo, o desde el botón de prueba si existe en el
      panel) para confirmar un envío real end-to-end.
