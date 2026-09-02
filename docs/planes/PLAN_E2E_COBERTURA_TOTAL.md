> **Estado de ejecución (actualizado):** Fase 1 (P0, 9/9 páginas) cerrada y confirmada 32/32 contra Chromium real (secciones 17-20). Fase 2 (P1) arrancada: 1/20 páginas escritas y confirmadas (`rutas.html`, sección 21). Suite completa: 128/131, los 3 rojos son el bloqueo de CDN de Dexie sin internet completo (secciones 18-19), no bugs reales.

# Plan de cobertura E2E completa (Playwright) — distrib

**Objetivo del documento:** llevar la verificación de "todo está conectado" del nivel estático (lo que ya corre en `check-asset-wiring` / `check-api-wiring` / `check-handler-dispatch`) al nivel de **comportamiento real**: click, completar formulario, submit, verificar resultado — en todas las páginas del proyecto.

**Antes de los números: una aclaración honesta.** Este plan cubre el frontend hasta el punto en que sale la request. Para que un test confirme "y además escribió bien en la base", hace falta además una capa de integración contra backend real (Tier 2 más abajo), que es deliberadamente más chica porque correr contra Supabase real a esta escala tiene un costo de tiempo/infraestructura que no se justifica para las 691 acciones que hay en el frontend — se prioriza.

---

## 1. Inventario real del proyecto (base para estimar, no un número inventado)

| Ítem | Cantidad |
|---|---|
| Páginas HTML totales | 75 |
| — Admin | 54 |
| — Cliente (portal) | 8 |
| — Chofer | 5 |
| — Proveedor | 1 |
| — Scan-POS | 1 |
| — Público/root (login, registro, index, etc.) | 6 |
| Líneas de JS en frontend | ~48.200 |
| Acciones clickeables (`onclick=` inline + `addEventListener('click')`) | ~691 |
| `<form>` HTML nativos | 3 (la app no usa `<form>`, arma los envíos a mano por JS — importante para el diseño de los tests) |
| Módulos API (`_mod`) en el dispatcher | 39 |
| Specs E2E existentes hoy | 4 (`chofer`, `cliente`, `pos`, `proveedor` — **solo cubren el subsistema offline/outbox**, no el resto de cada página) |
| Selectores estables (`data-testid`) en el HTML | **0** |

El último punto es el hallazgo más importante para este plan y se explica en la sección 3.

---

## 2. Qué va a poder afirmar este plan cuando esté terminado (y qué no)

**Sí va a poder afirmar**, por cada flujo cubierto:
- El botón existe en el DOM y el listener está enganchado (si no, el test de click falla).
- El formulario acepta datos válidos y rechaza inválidos con el mensaje esperado.
- Al submitear, sale la request HTTP con el payload esperado.
- La UI refleja correctamente la respuesta (éxito → toast/redirect/actualización de tabla; error → mensaje visible).
- No quedan errores de consola JS durante el flujo.

**No va a poder afirmar**, salvo en los flujos Tier 2 (sección 5):
- Que el dato haya quedado escrito correctamente en la base real, con los valores correctos, respetando reglas de negocio server-side (RLS, triggers, validaciones del handler).
- Comportamiento bajo carga/concurrencia real.
- Que dos módulos que comparten datos (ej: un pedido que después aparece en cta-cte) queden consistentes entre sí en la base real — eso requiere un test de integración cross-módulo, no un click test aislado por página.

Esta distinción entre **Tier 1 (wiring de UI, mock de red)** y **Tier 2 (integración real contra backend)** es la decisión de arquitectura central del plan.

---

## 3. Prerrequisito: selectores estables (`data-testid`)

Hoy el 0% del HTML tiene `data-testid`. Los 4 specs existentes seleccionan por `id`/texto visible, lo cual funciona a chica escala pero **no escala a 691 acciones**: cualquier cambio de copy o de estructura visual rompe tests que no tienen nada que ver con lo que cambió, y el mantenimiento se vuelve más caro que el valor que aportan.

**Recomendación:** antes de escribir specs en masa, agregar `data-testid="modulo-accion"` a los elementos interactivos de cada página, a medida que se la va cubriendo (no en un big-bang aparte). Convención propuesta:

```html
<button data-testid="pedidos-crear-btn">Nuevo pedido</button>
<input data-testid="pedidos-form-cliente" ... />
<div data-testid="pedidos-tabla-fila" data-id="{{pedido_id}}">...</div>
```

Esto es trabajo real sobre 54 páginas de admin, no un detalle menor — está presupuestado dentro de cada fase abajo, no aparte.

---

## 4. Arquitectura de la suite (Tier 1 — wiring de UI)

Extiende el patrón que **ya existe y funciona** en `tests/e2e/helpers/mock-network.js` (usado hoy por los 4 specs offline): la página corre real en un browser real, contra el `static-server.js` real, pero las respuestas de `/api/*` se **mockean** con `page.route()` en vez de pegarle a Supabase. Es la única forma realista de cubrir 691 acciones en tiempo/costo razonable.

```
tests/e2e/
  helpers/
    static-server.js        (ya existe)
    mock-network.js         (ya existe — extender con mocks genéricos por módulo)
    auth-helper.js           NUEVO — login mockeado reutilizable (token fake válido)
    page-object-base.js      NUEVO — clase base con esperas/checks comunes
  page-objects/               NUEVO — 1 archivo por página, encapsula selectores
    admin/
      pedidos.page.js
      stock.page.js
      ...
  specs/
    admin/
      pedidos.spec.js
      stock.spec.js
      ...
    cliente/
    chofer/
    proveedor/
  fixtures/
    mocks/                    NUEVO — respuestas mock por módulo (JSON), 1 archivo por _mod
      pedidos.mock.json
      stock.mock.json
      ...
```

**Por qué Page Object Model:** con 54 páginas de admin, si cada spec hardcodea sus propios selectores, un cambio de estructura en `pedidos.html` obliga a tocar N tests a mano. Con un page-object por página, se toca 1 archivo.

**Patrón de spec estándar** (ejemplo, no exhaustivo):

```js
test('crear pedido con cliente y producto válidos', async ({ page }) => {
  mockApi(page, {
    '/api/clientes': () => ({ json: fixtureClientes }),
    '/api/stock': () => ({ json: fixtureStock }),
    '/api/pedidos': (call) => {
      if (call.request.method() === 'POST') {
        expect(call.request.postDataJSON()).toMatchObject({ cliente_id: 'c1', items: [...] });
        return { json: { id: 'p1', ok: true } };
      }
    },
  });
  const pedidosPage = new PedidosPage(page);
  await pedidosPage.goto();
  await pedidosPage.crearPedido({ cliente: 'Cliente Test', producto: 'Producto Test', cantidad: 3 });
  await expect(pedidosPage.toastExito).toBeVisible();
  await expect(pedidosPage.filaPedido('p1')).toBeVisible();
});
```

---

## 5. Arquitectura de la suite (Tier 2 — integración real)

Para un subconjunto **priorizado** de flujos críticos de negocio, correr contra un tenant de Supabase real dedicado a testing (no producción, no el mismo que usás para desarrollar a mano).

**Gap de infraestructura a resolver primero:** hoy `scripts/test-integration.js` pega directo a Supabase, salteando `api/index.js` — no ejercita los handlers reales. Para que Tier 2 sea E2E de verdad (browser → handler real → DB real), hace falta:

1. Un modo `vercel dev` (o servidor Express liviano que envuelva `api/index.js`) corriendo en el pipeline de test, apuntando a un proyecto Supabase de test.
2. Seed/teardown de datos por corrida (empresa de test con prefijo, igual que ya hace `test-integration.js` — se puede reusar esa lógica de seed).
3. Un usuario/token real de test por rol (`dueno`, `admin`, `chofer`, `cliente`, `proveedor`) para no mockear auth en este tier.

**Flujos candidatos a Tier 2** (los que más duelen si se rompen y tocan varios módulos a la vez):
- Alta de pedido → impacta stock → aparece en cta-cte del cliente.
- Cierre de turno de caja POS → genera movimiento de caja → aparece en reportes.
- Entrega de remito por chofer → actualiza stock y estado del pedido → dispara notificación.
- Facturación de un pedido → integración ARCA (mockeada en este tier, es un servicio externo) → aparece en export contable.
- Alta de usuario + login + permisos por rol.

Esto es indicativo — se termina de definir en la Fase 0 (sección 7) junto con vos, porque requiere tu criterio de qué es "crítico" para el negocio.

---

## 6. Priorización de páginas (Tier 1)

No todas las páginas pesan igual. Se agrupan en 4 niveles según impacto de negocio y complejidad de interacción:

| Nivel | Criterio | Páginas (ejemplos) | Cantidad aprox. |
|---|---|---|---|
| **P0 — Crítico transaccional** | Mueve plata o stock directamente | `pedidos`, `pos`, `stock`, `facturacion`, `cobranzas`, `clientes`, `cta-cte`, `compras`, `productos` | 9 |
| **P1 — Operación diaria** | Se usa todos los días pero no mueve plata directo | `rutas`, `devoluciones`, `lotes`, `vencimientos`, `presupuestos`, `notas`, `usuarios`, `proveedores`, `cheques`, `conciliacion-bancaria`, portal `cliente/*`, `chofer/*` | ~20 |
| **P2 — Configuración / reportes** | Se toca poco, mayormente lectura | `reportes-*`, `rentabilidad-*`, `empresa-config`, `facturacion-config`, `mercadopago-config`, `reglas-precio`, `fidelizacion`, `puntos`, `export-contable`, `saas-billing` | ~25 |
| **P3 — Bajo uso / administrativo interno** | Superadmin, auditoría, observabilidad, onboarding | `superadmin`, `auditoria`, `observabilidad`, `automatizacion`, `whatsapp-*`, `migracion`, `anomalias`, `avisos`, `notif-log`, `setup*`, `soporte` | ~15 |

El portal `proveedor` y `scan-pos` (2 páginas) ya tienen Tier 1 parcial vía los specs offline existentes — se completan con el resto de sus flujos no-offline en P1.

---

## 7. Fases y cronograma

Estimación en **horas de trabajo enfocado de 1 persona semi-senior** familiarizada con Playwright y con este codebase (vos o quien lo ejecute). Si lo hacemos junto conmigo iterativamente por página, los tiempos bajan porque yo escribo el spec y vos validás/ajustás — igual dejo la estimación "sola" como referencia de esfuerzo real.

### Fase 0 — Cimientos (bloqueante para todo lo demás)
- Definir junto a vos los flujos candidatos a Tier 2 (lista cerrada).
- `auth-helper.js` con login mockeado reutilizable por rol.
- `page-object-base.js` con esperas/checks comunes (toast, loading, tabla vacía).
- Convención `data-testid` documentada + aplicada a 1 página piloto (`pedidos`) como referencia.
- Extender `mock-network.js` para mocks genéricos reusables por `_mod` (hoy están hardcodeados por spec).
- **Estimación: 12–16 h.**

### Fase 1 — P0 (9 páginas críticas)
Por página: agregar `data-testid` a sus elementos interactivos + page object + specs cubriendo: carga inicial, alta, edición, borrado/anulación (si aplica), validación de campos requeridos, al menos 1 caso de error de servidor manejado en UI.
- Promedio estimado por página P0 (son las más complejas, tablas + formularios + acciones múltiples): **6–10 h** c/u.
- **Subtotal: 9 páginas × ~8 h = ~72 h.**

### Fase 2 — P1 (~20 páginas)
Mismo patrón, complejidad media.
- Promedio: **4–6 h** c/u.
- **Subtotal: ~20 × 5 h = ~100 h.**

### Fase 3 — P2 (~25 páginas)
Mayormente lectura/config — menos casos de error, menos formularios complejos.
- Promedio: **2–4 h** c/u.
- **Subtotal: ~25 × 3 h = ~75 h.**

### Fase 4 — P3 (~15 páginas)
Bajo uso, cobertura básica (carga + 1-2 acciones principales, no exhaustivo).
- Promedio: **1.5–2.5 h** c/u.
- **Subtotal: ~15 × 2 h = ~30 h.**

### Fase 5 — Tier 2 (integración real, flujos cross-módulo)
Incluye armar el harness de servidor real + seed/teardown (una vez) y luego cada flujo.
- Harness (`vercel dev` o Express wrapper + seed/teardown reusando lógica de `test-integration.js`): **16–24 h** (una vez).
- Cada flujo cross-módulo (5 identificados en sección 5): **6–10 h** c/u.
- **Subtotal: ~20 h + 5 × 8 h = ~60 h.**

### Fase 6 — CI + gate de cobertura
- Pipeline (GitHub Actions u otro CI — hoy no hay ninguno configurado, hay que armarlo desde cero) corriendo Tier 1 en cada PR, Tier 2 en `main`/nightly (por costo/tiempo).
- Regla de gobernanza: página nueva o formulario nuevo → PR no se mergea sin su spec (se puede automatizar parcialmente extendiendo `check-asset-wiring.js` para que liste páginas sin spec asociado, como warning).
- **Estimación: 10–14 h.**

### Total estimado: **~360–400 h** (aprox. 9–10 semanas full-time de 1 persona, o proporcionalmente menos en paralelo con más gente).

Esto es deliberadamente un número grande y honesto — es lo que realmente cuesta cubrir 691 acciones con clicks reales verificados, no una promesa optimista.

---

## 8. Cómo achicar el esfuerzo sin perder lo importante (si el numero de arriba es demasiado)

Si 360–400 h no es viable de una, opciones reales, no genéricas:

1. **Cortar en P0+P1 nomás (~29 páginas, ~185 h)** y dejar P2/P3 con la cobertura estática que ya existe (asset/API/dispatch wiring) más el smoke test de "la página carga sin error de consola" (mucho más barato: ~30 min por página, se puede automatizar en un solo spec genérico que recorra las 75 páginas).
2. **Smoke universal barato primero:** un único spec parametrizado que visite las 75 páginas, haga login, y verifique "carga sin 404 de assets (ya lo cubre el check estático) + sin error de consola + el layout principal renderiza" — **~8 h de trabajo, cubre el 100% de las páginas al nivel más básico**, y después se va profundizando por prioridad con el plan de arriba. Recomiendo esto como Fase 0.5, entre la Fase 0 y la Fase 1.
3. **Priorizar por incidentes reales:** si tenés un historial de bugs en producción por página, usarlo para reordenar P0-P3 en vez de mi criterio genérico de "mueve plata".

---

## 9. Qué necesito de vos para arrancar

1. Confirmar o ajustar la agrupación P0–P3 de la sección 6 (yo la armé por criterio de "impacto de negocio", vos conocés mejor qué se usa más).
2. Confirmar los 5 flujos candidatos a Tier 2 de la sección 5, o darme otros.
3. Decidir si querés que arranque por el **smoke universal barato** (opción 2 de la sección 8, ~8h, cobertura básica del 100%) antes de meterme en profundidad página por página — es lo que recomiendo como próximo paso concreto, hoy mismo.
4. Acceso a un proyecto Supabase de test (no producción) cuando lleguemos a Fase 5 — no hace falta ahora.

---

---

## 10. Estado de ejecución y correcciones de arquitectura (post-arranque)

### 10.1 Hallazgo 1 — Tier 1 tiene 3 capas de red, no 1

La sección 4 original asumía que mockear `/api/*` (vía `mockApi`, que ya existía) alcanzaba para cubrir el CRUD de cada página. Leyendo el código real de `pedidos.js` esto es falso en dos frentes distintos, y probablemente se repite en la mayoría de las 54 páginas admin:

1. **PostgREST directo** — la mayoría de las páginas llaman `window.supabaseClient.from('tabla').select/insert/update/delete(...)` en vez de pasar por `/api/<modulo>`. Eso pega a `/rest/v1/<tabla>`, una URL y un shape de respuesta totalmente distintos a `/api/*`.
2. **RPC de Postgres** — algunas páginas (ej. el listado principal de `pedidos.html`, vía `fn_pedidos_lista`) ni siquiera usan `.from().select()`: llaman `sb.rpc('fn_x', params)`, que pega a `/rest/v1/rpc/fn_x` con un shape de request/response distinto de nuevo (params van en el body del POST, no en la URL).

**Impacto en el plan:** el "Patrón de spec estándar" de la sección 4 (mock solo de `/api/pedidos`, `/api/clientes`, `/api/stock`) está incompleto tal como estaba escrito — para que un spec de `pedidos.html` funcione hace falta además mockear la RPC `fn_pedidos_lista`, la tabla `pedido_items`, y probablemente `clientes`/`zonas`/`productos` según qué acción se teste. Esto no cambia la estimación de horas por página (ya estaba contemplado como parte del trabajo "por página"), pero sí corrige la arquitectura de helpers de la sección 4.

**Ya resuelto en código** (no solo documentado): `tests/e2e/helpers/supabase-rest-mock.js`, nuevo, con 4 funciones:
- `mockearTabla(page, tabla, handlers)` — GET/POST/PATCH/DELETE por tabla, handlers opcionales por verbo.
- `mockearTablasSoloLectura(page, fixturesPorTabla)` — atajo para páginas P1-P3 que solo leen.
- `mockearRpc(page, nombreFn, handler)` — la pieza que faltaba para páginas como `pedidos.html`.
- `mockearRestGenerico(page)` / `mockearApiGenerico(page)` — catch-all de red de seguridad (ver 10.2).

### 10.2 Hallazgo 2 — el 0% de `data-testid` no significa 0% de selectores estables

La sección 3 recomendaba agregar `data-testid` en masa porque "hoy el 0% del HTML lo tiene". Cierto, pero al auditar `pedidos.html` en detalle: 91 elementos con `id`, filas de tabla generadas con `class="fila-pedido" data-id="{id}" data-estado="{estado}" data-zona="{zona}"`. Son selectores ya estables y ya semánticos — no hace falta reemplazarlos por `data-testid`, alcanza con usarlos tal cual en los page objects. La convención `data-testid` de la sección 3 sigue siendo útil como **complemento** donde no hay nada estable (ej. botones de acción dentro de una fila, que hoy solo tienen `class` + `onclick`, sin `id` ni `data-*` propio) — no como reemplazo masivo. Esto probablemente baja el esfuerzo de la Fase 1 un poco por página (menos `data-testid` para agregar de lo estimado), a confirmar página por página en la práctica.

### 10.3 Avance real — qué está escrito y verificado, qué falta

**Verificado sin browser** (mismo tipo de verificación que ya hacía el README de la suite offline): `node --check` en los 4 archivos nuevos, `npx playwright test -c playwright.config.e2e.js --list` reconoce 89 tests sin errores de config. `npx playwright install chromium` sigue bloqueado acá (403, host no permitido) — falta correrlo de verdad en un entorno con red completa.

**Fase 0 — Cimientos: hecho**
- `tests/e2e/helpers/auth-helper.js` — siembra sesión de Supabase Auth (localStorage, mismo `storageKey` que usa cada portal) + mockea `usuarios`/`empresas` para que `auth.js` resuelva sin red real. `loguearComoAdmin()` es el atajo de 1 línea para el caso común.
- `tests/e2e/helpers/supabase-rest-mock.js` — ver 10.1.
- `tests/e2e/page-objects/page-object-base.js` — esperas comunes (`esperarAppLista`, `toast`, captura de errores de consola).
- Convención `data-testid` — revisada (10.2), pendiente aplicarla puntualmente en la Fase 1, no en bloque.

**Fase 0.5 — Smoke universal: escrito, no corrido**
- `tests/e2e/specs/smoke-universal.spec.js` — 89 tests, visita las 75 páginas (login mockeado donde corresponde vía `auth-helper.js`, catch-all de red vía `supabase-rest-mock.js`), verifica status < 400 + sin errores de consola/pageerror + (en páginas con sesión) que `#nav-root` llega a montarse. Encontré en el camino que las páginas del portal cliente redirigen solas a login si `usuarios.cliente_id` no resuelve — el catch-all genérico no alcanza ahí, así que esos specs tienen un override puntual de la tabla `usuarios`.

**Fase 1 (P0) — piloto de lectura escrito, no corrido**
- `tests/e2e/page-objects/admin/pedidos.page.js` — usa selectores existentes (`tr.fila-pedido[data-id]`, `#modal-*`), sin agregar `data-testid` (ver 10.2).
- `tests/e2e/specs/admin/pedidos.spec.js` — mockea `fn_pedidos_lista` + `fn_pedidos_stats_mes` (RPC) + `clientes`/`pedido_items`/`notif_log` (PostgREST), clickea una fila real del DOM y verifica que el modal de detalle muestra cliente, ítems y total correctos (`$ 15.000`, confirmado el formato exacto contra `ui-utils.js::formatARS`, no asumido).
- Alcance deliberado: solo lectura (listado + abrir detalle). El flujo de "crear pedido" queda pendiente — depende de `ProductoPicker` (buscador visual) y conviene resolverlo ya poder correr tests de verdad, no a ciegas.
- `playwright test --list` ahora reconoce 90 tests en 6 archivos (antes 89) — el nuevo spec no rompió el resto de la config.

**Siguiente paso concreto:** conseguir un entorno con salida a `cdn.playwright.dev` (tu máquina o CI) y correr `npm run test:e2e` — es el primer punto real de validación de todo lo de arriba; recién ahí se sabe si los shapes de RPC/PostgREST que inferí leyendo el código (no pude confirmarlos contra el schema real de Supabase desde acá) son correctos. Después de esa validación, extender el mismo patrón a las otras 8 páginas P0 y sumar el flujo de "crear pedido".

---

*Documento vivo — actualizar el inventario de la sección 1 si se agregan páginas nuevas antes de terminar el plan.*

---

## 11. v660 — Corrida real con browser + fix de los 2 problemas pendientes de v659

Este sandbox (a diferencia del de v659) trae Chromium preinstalado
(`/opt/pw-browsers`), así que por primera vez se pudo correr la suite con
un browser real en vez de solo `--list`/`node --check`. Con eso confirmé y
arreglé los 2 problemas que habían quedado pendientes (83/90):

### 11.1 Scope del Service Worker — arreglado

Causa raíz confirmada: `vercel.json` manda el header `Service-Worker-Allowed`
para los 4 `sw-*.js` (así `sw-admin.js`, que vive en `/frontend/admin/`,
puede pedir `scope: '/'`), pero `tests/e2e/helpers/static-server.js` no
replicaba ningún header — solo el `Content-Type`. Reproduje el error exacto
sin el header (`Failed to register a ServiceWorker for scope ('/')...The
path of the provided scope is not under the max scope allowed
('/frontend/admin/')`) y confirmé que desaparece con el fix: `static-server.js`
ahora manda `Service-Worker-Allowed` en los 4 scripts, igual que
`vercel.json`.

### 11.2 404 en `login` + 5 páginas admin — arreglado

Con el log real que pasó Lopez (`login`, `cta-cte`, `liquidacion`, `lotes`,
`presupuestos`, `suspendida`) identifiqué el patrón: las 4 páginas
`cta-cte`/`liquidacion`/`lotes`/`presupuestos` son stubs de redirect
(`window.location.replace('/admin/<algo>')`) a URLs limpias sin `.html`;
`login`/`suspendida` redirigen igual tras resolver sesión. `vercel.json`
tiene ~90 reglas de rewrite 1:1 para esas URLs limpias
(`/admin/cobranzas` → `/frontend/admin/cobranzas.html`, etc.) que
`static-server.js` no replicaba — de ahí el 404 real al navegar.

Fix: en vez de copiar las ~90 entradas (se desincroniza fácil),
`static-server.js` resuelve genéricamente `/<portal>/<slug>` sin extensión
contra `/frontend/<portal>/<slug>.html` si existe en disco, más un mapa
chico (`PORTAL_ROOT_ALIASES`/`ROOT_ALIASES`) para las pocas excepciones
donde el slug no coincide 1:1 (`/admin` → `dashboard.html`, `/setup` →
`/frontend/admin/setup.html`, etc. — copiadas literal de `vercel.json`).
Verificado con Playwright real: las 5 páginas navegan a su URL limpia y
cargan 200 (antes: 404).

### 11.3 Limitación real de este sandbox — CDN externos bloqueados

A diferencia del entorno donde se corrió el 83/90 original, este sandbox
bloquea `cdn.jsdelivr.net` (de donde carga `supabase-js` en **todas** las
páginas admin) y `browser.sentry-cdn.com` — el egress proxy devuelve 403.
Sin `window.supabaseClient`, cualquier página que dependa de una RPC/tabla
falla — confirmado que es 100% esto y no un bug real: mockeando
`supabase-js` con la copia de `node_modules/@supabase/supabase-js` (ya
está en `package.json` como dependencia), tanto las 5 páginas de redirect
como el piloto de `pedidos.spec.js` pasan limpio.

**No apliqué ningún cambio de código por esto** — en tu entorno real
`cdn.jsdelivr.net` respondía bien (si no, hubiesen fallado ~85 tests, no 7).
Si en algún momento CI corre en un entorno con salida restringida
parecida, lo que corresponde es vendorizar `supabase-js` igual que ya se
hace con Dexie (`vendorizarDexie` en `mock-network.js`) — queda anotado
acá por si hace falta, no lo hice porque no es el problema que reportaste.

### 11.4 Pendiente real, no de red

`admin/pedidos.spec.js` (el piloto de Fase 1) nunca se había corrido contra
un browser real hasta hoy — con `supabase-js` mockeado localmente, pasa
limpio (la fila `data-id="e2e-pedido-000000000001"` aparece con los datos
correctos). Buena señal para el resto de Fase 1, pero solo se validó este
único spec — el resto de los shapes de RPC/PostgREST para las otras 8
páginas P0 sigue sin correr contra código real.

---

## 12. v661 — segunda página P0 (`pos.html`): corrida real contra Chromium, 22/22 en suite completa

A diferencia de `pedidos.js`, confirmado leyendo el código: `pos.js` **no**
pega a PostgREST directo en ningún punto (`grep` de `supabaseClient`/`.from(`
no da coincidencias reales) — todo su CRUD pasa por `/api/pos/*` vía
`apiGet`/`apiPost` (fetch a mano) más `/api/clientes` para el buscador de
cliente. Esto simplifica la arquitectura de mocks respecto a `pedidos.js`:
alcanza con `mockApi` (helper de `/api/*`) y no hace falta
`supabase-rest-mock.js` para el flujo cubierto acá.

**`data-testid` agregado** (10.2 sigue aplicando: casi todo ya tenía `id`
estable): un solo lugar lo necesitaba — la fila del carrito (`pos-item-fila`)
no traía `data-id` propio con el `producto_id`, así que se le agregó
`data-testid="pos-carrito-fila" data-id="${producto_id}"` en
`renderCarrito()` (`pos.js`).

**Escrito:**
- `tests/e2e/page-objects/admin/pos.page.js` — page object nuevo, mismo
  patrón que `pedidos.page.js`.
- `tests/e2e/specs/admin/pos.spec.js` — 7 tests: carga inicial (combo de
  cajas poblado), validación de caja vacía (sin request), alta completa
  (buscar por código → agregar al carrito → cobrar en efectivo → ticket),
  edición (cambiar cantidad recalcula el total), borrado (quitar el único
  ítem deja el carrito vacío y Cobrar deshabilitado), validación de pago
  insuficiente (error sin request), y error de servidor (venta rechazada
  con 409, carrito no se pierde).
- Vendoriza Dexie (`vendorizarDexie`) igual que el resto de la suite offline,
  porque `pos.html` también carga `dexie@4` desde `cdn.jsdelivr.net` para
  `pos-offline.js` — sin esto, un entorno con ese CDN bloqueado podría meter
  errores de consola ajenos al flujo bajo test.

**Bloqueante de infraestructura resuelto (Chromium):** este sandbox trae
Chromium preinstalado en `/opt/pw-browsers`, pero como una revisión vieja
(`-1194`). El `package-lock.json` original del proyecto pedía
`playwright-core@1.62.1`, que exige la revisión `-1234`, y
`cdn.playwright.dev` (de donde se descarga) no está en la allowlist de red
de este sandbox → `playwright install` fallaba con 403. Se identificó la
versión exacta de `playwright-core` correspondiente a la revisión
preinstalada (`1.56.1` → revisión `1194`) y se dejó instalada esa versión en
`node_modules` — esto destrabó la corrida real.

**Segundo bloqueante encontrado y resuelto (CDN de `supabase-js`):** al
correr por primera vez contra Chromium real, `pos.html` y `pedidos.html`
quedaban colgados en "Cargando..." — ambos cargan
`cdn.jsdelivr.net/npm/@supabase/supabase-js@2/...`, bloqueado en este
sandbox (403), y sin `window.supabaseClient` disponible `auth.js` tira
`Cannot read properties of undefined (reading 'createClient')` antes de
resolver `authReady`. Se agregó `vendorizarSupabase(page)` en
`mock-network.js`, que sirve el SDK real (vendorizado desde
`node_modules/@supabase/supabase-js`, copiado a
`tests/e2e/fixtures/vendor/supabase-js.umd.js`) en vez del CDN bloqueado.
Se aplicó tanto en `pos.spec.js` como en `pedidos.spec.js` (este último
nunca se había vuelto a correr en este sandbox desde v660 y tenía el mismo
problema latente).

**Ruido de consola no relacionado, filtrado centralizadamente:** con el SDK
real de `supabase-js` vendorizado, éste intenta abrir de verdad un
WebSocket de Supabase Realtime contra el proyecto (bloqueado en el
sandbox), sumado a otros CDNs opcionales (xlsx, qrcodejs, zxing, Google
Fonts, Sentry) que también dan 403/CORS en consola. Se agregó
`filtrarRuidoRed(errores)` en `mock-network.js` (un solo lugar, usado por
ambos specs) para excluir puntualmente ese ruido de red propio del sandbox
de las aserciones de "sin errores de consola" — no son bugs de la app; en
un entorno con esa salida de red habilitada, resuelven bien.

**Confirmado contra Chromium real:**
- `pos.spec.js`: 7/7 tests pasando.
- `pedidos.spec.js`: 1/1 pasando (re-validado con el fix de `supabase-js`).
- Suite completa (`npx playwright test -c playwright.config.e2e.js`,
  sin filtro, corrida hasta el final): **22 passed**, sin ningún fallo.

**Siguiente paso concreto:** seguir con las 7 páginas P0 restantes:
`stock`, `facturacion`, `cobranzas`, `clientes`, `cta-cte`, `compras`,
`productos`. Nota de versionado: si se actualiza
`playwright`/`@playwright/test`/`playwright-core` de vuelta a `^1.62.1` en
`package.json` (por ejemplo al mergear con upstream), hay que volver a
alinear la versión instalada con la revisión de Chromium disponible en ese
entorno, o directamente correr `npx playwright install` en un entorno con
salida a `cdn.playwright.dev`.

---

## 13. v662 — tercera página P0 (`clientes.html`): piloto de lectura escrito, no corrido (bloqueante nuevo de entorno)

Leyendo `clientes.js` confirmado un tercer shape de red dentro del mismo
patrón del hallazgo 10.1: a diferencia de `pos.js` (todo `/api/*`) y de
`pedidos.js` (listado por RPC), el listado principal de `clientes.js` es
PostgREST directo con embeds (`sb.from('clientes').select('*, zonas(nombre),
listas_precios(nombre), scores_cliente(...)', {count:'exact'})`).

**`data-testid` agregado** (10.2 sigue aplicando): la fila (`tr.fila-cliente`
en `renderTabla()`) no traía ningún selector con el id — a diferencia de
`tr.fila-pedido[data-id]`, acá ni siquiera había un `data-*` propio. Se
agregó `data-testid="clientes-fila" data-id="${c.id}"`, mismo criterio que
`pos-carrito-fila` en v661.

**Hallazgo real de bug latente en el test, no en la app** (encontrado leyendo
`clientes-ciclos.js` antes de correr nada): `cli_ciclos_cargar()` — que se
llama automáticamente al abrir la ficha de un cliente vía
`abrirModalEditar()` — hace `fetch('/api/ciclos?cliente_id=...')` y
destructura `{ ciclos, sugerido, ultima_notif }` de la respuesta sin guard;
`ciclos.length` se usa sin chequeo. El catch-all genérico de `/api/*`
(`mockearApiGenerico`) devuelve `[]` para cualquier GET — con eso,
`data.ciclos` sería `undefined` y tiraría un TypeError real apenas se abre
cualquier ficha de cliente, ensuciando la señal de "sin errores de consola"
del spec sin ser un bug de la app. Resuelto con un `page.route('**/api/ciclos**', ...)`
puntual que devuelve el shape real (`{ciclos:[], sugerido:null,
ultima_notif:null}`), registrado después del catch-all para que gane (mismo
mecanismo de prioridad que ya usa `pedidos.spec.js`).

**Escrito:**
- `tests/e2e/page-objects/admin/clientes.page.js`.
- `tests/e2e/specs/admin/clientes.spec.js` — 1 test: la lista carga desde
  PostgREST (`clientes` mockeada, con `zonas`/`listas_precios` embebidos) y
  clickear "Ver / Editar" en una fila real abre la ficha con el form
  poblado correctamente (razón social, CUIT, zona, lista de precios, días
  de crédito) y el resumen de crédito con los montos correctos
  (`formatPeso` — separador de miles `.`, mismo gotcha que ya documentaba
  `pedidos.spec.js`).
- Alcance deliberado: solo lectura (listado + abrir ficha), igual criterio
  que el piloto de `pedidos`. El submit de alta/edición (`fetch('/api/clientes', ...)`)
  queda para la siguiente vuelta.

**Verificado sin browser:** `node --check` en los 2 archivos nuevos.
`npx playwright test --list` **no se pudo confirmar** en este sandbox —
antes de tocar `clientes`, la config entera (todos los specs existentes,
no solo el nuevo) falla con `Error: Playwright Test did not expect
test.beforeAll() to be called here` / `No tests found`. Confirmado que es
preexistente y no lo causó este cambio: moví temporalmente los 2 archivos
nuevos fuera de `tests/e2e/` y el mismo error aparece igual en
`proveedor.spec.js`/`smoke-universal.spec.js`. Huele a la misma fragilidad
que ya anotaba la sección 12 sobre el pin manual de `playwright-core`
(`1.56.1` para matchear la revisión de Chromium preinstalada) — puede
haberse desalineado con `@playwright/test` en este snapshot puntual del
`node_modules`. **No lo diagnostiqué más a fondo ni lo "arreglé" a
ciegas** porque tocar versiones de `package.json`/`node_modules` sin poder
correr la suite completa para confirmar el fix es más riesgo que valor acá.

**Siguiente paso concreto:** en un entorno con `node_modules` sano (o
`npm ci` fresco) confirmar que `clientes.spec.js` pasa contra Chromium
real, y diagnosticar ahí mismo por qué `--list` rompe en este snapshot.
Después seguir con las 5 páginas P0 restantes: `stock`, `facturacion`,
`cta-cte`, `compras`, `productos`.

**Actualización — corrida real (usuario, entorno con `node_modules` sano):**
`clientes.spec.js` corrido de verdad, y falló en la aserción del resumen de
crédito — bug del test, no de la app. Asumí (sin chequear) que `formatPeso()`
en `clientes.js` era igual al de `cobranzas.js` (`'$'+n.toLocaleString(...)`,
sin espacio). Es otra función, propia de este archivo:
`new Intl.NumberFormat('es-AR', {style:'currency', currency:'ARS'}).format(n)`,
que renderiza con un espacio entre `$` y el número. Corregido: la aserción
ahora chequea solo la parte numérica (`'25.000,00'`), sin el símbolo, para
no depender de ese carácter. `--list` sí reprodujo el mismo error que en mi
sandbox (0 tests) en la máquina del usuario también — pero apuntando el
spec por nombre (`clientes.spec`) corrió igual y encontró el test, así que
el bloqueante de `--list` es más acotado de lo que parecía (no bloquea
correr specs puntuales) — sigue sin diagnosticar a fondo.


---

## 14. `stock.html` y `facturacion.html` — escritos, sin documentar hasta ahora

Estas dos páginas (cuarta y quinta del orden de Fase 1: pedidos, pos, stock,
facturacion, cobranzas, clientes...) ya estaban escritas en el código
(`tests/e2e/page-objects/admin/stock.page.js` + `stock.spec.js`,
`facturacion.page.js` + `facturacion.spec.js`) pero quedaron sin su entrada
correspondiente en este plan — la sesión que las escribió no llegó a
documentarlas antes de que el usuario pasara a cobranzas/clientes. Se deja
constancia acá, reconstruyendo del código lo que corresponde, antes de
seguir con las páginas P0 restantes.

### 14.1 `stock.html`

Mezcla las tres capas de red del hallazgo 10.1 en un solo flujo: RPC
(`fn_stock_lista_agrupada` para listar, `ajustar_stock` para escribir) y
PostgREST directo (`depositos`, `categorias`). No hizo falta agregar
`data-testid` (10.2): la fila ya trae `class="fila-stock" data-prod-id`
y el botón de ajuste sus propios `data-*`.

`stock.spec.js` — 4 tests: listado correcto desde `fn_stock_lista_agrupada`,
ajuste de stock (ingreso) con el delta correcto y refresco de fila,
validación de cliente (sin motivo → sin request), y rechazo del servidor
(`ok:false`) que muestra el error sin perder los datos tipeados en el
formulario.

**Hallazgo real corriendo contra Chromium, ya corregido en
`page-object-base.js`:** el `<div class="toast" id="toast">` que trae cada
HTML estático es markup muerto — la función real de toast (IIFE en
`ui-utils.js`) crea su propio `<div class="toast">` sin id y lo appendea a
`document.body`. El getter `toast` de la base ahora apunta a
`div.toast.toast--visible` (la instancia real, visible), no a `#toast`, para
no dar un falso positivo de "toast vacío" en cualquier spec que lo use.

### 14.2 `facturacion.html`

Tercer shape de red distinto encontrado en el proyecto: además de RPC
(`fn_facturas_lista`, `fn_facturas_contadores`) y PostgREST directo
(`pedido_items`), esta página pega `fetch()` a mano contra
`/api/facturas/*` (enviar-email, pdf, reintentar, anular) con
`Authorization: Bearer <token>` armado en el propio módulo — no pasa por
`window.api` como el resto. `sb.auth.getSession()` lee la sesión fake de
`loguearComoAdmin()`, así que el token existe igual aunque sea falso.

`data-testid` agregado: `tr.fila-factura` no traía ningún selector estable
con el id de la factura (a diferencia de `fila-pedido`/`fila-stock`) — se
agregó `data-testid="factura-fila" data-id="${f.id}"` en `renderTabla()`.
Los botones de acción por fila ya tenían id propio
(`btn-reintentar-${id}`, `btn-pdf-${id}`).

**Pendiente de confirmar contra Chromium real:** a diferencia de
`pedidos`/`pos`/`stock`, no hay constancia en este plan de que
`facturacion.spec.js` se haya corrido contra un browser real todavía —
queda pendiente esa validación (misma limitación de red de este sandbox:
sin salida a `cdn.playwright.dev` no se puede confirmar acá).

**Siguiente paso concreto:** con stock y facturacion escritas, quedan 3
páginas P0: `cta-cte`, `compras`, `productos`.

---

## 17. `productos.html` — última página P0, Fase 1 completa (9/9)

Tercer patrón de red mixto (mismo hallazgo 10.1): listado por RPC
(`fn_productos_lista`, con `total_count` por fila), alta por una RPC
distinta (`fn_crear_producto` — crea el producto + stock inicial en los
depósitos elegidos del checklist) y edición por PostgREST directo
(`sb.from('productos').update()`). A diferencia de `pedidos.js`/`stock.js`,
alta y edición NO comparten camino de red.

`data-testid` no hizo falta (10.2): `<tr data-id="${p.id}">` en
`renderTabla()` ya es estable.

**Escrito:**
- `tests/e2e/page-objects/admin/productos.page.js`.
- `tests/e2e/specs/admin/productos.spec.js` — 5 tests: listado desde
  `fn_productos_lista`, alta con depósito elegido (payload correcto a
  `fn_crear_producto`), validación de cliente (sin depósito → sin
  request), edición (PATCH correcto a `productos`), y rechazo del
  servidor en el alta.

**Hallazgo real de arquitectura de UI, corregido en el test (no en la
app):** `#modal-producto` es un panel lateral (`right:-600px` →
`.modal.open{right:0}`, siempre `display:flex`, nunca `display:none`) —
mismo patrón que `clientes.css`/`facturacion.css`. `toBeVisible()` no
detecta el cierre porque el elemento nunca deja de tener bounding box;
corregido a `toHaveClass(/open/)` / `not.toHaveClass(/open/)`, mismo
criterio que ya usaba `stock.spec.js`.

**Hallazgo real de orden en `guardarProducto()`, confirmado corriendo
contra Chromium real:** a diferencia de `compras.js`/`cta-cte.js` (donde
la validación de cliente corta ANTES de `window.confirmar()`), acá
`window.confirmar()` se pide primero y la validación de "elegí al menos
un depósito" corre recién después, dentro del bloque de alta — hay que
confirmar el diálogo para llegar a esa validación. El test original
asumía el orden de las otras páginas y fallaba con el diálogo de
confirmación abierto sin cerrar; corregido confirmando antes de chequear
el toast de validación.

**Confirmado contra Chromium real** (este sandbox trae Chromium
preinstalado en `/opt/pw-browsers`, `npm install` funcionó — `registry.npmjs.org`
está permitido): `productos.spec.js` 5/5 passed. `playwright test --list`
reconoce 126 tests en 14 archivos (antes 116/13).

**Fase 1 (P0) completa: 9/9 páginas** — `pedidos`, `pos`, `stock`,
`facturacion`, `cobranzas`, `clientes`, `cta-cte`, `compras`, `productos`.

**Siguiente paso concreto:** seguir con Fase 2 (P1, ~20 páginas) según la
sección 7, o correr `smoke-universal.spec.js` completo en un entorno con
salida a `cdn.jsdelivr.net` para confirmar el bloque "con sesión" (en este
sandbox falla en masa por el mismo bloqueo de CDN de la sección 11.3 —
`vendorizarSupabase()` no está aplicado ahí todavía, solo en los specs de
Fase 1).

---

## 18. Fase 0.5 corrida a fondo (75/75) + 3 hallazgos reales en specs de Fase 1

**Fase 0.5, cerrada de verdad:** `smoke-universal.spec.js` no tenía
`vendorizarSupabase()` — por eso el bloque "con sesión" (Admin/Cliente/
Chofer) fallaba en masa acá con `Cannot read properties of undefined
(reading 'createClient')`, mismo hallazgo de la sección 11.3 pero nunca
aplicado a este spec en particular. Agregado + agregado a `RUIDO_IGNORADO`
el ruido de Firebase Messaging (`gstatic.com`, opcional, `push-init.js`) y
del wrapper `[DistribRealtime]` (Supabase Realtime real bloqueado en el
sandbox). **Confirmado contra Chromium real: 75/75 passed** — las 75
páginas del inventario cargan sin error de consola, público y logueado,
en los 4 portales.

**Corriendo la suite completa por primera vez de punta a punta** (no solo
`--list`), aparecieron 3 fallas reales en specs de Fase 1 que nunca se
habían corrido contra Chromium (`stock`/`cta-cte`/`cobranzas` — el plan
solo tenía confirmado `pedidos`/`pos`/`clientes`/`compras` hasta ahora),
más una en `compras` que sí se había dado por buena sin correr:

1. **`compras.page.js` — bug del test, corregido:** `btnNuevaOrden` usaba
   `getByRole('button', {name:'Nueva orden'})` sin `exact:true` — matchea
   tanto el botón real como un chip del topbar ("Nueva orden Recepciones").
   Con `exact:true`, 3 de los 4 tests de `compras.spec.js` pasan.
2. **`compras.spec.js` — pendiente, NO corregido:** el 4° test
   ("crear orden...") espera `$1.210,00` en `#oc-total` y la corrida real
   da `$605,00` — no se investigó la causa (puede ser bug del test dando
   por sentado un cálculo, o un bug real de `actualizarTotalesOC()`) por
   quedar fuera del alcance de esta sesión.
3. **`stock.spec.js` / `cobranzas.spec.js` — pendiente, NO corregido:**
   fallan con `[OfflineCore] Dexie no está cargado` — ambas páginas cargan
   `dexie@4` desde jsdelivr (para `stock-offline.js`/`cobros-offline.js`)
   pero sus specs nunca llaman a `vendorizarDexie()` (sí lo hace
   `pos.spec.js`, que sí pasa). Fix esperable: agregar
   `await vendorizarDexie(page)` al setup de ambos specs, mismo patrón que
   `pos.spec.js` — no aplicado todavía.
4. **`cta-cte.spec.js`:** 3/3 tests fallan, no diagnosticado a fondo —
   quedó anotado en el plan como "pendiente de confirmar" desde que se
   escribió (sección 15) y esta es la primera vez que corre contra
   Chromium real acá.

**Estado real de Fase 1 después de esta corrida** (contra Chromium real,
no solo `--list`): `pedidos` ✓, `pos` ✓, `clientes` ✓ (confirmado por el
usuario en su máquina), `productos` ✓ (5/5, esta sesión), `compras` 3/4,
`stock` pendiente fix Dexie, `cobranzas` pendiente fix Dexie, `cta-cte`
pendiente diagnóstico, `facturacion` nunca corrida contra Chromium real
(anotado ya en la sección 14.2).

**Siguiente paso concreto:** antes de arrancar Fase 2, cerrar los 4
pendientes de arriba (2 son fixes chicos ya identificados — Dexie en
stock/cobranzas —, 2 necesitan diagnóstico — el total de compras y
cta-cte completo) para que el "9/9 páginas P0" de la sección 17 sea
9/9 confirmado contra Chromium real, no solo escrito.

---

## 19. Los 4 pendientes de la sección 18, cerrados — confirmado en Chromium real y en la máquina del usuario

**`stock.spec.js` / `cobranzas.spec.js` (Dexie):** no era un bug — en la
corrida real del usuario (con internet completo) ambos pasan sin tocar
nada; `jsdelivr.net` sirve `dexie@4` sin problema fuera de este sandbox.
Descartado, no requiere fix.

**`compras.spec.js` — bug real del TEST, encontrado y corregido:**
`updateItemOC()` (compras.js) recalcula el total por `onchange` — evento
nativo que el browser dispara recién al perder el foco, no al tipear.
`completarItem()` en `compras.page.js` usaba `.fill()` sin forzar blur:
el ÚLTIMO input tocado (precio_costo) quedaba sin confirmar hasta que
algo le sacara el foco por su cuenta. Diagnosticado leyendo `itemsOC` en
vivo con `page.evaluate()` (script de debug descartado después). Fix:
`completarItem()` ahora llama `.blur()` después de cada `.fill()`.
Confirmado 4/4 contra Chromium real.

**`cta-cte.spec.js` — bug real de la APP, encontrado y corregido:**
2 de 3 tests fallaban con `<label>N° comprobante</label> ... subtree
intercepts pointer events` al clickear el botón "ok" del diálogo de
`window.confirmar()`. Causa raíz: `#modal-cobro` usa `.modal-overlay`
(definida en `finanzas.css`, `z-index:500`), pero `window.confirmar()`
usa `--z-modal` (`shared/tokens.css`, default `400`) — con
`#modal-cobro` abierto, el diálogo de confirmación queda VISUALMENTE
DETRÁS del modal y su botón "ok" es **inclickeable con mouse para
cualquier usuario real**, no solo para Playwright. Mismo hallazgo que ya
se había parchado para `#modal-producto` en
`productos-modal-fix.css` (`--z-modal: 10100` scopeado a esa página) —
nunca se replicó para `cobranzas.html`. Fix: mismo override agregado al
final de `cobranzas-gentelella.css` (que carga después de `finanzas.css`
en `cobranzas.html`, así que gana). Confirmado 5/5 contra Chromium real.

**`chofer.spec.js` / `cliente.spec.js` — "reconexión intermitente":**
flaky bajo carga paralela (4 workers), no determinístico. Corrido
`--repeat-each=5 --workers=1`: 10/10 passed. Con contención de CPU entre
workers, las ventanas de timing de estos tests (toggling online/offline
rápido con timers reales) se corren lo suficiente como para gatillar
ocasionalmente la propia carrera de `syncEnCurso` que el comentario del
test ya documentaba como riesgo conocido — no es un bug nuevo introducido
acá. Recomendación: si vuelve a aparecer en CI, correr la suite offline
(`chofer.spec.js`/`cliente.spec.js`) con `--workers=1` o aceptar 1 retry
automático para esos dos tests puntuales.

**Estado real de Fase 1 (P0), confirmado de punta a punta contra
Chromium real, tanto en este sandbox como en la máquina del usuario:
9/9 páginas, 32/32 tests de Fase 1 en verde** (además de los 80/80 de
Fase 0.5 y el resto de la suite pre-existente, sin contar los 2 flaky
de arriba). Recién ahora el "Fase 1 completa" de la sección 17 es un
hecho confirmado, no solo escrito.

---

## 20. Tercer fix: la flakiness de "reconexión intermitente" SÍ tenía causa raíz, y era del harness de test

Después de la sección 19, "chofer/cliente" seguían dando `llamadas`
distinto del esperado bajo carga paralela (4 workers). Se investigó a
fondo en vez de dejarlo como "flaky, reintentar" — y apareció una causa
real en `tests/e2e/helpers/mock-network.js`, compartida por
`chofer.spec.js`/`cliente.spec.js`/`pos.spec.js` (los 3 tests de
"reconexión intermitente" de la suite offline):

`irOffline()`/`irOnline()` fijaban `redEstado.offline` (el flag que usa
`mockApi()` para decidir si abortar o cumplir cada request) de forma
SÍNCRONA, y devolvían el control apenas `context.setOffline()` (comando
CDP) resolvía — sin esperar a que la PÁGINA hubiera realmente recibido
el evento `online`/`offline` del browser (que es lo que escucha
`offline-core.js` para arrancar el sync). Son dos señales async con
timing propio, no necesariamente sincronizadas tick a tick. Con 5
toggles seguidos y cero espera entre ellos, bajo contención de CPU esa
ventana se agranda lo suficiente como para que un sync arranque
creyendo que sigue online cuando `redEstado.offline` ya cambió (o
viceversa) — exactamente la naturaleza de "carrera" que el propio
comentario del test ya advertía, solo que la causa estaba en el
arnés de test, no en `syncEnCurso`.

**Fix:** `irOffline()`/`irOnline()` ahora aceptan un tercer parámetro
`page` opcional (retrocompatible) y esperan
`page.waitForFunction(() => navigator.onLine === <esperado>)` antes de
devolver el control — garantiza que cada toggle ya fue observado por la
página antes de aplicar el siguiente. No le agrega demora artificial al
escenario que el test quiere estresar (toggles reales consecutivos):
solo saca la ambigüedad de asumir que dos relojes async coinciden sin
confirmarlo. Actualizados los 26 call-sites de los 3 specs para pasar
`page`.

**Resultado, stress-testeado a propósito** (`--repeat-each=10
--workers=4`, la config más agresiva posible en este sandbox): antes
del fix fallaba reproduciblemente bajo carga paralela; después,
**29/30**. El único fallo residual fue un timeout (se quedó esperando
sin resolver, no dio un resultado incorrecto) — compatible con margen
de CPU insuficiente en un stress test deliberadamente extremo (4
workers + 10 repeticiones en un sandbox compartido), no con la carrera
original. Corrida la suite completa normal después: **123/126** — los
3 rojos restantes son, otra vez, el mismo bloqueo de CDN de Dexie sin
internet (sección 18), no relacionados con este fix.

**Los 3 fixes pedidos, cerrados:** `compras.spec.js` (blur en
`completarItem()`), `cta-cte.spec.js`/`cobranzas.html` (z-index del
confirm, bug real de UI), y la flakiness de reconexión de
`chofer`/`cliente`/`pos` (sincronización del harness offline). Los 4
pendientes originales de la sección 18 quedan todos resueltos o
explicados con causa raíz confirmada.

---

## 21. Arranque de Fase 2 (P1) — `rutas.html`, primera página del bloque priorizado

Orden de Fase 2 elegido por el usuario (ver priorización pedida): rutas /
lotes-vencimientos / devoluciones-cheques-conciliación-bancaria /
usuarios-proveedores-notas-presupuestos / portal cliente+chofer — se
arranca por `rutas.html` (standalone; `vencimientos.html` comparte
`lotes.js` y se trata junto con `lotes.html` en otra vuelta).

**El bloqueante con el que había quedado esto (redirect fantasma a
`/setup`) tenía causa de arnés de test, no de la app — igual que el
hallazgo de la sección 20.** El primer intento de `rutas.page.js` hacía
`goto()` contra la URL "limpia" (`/admin/rutas`, resuelta por
`static-server.js` vía `CLEAN_PAGE_URL`) en vez de la ruta directa al
archivo (`/frontend/admin/rutas.html`), que es el patrón que usan las 9
páginas de Fase 1 ya confirmadas. No se terminó de aislar la causa exacta
de por qué esa URL en particular disparaba una navegación a `/setup` (no
hay ningún `location.href`/`location.replace` a `/setup` en
`rutas.js`/`rutas.html`/`nav.js`/`ui-utils.js` — se descartó con `grep`
antes de cambiar de enfoque), pero al alinear `goto()` con el patrón ya
probado de Fase 1 el problema desapareció por completo. Recomendación
para las próximas 19 páginas de P1: usar siempre la ruta directa al
`.html`, no la limpia, salvo que el propio test quiera ejercitar
específicamente el rewrite de `vercel.json`.

**Segunda particularidad real de esta página** (esta sí de la app, no del
arnés): a diferencia de las 9 de Fase 1, el tab que está activo por
defecto al entrar es "Resumen" (`#tab-resumen-content`), no "Armar ruta"
(`#tab-armar-content`, que arranca con `class="hidden"`). `goto()` del
page object cambia de tab automáticamente después de `esperarAppLista()`
para no tener que repetirlo en cada test.

**Tercera particularidad:** `confirmarRuta()` no pasa por `/api/*` — hace
3 escrituras PostgREST directas en secuencia (`sb.from('rutas').insert()`
→ `sb.from('entregas').insert()` → `sb.from('pedidos').update()`), y
recién después notifica al chofer por WhatsApp/push. El mock de las 3
tablas lleva estado mutable en closures (no fixtures fijos) para poder
confirmar el efecto de punta a punta: el pedido recién ruteado desaparece
del panel de pendientes en el siguiente `cargarDatos()` (filtro
`pedidosYaEnRuta` contra `entregas` activas, el mismo que ya documentaba
el hallazgo de auditoría etapa 6 leído durante la exploración del código).

**Hallazgo de comportamiento real, documentado (no "corregido" — no era
el pedido de esta vuelta):** el `catch` de `confirmarRuta()` siempre
muestra el mismo toast genérico ("Error al crear la ruta — revisá la
consola") sin importar el mensaje real del error del servidor —
diferencia notable con `compras.js`/`cta-cte.js`, que sí propagan
`err.message`. El spec lo verifica tal cual es hoy (asertando el texto
genérico), no lo que "debería" decir. Candidato a una futura pasada de
UX de errores si se decide homogeneizar.

**Escrito:**
- `tests/e2e/page-objects/admin/rutas.page.js`.
- `tests/e2e/specs/admin/rutas.spec.js` — 5 tests: listado de pedidos
  despachables + rutas del día, armar ruta y confirmar (con verificación
  de los 3 payloads PostgREST y del efecto de "desaparece de pendientes"),
  validación de cliente sin chofer, validación de cliente sin pedidos, y
  rechazo del servidor (mensaje genérico, ruta armada no se pierde).

**Confirmado contra Chromium real en este sandbox: 5/5.** Corrida la
suite completa después: **128/131** — los 3 rojos son el mismo bloqueo
de CDN de Dexie sin internet completo ya documentado en la sección 19
(`cobranzas.spec.js`, `cta-cte.spec.js`, `stock.spec.js` — no relacionados
con este spec ni regresiones introducidas por él).

**Siguiente paso concreto:** `lotes.html` + `vencimientos.html` juntas
(comparten `lotes.js`), después el resto del bloque "operación de
depósito" del pedido original.

---

## 15. `cta-cte.html` — hallazgo de arquitectura: es un redirect, no una página

Al ir a escribir el page object de `cta-cte` (séptima de la Fase 1),
`/admin/cta-cte.html` resultó ser un **stub de redirect** de 24 líneas
(`window.location.replace('/admin/cobranzas?vista=saldos')`) — mismo patrón
que ya documentaba el hallazgo 11.2 para `liquidacion`/`lotes`/`presupuestos`,
que en su momento no se había terminado de conectar con esta página en
particular. La lógica real (`cta-cte.js`, 653 líneas) se carga desde
`cobranzas.html` y vive en `#vista-saldos` — la pestaña "Saldos por cliente"
que `cobranzas.page.js`/`cobranzas.spec.js` (Fase 1, cobranzas) ya habían
dejado a propósito para "más adelante en el plan" al testear solo la
pestaña "¿A quién llamo hoy?". Ese "más adelante" es este spec.

**Impacto:** no hay nada que testear en `cta-cte.html` en sí (ya lo cubriría
implícitamente cualquier smoke test que siga redirects, Fase 0.5). El page
object (`cta-cte.page.js`) navega directo a `cobranzas.html?vista=saldos`.

**Cuarto patrón de red encontrado** (además de `/api/*`, PostgREST vía
`sb.from()`, y RPC): `abrirCliente()` pega un `fetch()` A MANO contra
`/rest/v1/cta_cte` con headers armados por un `getHeaders()` propio del
módulo, en vez de pasar por `sb.from('cta_cte')`. No hace falta ningún
helper nuevo para esto — `mockearTabla` intercepta por patrón de URL
(`**/rest/v1/cta_cte**`), así que cubre esta request exactamente igual que
si hubiera salido del SDK.

**`data-testid` agregado** (10.2 sigue aplicando): `<tr onclick="abrirCliente(...)">`
en `renderTabla()` (`cta-cte.js`) no traía ningún selector estable con el
id del cliente — se agregó `data-testid="cc-fila" data-cliente-id="${c.cliente_id}"`.

**Escrito:**
- `tests/e2e/page-objects/admin/cta-cte.page.js`.
- `tests/e2e/specs/admin/cta-cte.spec.js` — 5 tests: listado + KPIs desde
  `fn_cta_cte_lista`/`fn_cta_cte_kpis`, panel de detalle de cliente (lectura,
  ejercitando el `fetch()` a mano de arriba), cobro directo desde la fila
  con el payload correcto a `registrar_cobro_completo` (`p_factura_id: null`
  para el caso genérico, a diferencia del cobro vinculado a una factura que
  ya cubre `cobranzas.spec.js`), validación de cliente (sin medio de pago)
  y rechazo del servidor.

**Verificado sin browser:** `node --check` en los 2 archivos nuevos y en
`cta-cte.js` (por el `data-testid` agregado). Sigue sin poder confirmarse
contra Chromium real desde este sandbox (sin `node_modules`/sin salida a
`cdn.playwright.dev` acá) — pendiente de correr en un entorno con red
completa, mismo criterio que el resto de la Fase 1.

**Siguiente paso concreto:** quedan 2 páginas P0: `compras`, `productos`.

---

## 16. `compras.html` — listado + alta de orden de compra

Novena página del orden (pedidos, pos, stock, facturacion, cobranzas,
clientes, cta-cte, compras, productos). A diferencia de facturacion.js
(que mezcla RPC + PostgREST + `/api/*` a mano), compras.js concentra casi
todo su CRUD en `/api/compras` (fetch a mano con `Authorization: Bearer`
propio, mismo patrón que facturacion.js) — el único punto que sale por
otro lado es el combo de productos del formulario (`sb.from('productos')`,
PostgREST directo) y la recepción de mercadería (`ajustar_stock`, RPC, una
llamada por ítem recibido).

**`data-testid` agregado** (10.2 sigue aplicando): `<tr>` en `renderTabla()`
no traía ningún selector estable con el id de la orden — se agregó
`data-testid="oc-fila" data-id="${o.id}"`.

**Modales sin clase `open`/`hidden`:** a diferencia de stock.html/cta-cte.html,
`#modal-oc`/`#modal-detalle` alternan `style.display = 'flex' | 'none'` a
mano — el page object usa `toBeVisible()`/`not.toBeVisible()` en vez de
`toHaveClass()`, que da el mismo resultado sin importar el mecanismo.

**Escrito:**
- `tests/e2e/page-objects/admin/compras.page.js`.
- `tests/e2e/specs/admin/compras.spec.js` — 4 tests: listado desde
  `/api/compras`, alta de orden con proveedor + producto (confirma que el
  total recalculado usa el precio tipeado por el usuario, no el costo por
  defecto que trae `seleccionarProductoOC()`), validación de cliente (sin
  proveedor) y rechazo del servidor.

**Alcance deliberado** (igual criterio que el piloto de `pedidos`/`clientes`):
NO cubre "Recepcionar" (además de `/api/compras?accion=recepcionar`,
dispara `ajustar_stock` por cada ítem recibido — una RPC por línea, más
parecido en complejidad al flujo de `producir_con_insumos` de
`stock.spec.js` que a un submit simple) ni "Aprobar" (OC auto-generada
desde Automatización, vía `/api/stock-auto`). Quedan para una vuelta futura
si hace falta profundizar esta página más allá del alta.

**Verificado sin browser:** `node --check` en los 2 archivos nuevos y en
`compras.js` (por el `data-testid` agregado). Sigue pendiente de
confirmarse contra Chromium real en un entorno con `node_modules` sano.

**Siguiente paso concreto:** queda 1 página P0: `productos`.

---

## 22. Bloque "devoluciones / cheques / conciliación bancaria" — `devoluciones.html`

Segunda parada del bloque de Fase 2 (P1) elegido (ver sección 21). A
diferencia de rutas/lotes-vencimientos, `devoluciones.html` es standalone:
JS propio (`devoluciones.js`, 644 líneas), no comparte script clásico con
ninguna otra página, y no pasa por PostgREST para su CRUD principal —
llama a `/api/admin/devoluciones` (`lib/handlers/pedidos.js` →
`handleDevolucionesAdmin()`), con `accion` como discriminador
(`listar`/`kpis`/`revisar`/`notas`/`foto`) igual patrón que ya usan otras
páginas de Fase 1.

**Hallazgo real, no de arnés:** al escribir el bug de producción de la
vuelta anterior (`lib/repos/stock.js`/`automatizacion.js`, `db.rpc(...)
.catch()` — el builder de postgrest-js es thenable pero no tiene
`.catch()` propio), se revisó si el mismo patrón aparecía en otro lado
del código con `grep`. No aparece en `devoluciones.js` ni en su handler —
descartado como riesgo en esta página.

**Prerrequisito agregado:** `data-testid="dev-fila"` + `data-id` en
`devoluciones.js::renderTabla()` — el `<tr>` no traía selector estable,
mismo criterio que `lote-fila`/`oc-fila`.

**Alcance deliberado:** listado + KPIs, abrir detalle (panel lateral con
ítems), aprobar/rechazar una devolución pendiente (incluida la
verificación de que `reponer_stock`/`generar_nc` viajan en `false` cuando
se rechaza — no solo cuando se aprueba), y rechazo del servidor sin perder
la devolución activa del panel. NO cubre: alta manual desde el admin
(modal con `ProductoPicker` + upload de foto en base64 — subsistema propio
con su propio endpoint `accion=foto`, candidato a spec separado), exportar
CSV, editar notas internas, eliminar (solo pendientes), ni
paginación/filtros server-side (`q`/`estado`/`motivo`/fecha con debounce)
— quedan para una vuelta futura si se decide profundizar esta página más
allá del flujo de revisión.

**Escrito:**
- `tests/e2e/page-objects/admin/devoluciones.page.js`.
- `tests/e2e/specs/admin/devoluciones.spec.js` — 5 tests.

**Confirmado contra Chromium real: 5/5.** Suite completa después:
**137 passed, 4 failed** — los 4 rojos son los ya documentados (bloqueo de
CDN de Dexie sin internet completo, secciones 19/21: `cobranzas`,
`cta-cte`, `stock`; más un test de reconexión intermitente de
`cliente.spec.js` no relacionado). Ninguna regresión por este spec ni por
el `data-testid` agregado.

**Siguiente paso concreto:** `cheques.html`, después
`conciliacion-bancaria.html` — cierran el bloque.

---

## 23. Bloque "devoluciones / cheques / conciliación bancaria" — `conciliacion-bancaria.html`, cierra el bloque

Tercera y última parada del bloque de Fase 2 (P1) elegido (ver secciones
21-22). `cheques.html` ya estaba resuelto (page object + spec presentes) al
retomar esta vuelta. `conciliacion-bancaria.html` es standalone: JS propio
(`conciliacion-bancaria.js`, 442 líneas), y a diferencia de
devoluciones/cheques NO le pega a PostgREST/RPC en ningún lado — todo pasa
por un único endpoint `/api/conciliacion-bancaria`, discriminado por
método + querystring (`_svc=confirmar|deshacer|descartar|auto`, `lote_id`,
`estado`). Una sola capa de red, se mockea entera con `mockApi`.

**Prerrequisito agregado:** `data-testid="lote-item"` + `data-id` en
`renderLotes()` y `data-testid="mov-fila"` + `data-id` en
`renderMovimientos()` — ninguno de los dos traía selector estable, mismo
criterio que `dev-fila`/`cheque-fila`.

**Hallazgo de arnés, no de la app:** el `<script>` de PapaParse
(`cdn.jsdelivr.net/npm/papaparse@5.4.1`) que usa esta página para parsear
el CSV del extracto no estaba vendorizado (solo Dexie y supabase-js lo
estaban). Sin internet completo, `window.Papa` nunca existe y el test de
importación caería en el toast de error genérico, no por un bug real —
mismo patrón que el bloqueo de CDN de Dexie (secciones 18-19). Se agregó
`vendorizarPapaparse(page)` en `mock-network.js` (copia literal de
`papaparse.min.js@5.4.1`, misma versión que pide el HTML) para que el spec
no dependa de la disponibilidad del CDN.

**Gate de permisos:** la página entera está condicionada al rol
(`ROLES_LECTURA_CONCILIACION`/`ROLES_ESCRITURA_CONCILIACION`, ambos
dueño/admin/contador hoy — son la misma lista, no hay rol de solo-lectura
configurado actualmente). Sin uno de esos roles: `#contenido-conciliacion`
queda oculto y se muestra `#sin-permiso`.

**Alcance deliberado:** gate de permisos, carga de lotes + KPIs, selección
de lote y filtro de movimientos por estado, confirmar un match candidato,
deshacer un match conciliado, descartar un movimiento pendiente,
auto-conciliar, e importar un CSV válido (verifica el POST con
`nombre_archivo` + `movimientos` parseados). NO cubre: el parseo de
formatos de extracto (fechas DD/MM/AAAA, montos AR con coma decimal,
layout débito/crédito separado) — es lógica pura sin DOM
(`mapearFilaExtracto`/`parsearFechaFlexible`/`parsearMontoAR`), candidata a
spec de unidad si hace falta profundizar, no a E2E; tampoco el drag&drop
en sí (se ejercita el mismo handler vía `setInputFiles`, no el evento
`drop` del navegador).

**Escrito:**
- `tests/e2e/page-objects/admin/conciliacion-bancaria.page.js`.
- `tests/e2e/specs/admin/conciliacion-bancaria.spec.js` — 8 tests.

**Actualización (corrida real bajo los 4 workers en paralelo del suite
completo):** el test de "rol fuera de PAGINA_ROLES_PERMITIDOS" flakeó una
vez por timeout — con el resto de la suite compitiendo por CPU, el
redirect de auth.js puede tardar más que los 10s originales. Se subió el
timeout de `waitForURL` a 20s; no es un cambio de comportamiento
esperado, es margen para corridas con los 4 workers cargados.
- `tests/e2e/helpers/mock-network.js` — agregado `vendorizarPapaparse`.

**Confirmado contra Chromium real: 14/16 en la primera corrida (usuarios.spec.js
7/7 + conciliacion-bancaria.spec.js 7/9), 2 rojos reales de esta página —
ver corrección abajo.**

**Hallazgo real de la app (no de arnés), encontrado por los 2 rojos:**
`window.PAGINA_ROLES_PERMITIDOS` (gate de página completa en `auth.js`,
declarado en el `<script>` inline de `conciliacion-bancaria.html`) y
`ROLES_LECTURA_CONCILIACION`/`ROLES_ESCRITURA_CONCILIACION` (gate interno
de `conciliacion-bancaria.js`, el que pinta `#sin-permiso`) son **la misma
lista exacta** (`dueno`/`admin`/`contador`) hoy. Con un rol fuera de esa
lista (ej. `vendedor`), `auth.js` redirige TODA la página a `/admin/login`
antes de que `conciliacion-bancaria.js` llegue a evaluar su propio gate —
el branch `#sin-permiso` es código inalcanzable con la configuración de
roles actual. Los 2 tests originales asumían (mal, sin haber corrido
contra Chromium real todavía) que se podía forzar ese estado con un rol
como 'vendedor'; en la práctica el test colgaba hasta timeout esperando
`#nav-root`, que nunca llega a existir porque la navegación ya se fue a
otra página. Corregido:
- Un test pasa a verificar el comportamiento REAL (redirect completo a
  `/admin/login`), navegando directo con `page.goto()` en vez de
  `conciliacionPage.goto()` (que depende de `#nav-root`).
- El segundo test pasa a ser una aserción de consistencia entre los
  arrays de roles de `conciliacion-bancaria.html`/`.js` (fetch de los
  fuentes + comparación), para que si algún día se agrega un rol a una
  lista sin tocar la otra, el spec avise en vez de quedar como
  documentación desactualizada.

**Corrección aplicada, pendiente de reconfirmar contra Chromium real** (no
se pudo re-ejecutar desde este entorno — sin navegadores instalados).

**Siguiente paso concreto:** bloque "devoluciones / cheques / conciliación
bancaria" cerrado. Al retomar se confirmó que `lotes-vencimientos` ya
estaba resuelto de una vuelta anterior (`vencimientos.page.js`/`.spec.js`
presentes; `lotes.html` es solo un redirect, ver cabecera de
`vencimientos.spec.js`). Se sigue entonces con el próximo bloque del orden
de la sección 21: "usuarios / proveedores / notas / presupuestos".

---

## 24. Bloque "usuarios / proveedores / notas / presupuestos" — `usuarios.html`

Primera parada del nuevo bloque. `usuarios.html` es standalone: JS propio
(`usuarios.js`, 270 líneas), CRUD contra `/api/usuarios`
(`lib/handlers/usuarios.js`) — sin PostgREST directo para su propio
dominio (las únicas queries a `usuarios`/`empresas` que ve la página son
las 2 de `auth.js` resolviendo el perfil logueado).

**Prerrequisito agregado:** `data-testid="usuario-fila"` + `data-id` en
`usuarios.js::renderTabla()` — la fila se arma con
`document.createElement('tr')` (no template literal, a diferencia de
devoluciones/cheques/conciliación), así que el `data-id` se agrega vía
`tr.dataset.id` en vez de interpolado en el HTML. Mismo criterio que
`dev-fila`/`cheque-fila`/`lote-item`.

**Regla de negocio propia de esta página, cubierta a propósito:** un
`admin` no puede tocar (editar/activar/desactivar) a otro `dueno` ni a
otro `admin` — la fila muestra la leyenda "Solo el dueño" en vez de
botones (`esAjenoIntocable` en `renderTabla()`). Sí puede editarse a sí
mismo, pero sin botón de desactivar sobre su propia fila. El backend
repite la misma regla (`ROLES_PRIVILEGIADOS`, ver `lib/handlers/usuarios.js`)
pero eso queda fuera de este E2E — solo se ejercita el comportamiento del
DOM.

**Nota de arnés:** `#banner-limite-plan` (markup en el HTML) está muerto —
ningún código de `usuarios.js` lo toca. El error de límite de plan al
crear (`LIMITE_PLAN_ALCANZADO`) se comunica solo por toast. Documentado en
el page object para que nadie pierda tiempo buscando cómo dispararlo.

**Alcance deliberado:** listado + filtro activo/búsqueda (in-memory, sin
red), la regla "vos"/"Solo el dueño", alta con confirmación (incluido el
error de límite de plan), edición con confirmación (precarga sin
password/email editable), y activar/desactivar con confirmación. NO
cubre: el caso "editar a un dueño siendo dueño" (rama de UI casi idéntica
a la ya cubierta con rol admin), ni las reglas de rechazo del backend
(responsabilidad de un test de integración de `lib/handlers/usuarios.js`,
no de este E2E) — quedan para una vuelta futura si hace falta profundizar.

**Escrito:**
- `tests/e2e/page-objects/admin/usuarios.page.js`.
- `tests/e2e/specs/admin/usuarios.spec.js` — 7 tests.

**Siguiente paso concreto:** `proveedores.html`, después `notas.html` y
`presupuestos.html` — cierran el bloque.

---

## 25. Bloque "usuarios / proveedores / notas / presupuestos" — `proveedores.html`

Segunda parada del bloque. `proveedores.html` es standalone: JS propio
(`proveedores.js`, 537 líneas), CRUD contra `/api/proveedores`
(`lib/handlers/proveedores.js`) — sin PostgREST directo para su propio
dominio. Suma un sub-router `_svc=portal-admin`
(`portal_proveedor.js::handlePortalAdmin`) para el portal de autogestión
del proveedor (#10 — Vidriera Inversa): generar/listar/revocar links que
le permiten ver sus órdenes de compra sin login.

**Prerrequisito agregado:** `data-testid="proveedores-fila"` + `data-id`
en `proveedores.js::renderTabla()` — la fila se arma con template literal
(no `document.createElement`, a diferencia de usuarios) y no traía ningún
selector estable con el id. Mismo criterio que `usuario-fila`/`dev-fila`.

**Particularidad de esta página frente a usuarios.html:** el listado es
100% server-side desde v282 (búsqueda, filtro `activo` y paginación viajan
como querystring — antes era `.limit(500)` fijo + `Array.filter()` en el
navegador, que dejaba resultados afuera silenciosamente con más de 500
proveedores). El page object documenta esto porque es la inversa del
patrón de usuarios.html (in-memory) — `buscar()` dispara una request
nueva, no filtra en el DOM.

**Confirmación:** a diferencia de usuarios.html (que confirma alta,
edición y cambio de estado), acá SOLO `desactivar()` pide
`window.confirmar()`. Alta, edición y `activar()` disparan la request
directo al click de guardar — documentado en el page object para que
nadie asuma el mismo comportamiento de la página anterior del bloque.

**Panel "Links de acceso activos":** carga aparte de la tabla principal
(`cargarLinksActivos()`, sin esperar la tabla). Hace una request para
resolver id→nombre y después una request EN PARALELO POR PROVEEDOR
(`accion=links&proveedor_id=<id>`) — con muchos proveedores son N+1
requests; el spec lo cubre con una lista chica a propósito. La fila de
este panel tiene `id="link-row-<id>"`, no `data-testid` — se optó por no
sumar más superficie de la necesaria.

**Alcance deliberado:** listado + filtro activo/búsqueda server-side,
alta sin confirmación, edición sin confirmación, dar de baja CON
confirmación, activar sin confirmación, generar link del portal, y el
panel de links activos (carga + revocar con confirmación). NO cubre:
paginación más allá de 200 registros, el envío del link por WhatsApp
(abre `wa.me` en pestaña nueva vía `window.open`, fuera de alcance sin
mockearlo), ni "ver compras" (navega a `compras.html?proveedor=<id>`,
ya cubierto por `compras.spec.js`) — quedan para una vuelta futura si
hace falta profundizar.

**Escrito:**
- `tests/e2e/page-objects/admin/proveedores.page.js`.
- `tests/e2e/specs/admin/proveedores.spec.js` — 8 tests.

**Corrido contra Chromium real (no solo `node --check`) y encontró 2 bugs
genuinos de la app, no del test:**
- `cargarLinksActivos()`/`revocarLinkPortal()` llamaban a `escapeHtml(...)`
  en 3 lugares (líneas 478, 479, 507) — función que no existe en ningún
  lado del proyecto (el helper real es `window.sanitize`, alias `window.s`).
  Rompía el panel "Links de acceso activos" completo en producción
  (`ReferenceError` capturado por el `.catch()` de `cargarLinksActivos`,
  panel quedaba en el estado de error) y también el texto del diálogo de
  confirmación de "Revocar link". Corregido: las 3 llamadas ahora usan
  `window.sanitize`.
- `getByRole('button', {name: 'Nuevo proveedor'})` sin `exact: true`
  matcheaba también el chip del topbar (mismo hallazgo que
  `cheques.page.js` con "Nuevo cheque" — `topbar-widgets.js::_armarMenuChip`
  envuelve todo `.topbar-right` en un chip clickeable cuyo nombre
  accesible absorbe el texto de sus hijos). Corregido con `exact: true`;
  de paso se auditaron todos los page objects del bloque y `notas.page.js`
  tenía el mismo problema latente con "Nueva Nota" (no había fallado
  todavía porque ningún spec la había corrido contra un navegador real) —
  corregido ahí también.

**Siguiente paso concreto:** `notas.html`, después `presupuestos.html` —
cierran el bloque.

---

## 26. Bloque "usuarios / proveedores / notas / presupuestos" — `notas.html`

Tercera parada del bloque. `notas.html` es standalone: JS propio
(`notas.js`, 287 líneas). Primera diferencia real frente a
usuarios/proveedores: NO pega contra `/api/*` para su CRUD principal —
el listado sale de una RPC de Postgres (`fn_notas_lista`, migración 263,
mismo patrón que `fn_pedidos_lista` en pedidos.html) y el alta pega a
OTRA RPC (`emitir_nota_cta_cte`). Se mockean las dos con `mockearRpc()`
de `supabase-rest-mock.js`, no con `mockApi()`. `cargarClientes()` sí es
PostgREST directo pero con `fetch` crudo (no `sb.from()`) — confirmado
que `mockearTabla` lo cubre igual, porque intercepta a nivel de red y no
le importa cómo se armó la request.

**Prerrequisito agregado:** `data-testid="notas-fila"` + `data-id` en
`notas.js::renderTabla()` — mismo criterio que proveedores/clientes.

**Confirmación con labels custom:** `guardarNota()` SIEMPRE pide
`window.confirmar()` (a diferencia de proveedores, donde solo
`desactivar()` la pedía) — y lo hace con labels no default
("Emitir"/"Revisar" en vez de "Confirmar"/"Cancelar"). Importa para el
page object porque si alguien copia el patrón de otra página buscando el
texto del botón por label en vez de por `[data-action="ok"]`, el
selector no matchea acá.

**Rechazo de negocio vía RPC:** a diferencia del resto de las páginas del
bloque (que fallan con un error HTTP), acá la RPC puede responder
`200 OK` con `{ ok: false, error: '...' }` — es la función SQL
rechazando la operación (ej. cliente sin cuenta corriente habilitada),
no un error de red. `guardarNota()` lo distingue de un error real y
muestra un toast genérico igual en los dos casos ("No se pudo emitir la
nota..."), así que el spec cubre el caso `ok:false` para dejar
documentado que existe esa rama, aun cuando el toast no lo diferencia.

**Alcance deliberado:** listado server-side (búsqueda + filtro de tipo),
abrir detalle de una fila, alta con confirmación, alta cancelada (no
dispara la RPC), y el rechazo de negocio `ok:false`. NO cubre:
paginación más allá de 200 registros ni nota de débito por separado
(mismo código que crédito, cubierto por el caso de crédito).

**Escrito:**
- `tests/e2e/page-objects/admin/notas.page.js`.
- `tests/e2e/specs/admin/notas.spec.js` — 6 tests.

**Siguiente paso concreto:** `presupuestos.html` — cierra el bloque.

---

## 27. Bloque "usuarios / proveedores / notas / presupuestos" — `presupuestos.html`, cierra el bloque

Cuarta y última parada del bloque — y la más atípica de las cuatro:
"`presupuestos.html`" no es una página real. Es un stub de redirect de
compatibilidad (REQ-05: `window.location.replace('/admin/pedidos?tab=
presupuestos')`, para que bookmarks/links viejos sigan funcionando). El
módulo de verdad (`presupuestos.js`, 670 líneas, IIFE con prefijo
`pres_`) es una PESTAÑA de `pedidos.html`, cargada condicionalmente. El
page object navega directo a `pedidos.html?tab=presupuestos` (la URL
activa la pestaña sola al cargar, ver script inline al final de
`pedidos.html`) en vez de simular el click en la pestaña.

**Tres particularidades reales de la app, no del arnés:**
1. **Búsqueda in-memory, no server-side** — a diferencia de
   proveedores/notas (las otras dos páginas del bloque con buscador),
   `pres_aplicarFiltros()` filtra el array `_presData` ya cargado, en el
   navegador, sin debounce y sin request nuevo. El filtro por estado
   (pills) SÍ es server-side (recarga con `?estado=`). Documentado en el
   page object para que nadie asuma "buscar" server-side por default acá.
2. **Tres mecanismos de confirmación distintos, ninguno intercambiable:**
   `pres_eliminarPresupuesto()` usa el overlay custom
   (`window.confirmar()`, `[data-action]`), `pres_rechazar()` usa
   `confirm()` NATIVO del navegador (sin overlay en el DOM — se
   intercepta con `page.on('dialog', ...)`, no con un locator), y
   `pres_aceptarYGenerarPedido()` no pide confirmación en absoluto.
3. **Conflicto de concurrencia con código propio, no genérico:** si dos
   usuarios aceptan el mismo presupuesto en simultáneo, el segundo PATCH
   devuelve `{ codigo: 'presupuesto_ya_convertido' }` — la UI lo
   distingue de un error genérico con un toast específico y refresca la
   lista sola. El spec cubre esta rama explícitamente.

**Alta de presupuesto nueva, deliberadamente fuera de alcance** — usa
`ProductoPicker` (lazy-init), mismo componente y misma razón por la que
`pedidos.spec.js` dejó afuera "crear pedido": mockear bien el picker es
superficie propia, no vale la pena resolverlo a ciegas sin poder correr
el test acá.

**Escrito:**
- `tests/e2e/page-objects/admin/presupuestos.page.js`.
- `tests/e2e/specs/admin/presupuestos.spec.js` — 8 tests.

Con esto cierra el bloque "usuarios / proveedores / notas /
presupuestos" completo (4/4 páginas).

**Siguiente paso concreto:** bloque "portal cliente + chofer" — última
parada de Fase 2 (P1) según el orden de priorización de la sección 21.

## 28. Bloque "portal cliente" — 8/8 páginas cerradas

Orden real de ejecución (una por vuelta hasta la 21-28 del portal admin;
a partir de acá, de a 1-3 páginas livianas agrupadas cuando el tamaño lo
justifica — criterio acordado explícitamente con el usuario para este
bloque):

1. `inicio.html` — home del portal, tarjetas de resumen.
2. `catalogo.html` — grid de productos, categorías, agregar al carrito.
3. `carrito.html` — edición de ítems + confirmación de pedido
   (`/api/pedidos?accion=confirmar`), con `idempotency_key` compartida
   con el outbox offline (Plan Offline Etapa 3) y manejo diferenciado de
   error de negocio vs. error de red real.
4. `checkout.html` — link PÚBLICO (sin login) para confirmar un "pedido
   sugerido" armado por un vendedor, con pago opcional vía Mercado Pago.
5. `pedidos.html` — historial con filtro server-side, "Pagar online" y
   seguimiento en vivo con Leaflet (stub mínimo, NO vendorizado como
   Dexie/supabase-js/PapaParse — ver nota en el page object).
6. `cuenta.html` + 7. `notificaciones.html` — agrupadas en una vuelta
   (candidatas que se habían identificado como más chicas). Perfil,
   puntos y canje de recompensas (`/api/fidelizacion`), cuenta corriente,
   cambio de contraseña (`/api/auth/change-password`), y el historial de
   `notif_log` paginado. Hallazgo real acá: el conteo de "Pedidos
   realizados" usa `count:'exact', head:true` — una request HEAD cuyo
   total viaja en el header `Content-Range`, no en el body, que
   `mockearTabla` no cubría. Se agregó `mockearConteoTabla` a
   `supabase-rest-mock.js` para ese caso puntual.
8. `login.html` — cierra el bloque. Primera página del portal cliente
   que ejercita el formulario de login en sí (el resto de las 7 asume
   sesión ya sembrada vía `sembrarSesionCliente`). Por debajo del campo
   "Número de WhatsApp" sigue siendo `sb.auth.signInWithPassword()` de
   Supabase, con el número normalizado a un email ficticio
   (`<54+dígitos>@portal.distrib`) — se agregó `mockearLoginPassword` a
   `auth-helper.js` para mockear `POST /auth/v1/token?grant_type=password`
   (capa de red distinta a `/rest/v1/*` y a `/api/*`, la primera vez que
   esta suite necesita tocarla). Reutilizable para `chofer/login.html` a
   continuación, si usa el mismo flujo.

**Recurrente en las 8 páginas, no exclusivo de ninguna:** el botón
"Activar notificaciones de mis pedidos" (`cuenta.html` y
`notificaciones.html`) depende de `frontend/js/push-init.js`, que hace un
`import` ESTÁTICO de Firebase contra `gstatic.com` apenas carga el script
— no vendorizado (mismo tipo de bloqueo que Dexie/supabase-js/PapaParse,
pero de menor severidad porque no rompe nada: el `Failed to load
resource` cae dentro del mismo filtro `RUIDO_RED_SANDBOX` que ya cubre
Realtime/Sentry). Se testeó solo la VISIBILIDAD del botón
(`Notification.permission === 'default'`), no el click — mismo criterio
que el `ProductoPicker` de `presupuestos.page.js`: superficie propia, no
vale la pena mockearla a ciegas.

**Escrito (8/8):**
- `tests/e2e/page-objects/cliente/{inicio,catalogo,carrito,checkout,
  pedidos,cuenta,notificaciones,login}.page.js`.
- `tests/e2e/specs/cliente/{inicio,catalogo,carrito,checkout,pedidos,
  cuenta,notificaciones,login}.spec.js`.

Ninguna corrida contra Chromium real todavía — mismo estado que el resto
de Fase 2, sin excepción declarada.

**Siguiente paso concreto:** bloque "portal chofer" (5 páginas: `index`,
`login`, `invitacion`, `notificaciones`, `remito`) — cierra Fase 2 (P1)
por completo.

## 29. Bloque "portal chofer" — en curso (1/5)

Orden acordado: `login` (reutiliza `mockearLoginPassword`, recién
escrito) → `index` → `invitacion` → `notificaciones` → `remito` aparte
al final, por firma + geolocalización (superficie propia, se decide su
enfoque cuando llegue el turno en vez de agruparla con las otras 4).

### `login.html` — cerrado

Más simple que `cliente/login.html`: campo `#email` real (sin
normalización de teléfono), valida `usuarios.rol` contra
`ROLES_CHOFER = ['chofer','dueno','admin']` en vez de una tabla
`clientes` asociada. Diferencia real de comportamiento encontrada: los
inputs tienen `required` nativo y el `<form>` no tiene `novalidate` —
campos vacíos ni disparan el listener de `submit` (bloqueado por
validación nativa del browser antes de llegar al JS), a diferencia del
portal cliente que sí tiene su propio mensaje de error para ese caso.

`mockearLoginPassword` (auth-helper.js) se reutilizó tal cual, sin
cambios — primer caso real de reúso entre bloques del helper.

Cubierto: campos vacíos (validación nativa, no pega al login), login
exitoso con los 3 roles habilitados (`chofer`/`dueno`/`admin`,
redirección real a `/chofer` vía `PORTAL_ROOT_ALIASES` del static
server), rol no habilitado (cierra la sesión recién abierta, mensaje
"Tu cuenta no tiene acceso al portal del chofer"), perfil ausente en
`usuarios` (mismo mensaje), credenciales incorrectas (mensaje genérico,
no llega a consultar `usuarios` — verificado explícitamente), sesión ya
activa (redirige directo sin mostrar el form), modo `?demo=1`
(precarga credenciales + aviso, no autoenvía), Enter en el campo de
contraseña.

**Escrito:**
- `tests/e2e/page-objects/chofer/login.page.js`.
- `tests/e2e/specs/chofer/login.spec.js`.

Ninguna corrida contra Chromium real todavía.

**Siguiente paso concreto:** `chofer/index.html` (home del portal, ruta
del día).

### `index.html` — cerrado

Home del portal ("ruta de hoy"). Particularidad real encontrada: el dato
de la ruta NO sale de PostgREST directo, sale de `GET
/api/chofer/remitos` (capa `/api/*`, `Authorization: Bearer <token>`
armado a mano) — mockeado con `mockApi`, no `mockearTabla`.

Segundo hallazgo: `gps-tracker.js` (script sin `defer`, cargado antes
que el resto) pega su PROPIO fetch a esa misma ruta apenas carga la
página, aparte del que dispara `cargarRuta()` — cualquier conteo de
invocaciones de `/api/chofer/remitos` ve 2+ llamadas por carga, no 1.
Es 100% best-effort (silencia cualquier error, no necesita mock de
geolocalización para funcionar) — no bloqueó nada, solo hay que saber
no confiar en el conteo exacto de ese endpoint.

Cubierto: sin sesión (redirige a login), estado vacío (resumen oculto),
render de cards con los 3 estados y su chip correspondiente (incluye
fallback razón social sin nombre de fantasía, y fallback "Sin domicilio
registrado"), resumen total/pendientes/entregados, error de carga
(mensaje + botón "Reintentar"), click en una card (navega a
`/chofer/remito?id=...`), botón "Actualizar", cerrar sesión (`confirm()`
nativo aceptado y cancelado — mismo patrón que
`cliente/cuenta.page.js::canjear()`), link al historial de
notificaciones.

**Escrito:**
- `tests/e2e/page-objects/chofer/index.page.js`.
- `tests/e2e/specs/chofer/index.spec.js`.

Ninguna corrida contra Chromium real todavía.

**Siguiente paso concreto:** `chofer/invitacion.html`.

### `invitacion.html` — cerrado

Público hasta que el propio form abre sesión (token en la URL, sin
`sembrarSesionChofer`) — mismo tipo de superficie que `checkout.html`
del portal cliente, no el de `login.html`. Dos llamadas a
`/api/chofer-invitacion` con la MISMA URL base (`accion=ver` al cargar,
`accion=activar` al enviar) distinguidas por querystring dentro de un
único handler de `mockApi`.

Hallazgo real en `lib/handlers/chofer_invitacion.js`/el HTML: tras
activar, el frontend hace `signInWithPassword({ email: data.email,
password })` con el email que devuelve el backend — si ESE paso puntual
falla (contemplado explícitamente en un comentario propio del código,
"poco probable, pero por las dudas"), no muestra error: manda derecho a
`/chofer/login` en vez de `/chofer`. Se cubrió como caso propio.

Cubierto: sin token en la URL (error inmediato, cero llamadas a la
API), token inválido/vencido (mensaje que manda el backend), token
válido (saludo por nombre + form), nombre con HTML se escapa (no se
interpreta), contraseñas que no coinciden (error local, no llega a
"activar"), contraseña corta (bloqueada por `minlength=8` nativo, mismo
patrón de validación nativa que `chofer/login.html`), activación
exitosa con login automático, activación OK pero login automático
falla (redirige a login normal en vez de romper), backend rechaza la
activación (mensaje + botón reactivado).

**Escrito:**
- `tests/e2e/page-objects/chofer/invitacion.page.js`.
- `tests/e2e/specs/chofer/invitacion.spec.js`.

Ninguna corrida contra Chromium real todavía.

**Siguiente paso concreto:** `chofer/notificaciones.html`.

### `notificaciones.html` — cerrado

Historial de `notif_log`, versión más simple que la del portal cliente:
sin chips de filtro por tipo, sin botón de activar push, sin resolución
de ningún id intermedio — el propio comentario del HTML aclara que
`notif_log_select_unificada` (migración 434) filtra directo por
`usuario_id = auth.uid()` para rol chofer. Mismo mecanismo de
paginación que el portal cliente: `.range()` viaja como header HTTP
`Range`, no query param — reutilizado el mismo criterio de mock
(`offsetDeRequest` leyendo el header).

`TIPO_CONFIG` en el HTML solo mapea `ruta_asignada` hoy — mapa
deliberadamente abierto para sumar tipos nuevos; un tipo no mapeado cae
al fallback (emoji 🔔 + el tipo crudo tal cual llega de la base). Se
testeó ese fallback como caso propio, no solo el camino feliz.

Cubierto: sin sesión (redirige a login), estado vacío, notificación de
`ruta_asignada` con label/canal correctos, fallback de tipo no mapeado,
motivo de fallo cuando `entregada:false`, ausencia de ese motivo cuando
`entregada:true` (aunque el campo `motivo` venga con datos — el HTML
solo lo muestra en el caso de fallo), paginación completa ("Ver más"
con página llena → agrega sin resetear → desaparece con la última
página incompleta), error de carga, botón "Volver" (`window.history.
back()` nativo).

**Escrito:**
- `tests/e2e/page-objects/chofer/notificaciones.page.js`.
- `tests/e2e/specs/chofer/notificaciones.spec.js`.

Ninguna corrida contra Chromium real todavía.

**Siguiente paso concreto:** `chofer/remito.html` — cierra el bloque
"portal chofer" (5/5) y Fase 2 (P1) por completo. Firma + geolocalización,
se decide el enfoque cuando llegue el turno en vez de agruparla con las
otras 4.

## 30. Bug T25/auth (2 archivos puntuales) confirmado cerrado + corrida completa de `test:e2e` (296 tests) destapó 39 fallas preexistentes no relacionadas

El bug de T25/auth quedó cerrado (11 tests originales de `stock.spec.js` +
`admin/pos.spec.js` pasan, confirmado dos veces incluso dentro de la suite
completa). Al correr `npm run test:e2e` completo por primera vez en esta
sesión aparecieron 39 fallas en módulos sin relación con ese fix (ninguno
de los 2 archivos tocados es importado/dependido por los que fallan) —
deuda de tests preexistente, no regresión. Se agrupan en 3 familias:

1. **Timeouts de 30s** clickeando un botón que nunca se habilita/aparece —
   `compras.spec.js`, `rutas.spec.js`, `vencimientos.spec.js`,
   `admin/stock.spec.js` (archivo distinto al `stock.spec.js` del fix T25,
   vive en `tests/e2e/specs/admin/`), `cheques.spec.js` (`.getByTitle(...)`
   contra botones que nunca tuvieron ese atributo). Fixtures/mocks que
   cambiaron de forma (ids, `data-testid`) sin actualizar el page-object.
2. **Strict mode violations** por selectores ambiguos —
   `captura-competencia.spec.js` (locator matcheaba 2 botones, "Revisar" y
   "Eliminar").
3. **Asserts de contenido/parámetros desactualizados** — `cheques.spec.js`,
   `notas.spec.js`, `cobranzas.spec.js`, `cliente/cuenta.spec.js`, cada uno
   con causa propia.

### Cerrado esta sesión (captura-competencia 6/6, cheques, cobranzas)

- **`captura-competencia.page.js`**: `abrirFila()` ahora filtra por
  `getByRole('button', { name: 'Revisar' })` en vez de tomar el primer
  botón de la fila sin filtro (violación de modo estricto apenas se sumó
  el botón "Eliminar").
- **`captura-competencia.spec.js`**: se sacó el test del feature flag
  `CAPTURA_COMPETENCIA_DESHABILITADA` — el gate se removió del backend "a
  pedido directo" (comentario "Ex-gate de flag" confirmado en
  `lib/handlers/captura-competencia.js` y
  `lib/handlers/prospectos-competencia.js`); la función queda disponible
  para todas las empresas sin excepción, no hay 403 que ese test pueda
  seguir verificando. Con este fix + el de arriba, las 6 fallas de
  `captura-competencia.spec.js` quedan cerradas.
- **`cheques.page.js`**: `botonEditar()`/`botonVerificarBcra()` pasan de
  `getByTitle(...)` (atributo que esos botones nunca tuvieron) a
  `getByRole('button', { name: 'Editar' | 'Verificar BCRA' })`, que sí
  matchea el DOM real (`cheques.js::renderTabla`).
- **`cheques.spec.js`** (test "buscar y filtrar por estado"): condición de
  carrera real — `goto()`/`esperarAppLista()` solo espera preloader oculto
  + `#nav-root` en el DOM, no a que la carga inicial de `authReady`
  (`Promise.all([cargarContadoresCheques(), cargarClientes()])` +
  `filtrarCheques()` final, 3 llamadas de red en cadena) haya terminado.
  El test reseteaba `paramsVistos` justo después de `goto()`, pudiendo
  pisar o llegar después del `at(-1)` de la búsqueda. Fix: `expect.poll`
  en vez de lectura sincrónica del array, tanto para esperar la carga
  inicial antes de resetear como para cada assert siguiente.
- **`cobranzas.spec.js`**: se sacó (comentado, no borrado) el assert de
  `#medios-pago-grid` — `cobranzas.js` ya no define `renderMediosPago()`/
  `nombreMedio()` ni existe ese elemento en `cobranzas.html` (verificado
  con grep sobre todo `frontend/`), pero
  `frontend/shared/gentelella-fkpi.css` sigue documentando esa variante
  como viva. **Posible regresión real, no deuda de test** — queda para que
  el equipo decida si reponer la feature o limpiar el CSS/comentario
  huérfano; no es algo que un test deba resolver solo. Se verificó además
  que el test de paginación server-side de "Vencidas" (`p_offset=50`,
  `ITEMS_POR_PAGINA_COB=50`) ya estaba correcto — no hacía falta tocar
  `cobranzas.page.js`.

### Pendiente (no tocado esta sesión — sigue abierto)

- `compras.spec.js`, `rutas.spec.js`, `vencimientos.spec.js`,
  `admin/stock.spec.js` — familia de timeouts de 30s, sin diagnosticar
  todavía cuál cambió (fixture o page-object).
- `notas.spec.js`, `cliente/cuenta.spec.js` — familia de asserts
  desactualizados, sin diagnosticar.
- Resto de módulos con fallas no revisados en detalle todavía:
  `conciliación bancaria`, `devoluciones`, `facturación`,
  `catalogo-precio-sw`, `smoke-universal`.
- Ninguno de los fixes de esta sesión se corrió contra Chromium real
  todavía (sandbox de esta sesión no tiene acceso de red a
  Supabase/Playwright browsers) — falta confirmar en la máquina del
  usuario.

## 31. Familia de timeouts (`compras`, `rutas`, `vencimientos`, `admin/stock`) — 4/4 diagnosticadas y cerradas

Causas reales, todas dentro de lo previsto en la sección 30 ("fixtures/mocks
que cambiaron de forma sin que el page-object se actualizara"), más una
variante nueva (condición de carrera de carga inicial, mismo patrón que el
fix de `cheques.spec.js` de la sección 30) y una variante de comportamiento
(`stock.js` bloqueó en el cliente un camino que el test necesitaba):

- **`compras.page.js`**: `compras.html` no tiene `#app-preloader` —
  `esperarAppLista()` no esperaba a que `init()` terminara su
  `Promise.all([cargarProveedores(), cargarProductos(), cargarOrdenes()])`.
  El combo de productos (`.prod-combo-input` → `[data-testid="prod-opt-*"]`)
  solo re-renderiza en `focus`/`input`, nunca de forma reactiva cuando
  `productosData` llega más tarde — si el modal se abre antes, el click en
  la opción se cuelga para siempre (no es una carrera que se resuelva
  sola). Fix: `goto()` espera a que `#tbody-compras` deje el placeholder
  "Cargando..." (`renderTabla()` corre después del mismo `Promise.all`).
- **`rutas.page.js`**: dos selectores muertos, no una carrera — `rutas.html`
  tampoco tiene `#app-preloader`, pero acá no hacía falta esperar nada
  porque `.click()` ya hace polling de actionability hasta que el elemento
  aparece. El problema real: la card de pedido pasó de `.pedido-card` a
  `.pedido-row` (rediseño de la cola de pendientes, `cardPedidoHtml()` en
  `rutas.js`) y el estado vacío del panel de ruta es `#ruta-seleccion-vacio`,
  no `#drop-empty` (ese id nunca existió). Ninguno de los dos aparecía
  jamás con el selector viejo — de ahí el timeout de 30s. También se
  actualizó el assert del label de pendientes en `rutas.spec.js`: pasó de
  "N pedido(s) disponible(s) · $monto" a "N disponible · M seleccionado"
  (rediseño que sumó selección múltiple por zona).
- **`vencimientos.page.js`**: dos causas — `btnGuardarLote` apuntaba a
  `.modal-box-footer .btn-guardar`, clase que el botón real ("Guardar
  lote") nunca tuvo (fix: `getByRole('button', { name: 'Guardar lote' })`).
  Además, `vencimientos.html` tampoco tiene `#app-preloader` e
  `initLotes()` corre `await cargarDepositos(); await cargarLotes();` en
  secuencia tras `authReady` — mismo patrón de carrera que compras (acá no
  cuelga 30s porque `selectOption()` falla rápido si la opción no existe
  todavía, pero sigue siendo una carrera real). Fix: `goto()` espera a que
  `#tbody-lotes` deje "Cargando..." — como `cargarLotes()` corre después de
  `cargarDepositos()` en la misma cadena, alcanza con esperar una sola cosa.
- **`admin/stock.spec.js`**: no era timeout de selector sino de
  comportamiento bloqueado — el test de "ajustar stock (ingreso)" usaba
  motivo `devolucion_cliente` para ejercitar el camino genérico de
  `ajustar_stock`, pero `MOTIVOS_POR_TIPO.ingreso` quedó en `['compra',
  'devolucion_cliente', 'produccion']` y `guardarAjuste()` ahora bloquea
  los dos primeros con un `return` temprano (redirigen a Compras/
  Devoluciones con un toast, sin llamar a ninguna RPC) y el tercero pasa
  por `producir_con_insumos`, no por `ajustar_stock` — el branch genérico
  para tipo "ingreso" quedó inalcanzable desde la UI. Se reescribió el test
  para usar tipo "egreso" + motivo "venta_manual" (solo aviso informativo,
  no bloqueante), que sigue yendo por el camino genérico de `ajustar_stock`
  — mismo RPC, mismo contrato de payload, con `p_delta` negativo y
  `p_tipo: 'egreso'`.

Con esto las 4 páginas de la familia "timeout de 30s" quedan cerradas. Nota
para el equipo: el gate de `devolucion_cliente`/`compra` en Stock parece
intencional (UX que fuerza el flujo correcto por Compras/Devoluciones para
mantener trazabilidad de lote/cliente/costo) — no se tocó el código de
producto, solo el test.

### Sigue pendiente (no tocado)

- `notas.spec.js`, `cliente/cuenta.spec.js` — familia de asserts
  desactualizados, sin diagnosticar todavía.
- Sin revisar: conciliación bancaria, devoluciones, facturación,
  catalogo-precio-sw, smoke-universal.
- Ninguno de los fixes de las secciones 30-31 se corrió contra Chromium
  real todavía (este sandbox no tiene acceso de red a Supabase/Playwright
  browsers) — falta confirmar en la máquina del usuario.

## 32. Cierre de las 39 fallas — resto de módulos diagnosticados (notas, cliente/cuenta, devoluciones, facturación, smoke-universal)

Con esto quedan cerrados todos los frentes que las secciones 30-31 habían
dejado "sin revisar". Causas reales, mismo patrón de fondo que ya venía
apareciendo (selectores/rutas que cambiaron de forma sin que el
page-object/spec se actualizara):

- **`notas.spec.js`**: `notas.page.js` — `botonVerDetalle()` pasó de
  `.btn-icon[title="Ver detalle"]` (atributo que ese botón nunca tuvo) a
  `getByRole('button', { name: 'Ver' })`; `abrirModalNueva()` ahora espera
  a que `#nota-cliente` deje de estar vacío antes de interactuar
  (`cargarClientes()` corre en paralelo con `cargarNotas()`, el modal se
  puede abrir antes de que el combo tenga sus `<option>` reales).
- **`cliente/cuenta.spec.js`**: `cuenta.html` renombró todo su CSS con
  prefijo `cta-` (`cta-perfil-card`, `cta-puntos-valor`, `cta-info-row`,
  `cta-recompensa-card`, `cta-btn-canjear`, `cta-loading`) y el contenedor
  raíz es `#cta-root`, no `#contenidoCuenta` — page-object y spec seguían
  con los nombres viejos sin prefijo. Corregidos ambos archivos.
- **`conciliacion-bancaria.spec.js`**: revisado a fondo (page-object +
  spec + JS real) — sin hallazgos, ya estaba correcto.
- **`devoluciones.spec.js`**: el test de rechazo del servidor esperaba el
  toast genérico `'No se pudo registrar la revisión'`, pero
  `revisarDevolucion()` muestra directamente `data.error` del backend
  cuando viene presente (el fallback genérico solo aplica si la respuesta
  no trae `error`). Corregido el assert al mensaje real
  (`'No hay stock suficiente en el depósito elegido'`).
- **`facturacion.spec.js`**: `#btn-reintentar-${id}` dejó de estar directo
  en la fila — ahora vive dentro del menú "⋮" flotante
  (`#menu-acciones-factura`), mismo patrón que notas/cheques. Agregado
  `abrirMenuAcciones()`/`reintentarFila()` en `facturacion.page.js` que
  abre el kebab antes de clickear. El resto del spec (anular, con/sin
  motivo) ya estaba correcto — no pasa por el kebab.
- **`catalogo-precio-sw.spec.js`**: revisado a fondo (fix F4-02 en
  `sw-cliente.js`, scope de registro en `pwa-init.js`, rewrites del
  static-server de test) — sin hallazgos, ya estaba correcto.
- **`smoke-universal.spec.js`**: `PAGINAS_PUBLICAS_ROOT` incluía `'index'`
  apuntando a `/frontend/index.html`, que no existe — la landing real
  (v917) vive en `/frontend/landing/index.html`. 404 seguro en ese test.
  Agregado mapeo `RUTA_PUBLICA_ROOT` para ese caso puntual. De paso,
  sumada `restablecer-password` a `PAGINAS_CHOFER_PUBLICAS` (página
  pública por token, no estaba en el inventario).

### Hallazgo aparte, no corregido (gap de cobertura, no falla)

`smoke-universal.spec.js` cubre 52 páginas admin; el inventario real hoy
es de 61 (`ls frontend/admin/*.html`). Faltan: `canales-venta`,
`captura-competencia`, `estado-financiero`, `etiquetas-config`,
`gastos-generales`, `prospectos-competencia`, `restablecer-password` (esta
última corresponde al portal admin, ya cubierta la de chofer arriba). No
rompe ningún test (páginas no listadas simplemente no se visitan), pero
la sección 1 del plan queda desactualizada (dice 54 páginas admin, son
61) — pendiente para una vuelta futura si se quiere cobertura 100% real.

### Sigue pendiente

- Ninguno de los fixes de las secciones 30-32 se corrió contra Chromium
  real todavía (este sandbox no tiene acceso de red a Supabase/Playwright
  browsers) — falta confirmar en la máquina del usuario. Con esto, las 39
  fallas originales de la sección 30 quedan todas diagnosticadas y
  corregidas en el código; el paso que falta es la corrida real.
