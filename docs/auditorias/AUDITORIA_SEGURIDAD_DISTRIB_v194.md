# AUDITORÍA DE SEGURIDAD Y CALIDAD — Distrib Admin ERP
**Alcance:** Frontend (`frontend/admin/`) + API Dispatcher (`api/index.js`) | Vanilla JS · Express · Supabase  
**Fecha:** 01/07/2026 | **Versión auditada:** v194  

> **Nota (v984, reverificado contra código real):** de los 15 hallazgos de este
> documento, **5 están resueltos** (BUG-01, BUG-03, SEC-01, SEC-04 — este
> último no por el fix recomendado sino porque la funcionalidad que lo
> causaba se dio de baja — y ninguno más), **6 siguen abiertos sin cambios**
> (BUG-02/DEUDA-02, SEC-05, SEC-06, DEUDA-01, DEUDA-04, DEUDA-05), y **4 están
> parciales** (BUG-04, SEC-02, SEC-03, DEUDA-03). Detalle de cada uno abajo,
> agregado inline en cada sección. No se tocó código en esta pasada, solo
> verificación — quedan como acciones pendientes reales, no como historial.

---

## FASE 1 — Bugs Críticos y Bloqueantes

---

### BUG-01 ⛔ — `sanitize` referenciada como global sin garantía de existencia

- **Ubicación:** `compras.js` L121 / `devoluciones.js` L234 / `notas-credito.js` L112
- **Problema:** Las tres funciones usan `typeof sanitize === 'function' ? sanitize(e) : e` como fallback de escape. La función `sanitize` **no se define en ninguno de esos archivos** ni existe un import. Si el script que la define no carga antes (orden de `<script>` incorrecto, falla de red, caché rota), el fallback retorna `e` sin ningún saneamiento — el dato crudo llega al DOM.
- **Impacto:** Silent failure: el sistema sigue funcionando pero sin escape. Una razón social con `<img src=x onerror=alert(1)>` se inyecta en la tabla sin filtrar.
- **Solución:**

> ✅ **RESUELTO (v984).** `window.sanitize` ahora existe como global en
> `ui-utils.js` (con un comentario propio que confirma que fue un fix real
> de XSS explotable con solo pasar el mouse por encima), y se carga antes
> que `compras.js`/`devoluciones.js` en ambos HTML. El guard `typeof
> sanitize === 'function'` sigue en el código (ver DEUDA-05) pero ya no es
> un riesgo real porque la función siempre está presente.

```js
// utils/escape.js — un único archivo compartido, cargado primero en todos los HTML
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
// Exportar como módulo o exponer como window.escHtml antes de cualquier módulo que lo use.
// Eliminar todos los typeof sanitize === 'function' checks del código.
```

---

### BUG-02 ⛔ — `api-client.js` no adoptado: 7+ instancias de `fetchJson` inline inconsistentes

- **Ubicación:** `api-client.js` L1–3 (comentario propio del archivo) / `cheques.js` L242–272 / `cta-cte.js` L31–176 / `notas.js` L32–45 y más
- **Problema:** El archivo `api-client.js` incluye la advertencia `"solo se carga en dashboard.html"`. El resto de módulos implementa su propio `fetchJson` inline o llama directamente a la API REST de Supabase. Consecuencias:
  - Comportamiento 401/403 → redirección al login **solo ocurre en dashboard**. En las demás páginas, un token expirado lanza una excepción sin manejar que congela la UI.
  - `cheques.js` llama directamente a `${SUPABASE_URL}/rest/v1/cheques` con el `SUPABASE_ANON_KEY` en el header `apikey` — bypaseando completamente la API propia y su middleware de autorización.
- **Impacto:** Comportamiento de sesión expirada inconsistente. Posible bypass de validaciones de negocio que están en los handlers si alguien llama directo al REST endpoint.
- **Solución:** Cargar `api-client.js` en todos los HTML admin. Reemplazar los fetches directos a `${SUPABASE_URL}/rest/v1/...` con llamadas a la API propia (`/api/cheques?accion=...`). Los handlers deben hacer la validación en servidor.

> ❌ **SIGUE ABIERTO (v984).** `api-client.js` sigue con el mismo comentario
> `"solo se carga en dashboard.html"` y solo lo cargan 2 de 57 HTML admin.
> `cheques.js` sigue pegándole directo a `${SUPABASE_URL}/rest/v1/cheques`
> con el `SUPABASE_ANON_KEY`, igual que `cta-cte.js` y `notas.js` (bajó de
> "7+ instancias" a estas 3, pero el patrón de fondo no se resolvió).

---

### BUG-03 🔴 — Dispatcher expone `err?.message` en respuestas 500 en producción

- **Ubicación:** `api/index.js` L58
- **Problema:**
```js
res.status(500).json({ error: 'Error interno del servidor', detalle: err?.message });
```
En producción, `err?.message` puede incluir: nombres de tablas internas de Supabase, queries SQL fallidas, nombres de columnas, stack traces parciales, o mensajes de validación de PostgreSQL.
- **Impacto:** Information disclosure. Un atacante que provoque un error controlado obtiene el esquema interno de la base de datos.
- **Solución:**
```js
// En producción: nunca exponer detalle al cliente
const isProd = process.env.NODE_ENV === 'production';
// Generar ID de correlación para trazabilidad interna
const errId = crypto.randomUUID();
console.error(`[DISPATCHER][${errId}] Error en módulo "${mod}":`, err);
res.status(500).json({
  error: 'Error interno del servidor',
  ...(isProd ? { ref: errId } : { detalle: err?.message, ref: errId }),
});
```

> ✅ **RESUELTO (v984), y mejor que lo recomendado.** `api/index.js` ya no
> manda `err?.message` al cliente en ningún ambiente — reemplazado por un
> `correlation_id` (UUID) que se loguea en el server junto al stack
> completo y se manda a Sentry si está configurado. El código tiene un
> comentario explícito citando esta auditoría (`// BUG-03 (auditoría v194,
> P0)`).

---

### BUG-04 🟡 — Race condition en `window.authReady` sin espera en módulos inline

- **Ubicación:** Múltiples HTML (`clientes.html`, `cheques.html`, etc.) con scripts inline que acceden a `window.authCtx` directamente sin esperar `window.authReady`
- **Problema:** `api-client.js` tiene la espera correcta (`await window.authReady`). Los módulos que no lo usan y acceden a `window.authCtx?.session?.access_token` directamente obtendrán `undefined` si el DOM ejecuta el módulo antes de que `auth.js` termine sus round-trips a Supabase.
- **Impacto:** Llamadas a API con token vacío (`Authorization: Bearer `), que el backend recibirá como no autenticadas. Puede causar respuestas 401 silenciosas o datos no cargados sin mensaje de error visible para el usuario.
- **Solución:** Todos los módulos que necesiten el token deben empezar con:
```js
const authCtx = await window.authReady; // espera la promesa de auth.js
const token = authCtx?.session?.access_token || '';
```

> 🟡 **PARCIAL (v984).** La mayoría del código (58 archivos) ya espera
> `window.authReady` correctamente. Pero 12 archivos siguen tocando
> `window.authCtx` sin esperarlo: `nav.js`, `nav-mobile.js`, `remito.js`,
> `pos-terminal.js`, `pos-offline.js`, `stock-offline.js`,
> `stock-scanner-remoto.js`, `cobros-offline.js`, `clientes-ciclos.js`,
> `etiquetas-preview.js`, `notas-credito.js`,
> `productos-scanner-remoto.js`. La mayoría de estos ya tiene guards
> defensivos (`if (!window.authCtx) return`, `?.` encadenado) que evitan el
> síntoma original descrito (token vacío enviado al backend), pero no
> eliminan la causa — en una carga lenta de `auth.js` pueden mostrar "Sin
> sesión" a un usuario que sí está logueado. No se tocó código en esta
> pasada; queda como pendiente real, ya no crítico pero sí de UX.

---

## FASE 2 — Auditoría de Seguridad y Vulnerabilidades

---

### SEC-01 ⛔ — Ausencia total de Content-Security-Policy

- **Ubicación:** Todos los archivos HTML del admin (confirmado: ninguno tiene CSP en meta tag ni header HTTP)
- **Problema:** Sin CSP, cualquier XSS exitoso puede: ejecutar scripts de dominios arbitrarios, exfiltrar tokens via `fetch` a servidores del atacante, inyectar iframes, leer `sessionStorage` y `localStorage`.
- **Impacto:** Amplificador crítico de todos los XSS del sistema. Una vulnerabilidad de severidad media escala a crítica.
- **Solución inmediata — header HTTP en `vercel.json`:**
```json
{
  "headers": [{
    "source": "/admin/(.*)",
    "headers": [{
      "key": "Content-Security-Policy",
      "value": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'"
    }]
  }]
}
```
Nota: ajustar los dominios en `script-src` según los CDNs que realmente usa el proyecto (SheetJS, Supabase JS). Empezar en modo `Content-Security-Policy-Report-Only` para detectar violaciones sin romper la app.

> ✅ **RESUELTO (v984).** `vercel.json` tiene headers `Content-Security-Policy`
> configurados en 3 rutas.

---

### SEC-02 ⛔ — XSS masivo: 247 `innerHTML` con datos dinámicos sin escape consistente

- **Ubicación:** Todos los módulos JS del admin (`dashboard-optimizado.js`, `clientes.js`, `migracion.js`, `cc-proveedores.js`, `anomalias.js`, `auditoria.js`, `busqueda-global.js`, y más)
- **Problema:** El proyecto usa 7 implementaciones distintas de `escHtml` / `escapeHtml` / `sanitize` (definidas localmente en cada archivo), con cobertura inconsistente. Hay dos categorías de riesgo:

  **Categoría A — Datos de API de BD (confianza alta pero no absoluta):** valores que un usuario podría haber ingresado maliciosamente (nombres de clientes, razones sociales, descripciones de productos). Si un dato fue guardado con un payload XSS antes de que el escape se implementara, se renderiza en todos los usuarios que vean ese registro.

  **Categoría B — Datos de archivos externos (confianza cero):** `migracion.js` parsea CSVs/XLS en el cliente e inyecta nombres de columnas y valores de celda en el DOM. Un archivo CSV con encabezados maliciosos es un vector directo de XSS.

  Ejemplo concreto encontrado:
  ```js
  // dashboard-optimizado.js — datos de sesión de migración inyectados sin escape
  cont.innerHTML = data.sesiones.map(s => `
    <tr><td>${s.nombre_archivo}</td>...   // ← NO escapado
  `).join('');
  ```

- **Impacto:** XSS persistido (si viene de BD) o reflejado vía archivo. En un contexto admin, esto equivale a account takeover completo de cualquier sesión que visualice el dato.
- **Solución:** Centralizar `escHtml` como utilidad global (ver BUG-01), y auditar metódicamente cada template literal que genere HTML. Regla de oro: **ningún valor dinámico entra en un template literal de HTML sin pasar por `escHtml()`**. Para renderizado complejo, usar `createElement` + `textContent` (como se hizo en el fix XSS de `migracion.js` v194).

> 🟡 **PARCIAL, necesita auditoría propia (v984).** El conteo crudo de
> `.innerHTML =` subió a 780 (el codebase creció de ~57 a más módulos desde
> julio), así que no es comparable 1:1 contra los "247" originales sin
> revisar caso por caso. Lo que sí se puede confirmar: `escHtml` sigue sin
> centralizarse — ahora son **8** implementaciones locales duplicadas
> (subió de 7), ver DEUDA-01. Este hallazgo necesita su propia pasada
> dedicada (muestreo de los 780 casos) en vez de una verificación rápida —
> lo dejo como candidato para la próxima sesión de auditoría en vez de
> marcarlo con un veredicto que no puedo respaldar con evidencia completa.

---

### SEC-03 🔴 — Llamadas directas a Supabase REST API: dependencia total en RLS sin validación de negocio

- **Ubicación:** `cheques.js` L242–272 / `cta-cte.js` L31–176 / `notas.js` L32–45
- **Problema:** Estos módulos hacen `fetch` directo a `${SUPABASE_URL}/rest/v1/<tabla>` con `SUPABASE_ANON_KEY`. No pasan por `api/index.js` ni por ningún handler con validación de negocio. La seguridad depende **exclusivamente** de las Row Level Security policies de Supabase.

  Si hay un error en cualquier RLS policy (tabla sin RLS habilitada, policy con `USING (true)`, policy con condición incorrecta), cualquier usuario autenticado puede leer o escribir datos de otras empresas.

  Adicionalmente, el filtro `empresa_id=eq.${window.authCtx?.perfil?.empresa_id}` se envía como query param construido desde el cliente. Si RLS no verifica `empresa_id` contra el JWT sino contra el query param, hay **IDOR** (Insecure Direct Object Reference): el atacante puede cambiar el valor en el request y acceder a datos de otro tenant.

- **Impacto:** En un SaaS multitenant, si RLS falla en cualquiera de estas tablas (cheques, cta_cte, facturas, notas), un tenant puede leer y/o modificar datos de otro.
- **Solución:**
  1. Mover estas operaciones a handlers en `api/index.js`. El backend extrae `empresa_id` del JWT verificado (nunca del body/query del cliente).
  2. La RLS es una segunda capa de defensa, no la primera.
  3. Auditar inmediatamente que las tablas `cheques`, `cta_cte`, `facturas`, `notas` tienen RLS habilitada y que las policies usan `auth.jwt() ->> 'empresa_id'` o similar, no el query param.

> 🟡 **PARCIAL, pero el escenario más grave descartado (v984, verificado en
> vivo contra la base).** El patrón de fondo sigue igual: `cheques.js`,
> `cta-cte.js` y `notas.js` (mismos 3, nombres iguales a julio) siguen
> pegándole directo a `${SUPABASE_URL}/rest/v1/...` sin pasar por
> `api/index.js`. **Pero el IDOR específico que describe el hallazgo no
> existe:** consulté `pg_policies` en vivo — `cheques` y `cta_cte` tienen
> RLS habilitada, y las funciones `get_empresa_id()`/`auth_empresa_id()`
> que usan las policies resuelven el `empresa_id` con `SELECT empresa_id
> FROM usuarios WHERE id = auth.uid()`, **ignorando por completo** cualquier
> `empresa_id` que el cliente mande como query param. Cambiar ese parámetro
> en el request no filtra datos de otro tenant. Sigue siendo válido el
> punto arquitectónico (la validación de negocio vive solo en RLS, no hay
> segunda capa en el backend) pero el riesgo concreto de account/tenant
> takeover que motivaba la severidad 🔴 no está presente.

---

### SEC-04 🔴 — Open Redirect: parámetro `?next=` sin validación en el login

- **Ubicación:** `auth.js` L30
```js
window.location.href = '/admin/login?next=' + encodeURIComponent(window.location.pathname);
```
- **Problema:** `window.location.pathname` siempre es relativo al origen actual, por lo que el vector de construcción del `?next=` desde el cliente no permite saltar a dominios externos. Sin embargo, si en `login.html` el valor de `next` se lee de la URL y se usa directamente en `window.location.href = next` sin validar que sea una ruta relativa del mismo dominio, un atacante puede construir `https://distrib.app/admin/login?next=https://attacker.com` y lograr un open redirect después del login.
- **Impacto:** Phishing de credenciales: el usuario inicia sesión legítimamente y es redirigido a un dominio controlado por el atacante que imita la interfaz para robar la contraseña nuevamente o el token de sesión.
- **Solución en `login.html`:**
```js
const params = new URLSearchParams(window.location.search);
const next = params.get('next') || '/admin/dashboard';
// Validar: solo rutas relativas del mismo origen (empieza con / pero no con //)
const safePath = (next.startsWith('/') && !next.startsWith('//')) ? next : '/admin/dashboard';
window.location.href = safePath;
```

> ✅ **Ya no aplica (v984).** `auth.js` todavía arma `?next=...` al mandar
> a un usuario sin sesión al login, pero busqué en todo `login.html` y el
> resto del repo — **ningún archivo lee `.get('next')`**. El login redirige
> siempre a destinos fijos (`/setup` o según `empresa.setup_completado`),
> nunca al valor de `next`. No hay redirect controlable porque no hay
> redirect real: el open redirect no existe, pero como efecto secundario
> el usuario ya no vuelve a la página que estaba viendo antes de que le
> caducara la sesión — vale la pena decidir si eso se quiere recuperar
> (con la validación que ya proponía este hallazgo) o dejarlo así.

---

### SEC-05 🟡 — `sessionStorage` con perfil completo incluyendo campos SaaS sensibles

- **Ubicación:** `auth.js` L53
- **Problema:** El caché almacena el perfil completo incluyendo `saas_plan`, `saas_precio_mes`, `saas_trial_fin`, `saas_suspendida`. Si hay un XSS exitoso, estos datos son accesibles para el script malicioso. El token JWT de Supabase también vive en `localStorage` (Supabase lo gestiona internamente por diseño).
- **Impacto:** Bajo XSS: exfiltración de todos los datos de sesión + token de acceso válido. Con ese token un atacante puede hacer requests a la API de Supabase directamente.
- **Mitigación parcial existente:** El TTL de 5 minutos limita la ventana de validez del caché. La mitigación real es la CSP (SEC-01) que eliminaría el XSS que hace posible la exfiltración. No se recomienda cambiar el mecanismo de caché — resolver SEC-01 y SEC-02 primero.

> ❌ **SIGUE ABIERTO (v984).** `auth.js` línea 54 sigue guardando `perfil`
> completo en `sessionStorage` sin cambios. SEC-01 (CSP) ya está resuelto,
> así que la mitigación que este hallazgo pedía como prerrequisito ya
> existe — pero el dato sensible en `sessionStorage` en sí no se tocó.

---

### SEC-06 🟡 — Information disclosure: error 404 del dispatcher expone nombres de módulos internos

- **Ubicación:** `api/index.js` L52
```js
res.status(404).json({ error: `Módulo de API desconocido: ${mod ?? '(sin especificar)'}` });
```
- **Problema:** Retorna el nombre exacto del `_mod` solicitado en la respuesta. Un atacante que enumera módulos obtiene confirmación de cuáles existen y cuáles no (respuestas 200 vs 404 diferenciadas por mensaje).
- **Impacto:** Reconocimiento de la superficie de ataque del backend. Facilita ataques dirigidos a módulos específicos.
- **Solución:**
```js
return res.status(404).json({ error: 'Not found' });
```

> ❌ **SIGUE ABIERTO (v984).** `api/index.js` línea 147 sigue devolviendo
> `Módulo de API desconocido: ${mod}` con el nombre exacto solicitado, sin
> cambios respecto a julio.

---

## FASE 3 — Calidad de Código, Deuda Técnica y Clean Code

---

### DEUDA-01 — 7 implementaciones duplicadas de `escHtml` / `escapeHtml`

Definida localmente en: `clientes.js`, `facturacion.js`, `pedidos.js`, `notas-internas.js`, `migracion.js`, `migracion-badge.js`, `anomalias.js` (como `escapeHtml`), y referenciada como `sanitize` en 3 archivos más (`compras.js`, `devoluciones.js`, `notas-credito.js`). Son idénticas o casi idénticas. Violan el principio DRY y convierten una corrección de seguridad en un trabajo de 10 archivos en lugar de 1.

**Refactorización recomendada:**
```
frontend/admin/js/utils/escape.js   ← única fuente de verdad
```
Cargado como primer `<script>` en todos los HTML admin, antes de cualquier otro módulo. Todos los demás archivos eliminan su copia local y usan `window.escHtml`.

> ❌ **SIGUE ABIERTO, empeoró levemente (v984).** Ahora son **8**
> definiciones locales de `escHtml` (`clientes.js`, `facturacion.js`,
> `pedidos.js`, `productos.js`, `puntos.js`, `push-admin.js`,
> `reportes-stock.js`, `stock.js` — la lista cambió de nombres pero no bajó
> de cantidad). Lo que sí cambió para bien: `sanitize` ya no es una
> implementación duplicada más — es la única global real, en
> `ui-utils.js` (ver BUG-01).

---

### DEUDA-02 — `api-client.js` no adoptado: auto-declarado en el propio archivo desde v47

El archivo tiene 57 líneas de código y una nota que dice explícitamente: `"solo se carga en dashboard.html; para adopción completa: cargar este script en todos los HTML del admin"`. Es deuda técnica documentada que lleva múltiples versiones sin resolverse. Impacta directamente la consistencia del manejo de errores, autenticación y redirección en toda la aplicación.

**Acción concreta:** Agregar `<script src="/frontend/admin/js/api-client.js">` en todos los HTML del admin. Luego migrar los `fetchJson` inline de cada módulo para que usen `window.api.get/post/patch/delete`.

> ❌ **SIGUE ABIERTO, textual (v984).** Mismo comentario literal en
> `api-client.js` línea 1, mismos 2/57 HTML lo cargan. Ver BUG-02 para el
> detalle — es el mismo hallazgo.

---

### DEUDA-03 — Comentarios de versión de migración embebidos en lógica de negocio

`migracion.js` tiene 60+ comentarios del tipo `// Migración 154`, `// Migración 159`, `// Punto 5 del plan (P1)`, `// Gap crítico 3` entremezclados con el código de producción. Estos son changelogs históricos, no documentación técnica del código. Hacen el archivo difícil de leer, aumentan su tamaño y no agregan valor semántico para quien mantiene el sistema.

**Recomendación:** Mover a los archivos `CHANGELOG_*.md` (el patrón ya existe en el proyecto). El código fuente debe documentar el *qué hace* y el *por qué*, no la historia de versiones. Los comentarios de versión pertenecen al historial de git y a los changelogs.

> 🟡 **PARCIAL (v984).** Bajó de 60+ a 33 comentarios de este tipo — hubo
> limpieza real, pero el patrón no se eliminó y el archivo casi se duplicó
> en tamaño mientras tanto (ver DEUDA-04), así que en términos relativos
> la mezcla sigue igual de presente.

---

### DEUDA-04 — Complejidad ciclomática alta en `migracion.js`

El archivo tiene ~1.700 líneas con funciones que superan las 80 líneas y múltiples niveles de anidamiento:
- `confirmarMigracion`: maneja validación, fetch, estado UI y renderizado en un solo bloque
- `renderColumnasSinMapear`: creación de DOM + lógica condicional mezcladas
- `mostrarResultado`: orquesta 5+ renderizaciones con lógica inline

La función `_cargarMuestrasExtras` (agregada en v194) es correcta en concepto pero se declaró como función asíncrona global en lugar de ser una closure o export del módulo. Si se carga en otra página, ensucia el namespace global.

**Recomendación:** Dividir en módulos más pequeños: `migracion-core.js` (lógica de negocio), `migracion-ui.js` (renderizado), `migracion-api.js` (llamadas HTTP). Esto también facilita el testing unitario.

> ❌ **SIGUE ABIERTO, empeoró (v984).** `migracion.js` creció de ~1.700 a
> **2.631 líneas** — el sistema de migración asistida siguió creciendo
> (15+ tipos de entidad, según el historial del proyecto) sin la
> separación en módulos que recomendaba este hallazgo. `_cargarMuestrasExtras`
> sigue declarada como función global, sin cambios.

---

### DEUDA-05 — Guard pattern frágil `typeof X === 'function'`


En `compras.js`, `devoluciones.js` y `notas-credito.js`, el código usa `typeof sanitize === 'function'` como guardia. Este patrón indica que en algún momento `sanitize` estuvo disponible como global pero dejó de garantizarse su presencia. En lugar de hacer el código resiliente a la ausencia de la función, la solución correcta es garantizar que la dependencia siempre esté disponible.

**Regla de diseño:** Si una función es necesaria para la seguridad (como el escape de HTML), no puede ser opcional. Un guard que falla silenciosamente ante la ausencia de una función de seguridad es peor que una excepción explícita.

> 🟡 **El caso puntual se resolvió, el patrón se expandió (v984).** El
> guard específico que motivó este hallazgo (`typeof sanitize ===
> 'function'`) ya no es un riesgo real porque `sanitize` ahora siempre
> existe (ver BUG-01) — pero el patrón en sí de usar `typeof X ===
> 'function'` como guard defensivo se expandió a **42 instancias** en todo
> el código (no se erradicó como regla de diseño, solo se resolvió el
> caso de seguridad puntual). No las revisé una por una — la mayoría son
> probablemente guards legítimos para funciones opcionales, no de
> seguridad, pero valdría la pena una pasada dedicada para descartarlo.

---

## FASE 4 — Diagnóstico Final y Checklist de Aprobación

### Tabla Resumen de Estado

| # | Área | Estado | Severidad |
|---|------|--------|-----------|
| SEC-01 | Content-Security-Policy | ❌ Ausente | **Crítico** |
| SEC-02 | Escape de HTML en innerHTML (247 casos) | ⚠️ Inconsistente | **Alto** |
| SEC-03 | Llamadas directas a Supabase REST (bypass de API) | ⚠️ Presentes en 3 módulos | **Alto** |
| BUG-01 | `sanitize` global sin garantía de existencia | ❌ Guard frágil en 3 archivos | **Alto** |
| SEC-04 | Open Redirect vía `?next=` sin validación | ⚠️ No confirmado mitigado en login.html | **Medio** |
| BUG-03 | Error detail (`err?.message`) expuesto en 500 | ❌ En producción | **Medio** |
| BUG-04 | Race condition `window.authReady` en módulos inline | ⚠️ Parcial | **Medio** |
| SEC-05 | sessionStorage con datos SaaS sensibles | ⚠️ Riesgo bajo XSS | **Medio** |
| SEC-06 | Nombres de módulos internos expuestos en 404 | ⚠️ Information disclosure | **Bajo** |
| BUG-02 | `api-client.js` no adoptado — fetchJson duplicado | ❌ Deuda auto-declarada desde v47 | **Alto** |
| DEUDA-01 | 7 implementaciones duplicadas de `escHtml` | ❌ Viola DRY | **Alto** |
| DEUDA-02 | `api-client.js` sin adopción global | ❌ Deuda declarada | **Alto** |
| DEUDA-03 | Comentarios de versión en código fuente | ⚠️ Ruido | **Bajo** |
| DEUDA-04 | Complejidad ciclomática alta en `migracion.js` | ⚠️ Mantenibilidad | **Medio** |
| DEUDA-05 | Guard `typeof sanitize === 'function'` frágil | ❌ Silencioso en fallo | **Alto** |
| — | `eval()` / `dangerouslySetInnerHTML` | ✅ Ausente | — |
| — | Secrets hardcodeados | ✅ Manejados vía `window.ENV` | — |
| — | Autenticación Supabase base | ✅ JWT Bearer correcto | — |
| — | Caché de sesión (sessionStorage) | ✅ TTL corto, no token JWT | — |
| — | XSS en botón "Exportar sin mapear" | ✅ Corregido en v194 (createElement) | — |

---

### Veredicto Final

## ⛔ NO LISTO PARA PRODUCCIÓN en estado actual

El sistema tiene bases de autenticación correctas (Supabase JWT, sin secrets hardcodeados, sin eval), pero presenta **dos brechas estructurales** que deben resolverse antes de cualquier deploy productivo.

---

### Lista de acciones críticas ordenadas por prioridad

---

#### P0 — Bloquean el deploy. Resolver primero, sin excepciones.

**[P0-1]** Implementar Content-Security-Policy en `vercel.json` (ver SEC-01).  
Sin esto, cualquier XSS tiene radio de daño ilimitado (exfiltración de token, account takeover).

**[P0-2]** Crear `frontend/admin/js/utils/escape.js` con la función `escHtml` única y centralizada.  
Cargarla como primer `<script>` en todos los HTML admin.  
Reemplazar todas las copias locales de `escHtml` / `escapeHtml` en cada archivo JS.  
Eliminar todos los guards `typeof sanitize === 'function'` y reemplazarlos por `escHtml()`.  
Auditar los 247 `innerHTML` con datos dinámicos — priorizar: datos de archivos CSV/XLS, nombres de clientes/proveedores/productos. (ver SEC-02 y DEUDA-01)

**[P0-3]** Validar el parámetro `?next=` en `login.html` para que solo acepte rutas relativas del mismo dominio. (ver SEC-04)

**[P0-4]** Quitar `detalle: err?.message` de las respuestas 500 en producción en `api/index.js`. Reemplazar por un ID de correlación para trazabilidad interna. (ver BUG-03)

---

#### P1 — Resolver en el sprint siguiente al deploy inicial.

**[P1-1]** Cargar `api-client.js` en todos los HTML admin.  
Reemplazar los fetches directos a `${SUPABASE_URL}/rest/v1/` en `cheques.js`, `cta-cte.js` y `notas.js` con llamadas a los handlers propios de la API. (ver BUG-02 y SEC-03)

**[P1-2]** Auditar las RLS policies de Supabase para las tablas accedidas directamente (cheques, cta_cte, facturas, notas).  
Confirmar que el filtro de `empresa_id` lo impone RLS via el JWT (`auth.jwt() ->> 'empresa_id'`), no el query param enviado por el cliente. (ver SEC-03)

**[P1-3]** Asegurar que todos los módulos que hacen fetch esperen `window.authReady` antes de leer `window.authCtx`. Eliminar la race condition. (ver BUG-04)

**[P1-4]** Cambiar el mensaje del 404 del dispatcher a `{ error: 'Not found' }` (ver SEC-06).

---

#### P2 — Deuda técnica. Resolver antes del siguiente release de features.

**[P2-1]** Adopción completa de `api-client.js`: migrar todos los `fetchJson` inline de cada módulo para que usen `window.api.get / post / patch / delete`. (ver DEUDA-02)

**[P2-2]** Limpiar comentarios de versión (`// Migración 154`, `// Punto 5 del plan`, etc.) del código fuente de `migracion.js`. Moverlos a los archivos CHANGELOG correspondientes. (ver DEUDA-03)

**[P2-3]** Dividir `migracion.js` (~1.700 líneas) en módulos: lógica de negocio, renderizado, y llamadas HTTP. Reducir la complejidad ciclomática de las funciones principales. (ver DEUDA-04)

---

*Fin del informe de auditoría — v194 | 01/07/2026*
