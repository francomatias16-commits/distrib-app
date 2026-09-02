# Etapa 10 — Dependencias / supply chain (npm)

**Estado:** 🟢 Cerrada — 1 hallazgo de seguridad (bajo riesgo real, ver DEP-01) + 1 hallazgo de higiene de build (DEP-02).

## Contexto vs. la Etapa 1 (Inventario)
En la Etapa 1 (sesión 8) `npm audit` no se pudo correr porque el sandbox no
tenía acceso a `registry.npmjs.org` — la revisión se hizo a mano vía
`web_search` contra CVEs conocidos. **Ahora sí hay acceso** (confirmado con
`npm --version` + `npm audit` reales contra el `package-lock.json` del ZIP
v296), así que esta etapa repite la verificación con la herramienta real en
vez de memoria/búsqueda manual.

## DEP-01 (moderado) — `uuid <11.1.1` transitivo vía `firebase-admin`

`npm audit` reporta 8 avisos, **todos** con la misma causa raíz: `uuid`
`<11.1.1` (GHSA-w5hq-g745-h8pq, CVSS 7.5 — falta de chequeo de límites de
buffer en `uuid.v3()`/`v5()`/`v6()` cuando se provee un `buf` propio). Ese
`uuid` viejo llega como dependencia transitiva de `firebase-admin@12.7.0` a
través de `@google-cloud/firestore`, `@google-cloud/storage`, `google-gax`,
`gaxios`, `teeny-request` y `retry-request`.

**Exploitabilidad real (verificada en código, no solo en el reporte de `npm audit`):**
`firebase-admin` en este proyecto se usa **solo** para *Cloud Messaging*
(`lib/handlers/_push.js` → `admin.initializeApp()` + `admin.messaging()`), no
para Firestore ni Storage. Los paquetes vulnerables (`google-gax`, `gaxios`,
etc.) son parte del SDK de Google Cloud que `firebase-admin` trae completo
igual, aunque no se use esa parte — no hay ningún código de este proyecto que
llame `uuid.v3/v5/v6` con un buffer propio, ni ningún endpoint que exponga esa
ruta a un atacante. Severidad real: baja pese al CVSS 7.5 del aviso, porque el
código vulnerable no es alcanzable desde ninguna entrada de este proyecto.

**Fix disponible:** requiere `firebase-admin@14.1.0` (salto de major, hay un
escalón intermedio en 13.x — `13.9.0`). No se aplicó en esta sesión porque:
- Es un breaking change potencial (major bump), no accionable con un simple
  `npm audit fix --force` sin probar.
- La única superficie usada (`admin.messaging()`) probablemente no cambió su
  API entre majors, pero hay que confirmarlo probando el envío de push real
  antes de deployar.

**Recomendación:** programar el bump de `firebase-admin` 12→14 en una rama
separada, correr un envío de push de prueba real (`enviarPush`) contra un
dispositivo de test, y recién ahí mergear. No es urgente dado que no es
explotable hoy, pero conviene no dejarlo indefinidamente porque cierra el
único aviso moderado abierto del proyecto.

## DEP-02 (higiene de build, no seguridad) — `esbuild` falta en `package-lock.json`

`package.json` declara `esbuild": "^0.23.0"` como devDependency (usado en el
script `build`), pero **no existe ninguna entrada de `esbuild` en
`package-lock.json`** — confirmado con `grep` y con `npm ci --dry-run`, que
falla explícitamente:

```
npm error Missing: @esbuild/linux-x64@0.23.1 from lock file
... (10+ binarios de plataforma más)
```

**Impacto real, acotado:** Vercel usa `npm install` como install command por
defecto para proyectos Node (no `npm ci`), así que el build en Vercel hoy
**no se rompe** — `npm install` simplemente resuelve `esbuild` de nuevo sin
fallar. El riesgo real es de **reproducibilidad**, no de outage: sin la
entrada en el lockfile, la versión exacta de `esbuild` que se instala en cada
entorno (tu máquina, Vercel, un CI futuro) puede variar dentro del rango
`^0.23.0` en vez de estar fijada — y si alguna vez se agrega un paso de CI
que use `npm ci` (por ejemplo, para que el workflow de backups u otro futuro
corra tests), fallaría igual que en esta verificación.

**Fix:** correr `npm install` localmente (sin `--package-lock-only`, para que
regenere bien las entradas de plataforma de `esbuild`) y commitear el
`package-lock.json` actualizado. No se aplicó en esta sesión porque no hay
acceso de escritura al repo real desde acá (solo al ZIP) — queda como
pendiente de 1 comando para la próxima sesión de código.

## Verificaciones adicionales (sin hallazgos)
- **Vulnerabilidades por severidad:** 0 críticas, 0 altas, 8 moderadas (todas
  DEP-01), 0 bajas.
- **Paquetes desactualizados sin aviso de seguridad** (solo staleness, no
  riesgo): `bcryptjs` 2.4.3→3.0.3 y `pdfkit` 0.15.2→0.19.1 tienen majors más
  nuevos sin CVE pendiente — no urgente.
- **Integridad de origen:** las 331 entradas de `package-lock.json` resuelven
  contra `registry.npmjs.org` — 0 con URLs de git/tarball directo o registries
  no oficiales (vector típico de typosquatting/dependency confusion).
- **`node-forge`/`jsonwebtoken`** (los 2 que la Etapa 1 había marcado como "a
  confirmar parcheados" sin poder correr `npm audit` real): confirmado ahora
  con la herramienta real — **sin avisos abiertos** en ninguna de las 2.

## Verificación de cierre
- `npm audit --json` corrido contra el `package-lock.json` real del ZIP v296.
- `npm outdated --json` para separar staleness de vulnerabilidad real.
- `npm ci --dry-run` para confirmar el hallazgo DEP-02 de forma reproducible.
- Código fuente (`lib/handlers/_push.js`) revisado para evaluar
  exploitabilidad real de DEP-01, no solo el reporte automático.
- Búsqueda web para confirmar el comportamiento actual (julio 2026) del
  install command por defecto de Vercel, que acota el impacto de DEP-02.
