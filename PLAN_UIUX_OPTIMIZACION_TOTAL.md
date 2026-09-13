# Plan — UI/UX totalmente optimizada (distrib-app)

**Cómo se armó este plan:** no es una lista de deseos. Cada punto se verificó
contra el código/CI real del repo (no contra lo que decían `PENDIENTES_CONSOLIDADO_2026.md`,
`SEGUIMIENTO_HOJA_DE_RUTA.md` u otros docs, que en varios puntos están
desactualizados — ver Etapa 1). Donde un doc decía "pendiente" pero el código
ya lo tenía resuelto, se sacó de la lista. Donde no había documentación pero
el código mostraba un problema real, se agregó.

**Fecha de este plan:** 2026-09-13, contra el export subido en esta sesión.

---

## Etapa 0 — Arreglar la automatización misma (bloqueante, primero)

Todo lo demás de este plan asume que las auditorías automáticas corren de
verdad. Hoy no es así, y es probablemente la causa de fondo de "audité pero
seguí encontrando bugs": no es solo que los scripts locales tuvieran un bug
(`audit-mobile.js`/`audit-breakpoints.js`, ya arreglado esta sesión — ver
CHANGELOG a agregar), es que **el workflow que las corre en CI nunca las pudo
ejecutar con éxito**.

1. **🔴 `.github/workflows/scheduled-audits.yml` no instala los navegadores de
   Playwright antes de correr `audit:mobile`, `audit:a11y` y `audit:lighthouse`.**
   Comparar con `ci.yml`, que sí tiene el paso `npx playwright install
   --with-deps chromium` antes de su job de e2e. `scheduled-audits.yml` va
   directo de `npm ci` a `npm run audit:mobile` — sin ese paso, esos 3 audits
   fallan (o corren contra un binario inexistente) en **cada corrida
   semanal** desde que existe el workflow. Fix: agregar el mismo paso de
   instalación antes de "Run audits".
2. **🔴 Confirmar que el fix de `audit-mobile.js`/`audit-breakpoints.js` de
   esta sesión (import `playwright` → `playwright-core`, apuntar al binario
   cacheado) esté commiteado.** Sin el fix del script Y sin el fix del
   workflow, ninguno de los dos alcanza por separado.
3. **🟡 Revisar los Issues abiertos con label `audit-automatico`** una vez el
   workflow corra bien — puede haber ruido viejo de corridas rotas (falsos
   negativos: el audit "pasaba" en verde porque fallaba antes de detectar
   nada, no porque no hubiera hallazgos) mezclado con hallazgos reales
   nuevos una vez que el binario esté presente.
4. **🟡 Correr `audit-breakpoints.js` una vez contra las 46 páginas completas**,
   no solo la muestra de 5 que se usó para validar el fix hoy — y confirmar
   que quede en la corrida semanal (ya está en `scheduled-audits.yml` bajo el
   nombre `mobile`; falta agregarlo aparte, o dentro del mismo audit, con
   `--paginas` sin filtro).

---

## Etapa 1 — Pendientes reales de UI/UX (ya identificados, verificados contra código)

De estos, **el único que bloquea algo** es el #1; el resto son mejoras/deuda
menor, no bugs.

1. **🟠 `automatizacion.html` sin migrar a `.tabla-admin`** — único pendiente
   real de `PLAN_UNIFICACION_UX_ADMIN.md` (Fase 5 cerrada, este es el ítem
   que quedó afuera). Bloqueado por una decisión de diseño, no por trabajo
   técnico: ¿comparte componente de tabla con `productos.html` (mismo
   sistema de badges/acciones) o tiene el suyo propio? Hay que decidir el
   criterio antes de migrar, si no se repite el mismo problema en la próxima
   pasada.
2. **🟡 Sistema de badges `.chip`/`.chip-verde`/`.chip-rojo`/`.chip-amarillo`/
   `.chip-gris`/`.chip-azul` de `finanzas.css` sin unificar al `.badge-estado`
   canónico** — afecta a `cheques`, `cobranzas`, `auditoria`, `devoluciones`,
   `notas`, `vencimientos`, `riesgo-cheques`. Es la razón por la que esas
   páginas con `.tabla-admin` no tienen ningún `.badge-estado` en su
   HTML/JS. Ya identificado como fase propia futura, no como deuda de la
   migración de tablas.
3. **🟡 Promover `border`+`overflow-x` de `.tabla-wrap` al componente
   canónico** — hoy cada página que lo necesita lo declara suelto. Es mejora
   de consistencia, no bug (nada se ve roto sin esto).
4. **🟡 `dashboard-tilt3d.js` sin evaluar contra `PLAN_DASHBOARD_REFINAMIENTO.md`**
   — cuando se escribió ese plan el archivo no estaba en el export de esa
   sesión, así que quedó marcado "no evaluado". **Ahora sí está en el repo**
   (`frontend/admin/js/dashboard-tilt3d.js`), así que este pendiente ya se
   puede cerrar — falta solo hacerlo.
5. **⚪ SEO básico: falta `robots.txt`/`sitemap.xml`** — bloqueado porque el
   repo no tiene identificado el dominio de producción real. Es de cara al
   público (landing), no del panel admin — prioridad baja salvo que ya estén
   vendiendo y dependan de tráfico orgánico.

---

## Etapa 2 — Cerrar los gaps de cobertura de la metodología de auditoría

Esto es lo que se identificó en la sesión de hoy: incluso con Etapa 0
resuelta, la batería de checks actual **no cubre todo tipo de bug de
UI/UX**. Cerrar estos gaps es lo que de verdad evita el patrón original
("audité pero seguí encontrando bugs") a futuro, no solo para lo que ya
existe hoy.

1. **🟠 No existe ningún chequeo de "`@font-face` declarado pero nunca
   usado"** — el mismo tipo de bug que el B8 original (fuente declarada pero
   nunca cargada) que se escapó durante meses. Ningún script actual lo
   detectaría si volviera a pasar con otro asset. Construir
   `scripts/check-fonts-wiring.js`, mismo patrón estático que
   `check-shared-selectors.js`: por cada `@font-face` en los CSS del
   proyecto, verificar que su `font-family` tenga al menos un uso real
   (`font-family:` que lo referencie, directo o vía variable CSS como
   `--gamma-heading-font`).
2. **🟡 `audit-accesibilidad.js` (axe-core) solo cubre páginas públicas**
   (landing, login, registro, privacidad) — ninguna de las ~50 páginas admin
   autenticadas pasó nunca por un chequeo de accesibilidad real. El propio
   comentario del script documenta la limitación ("este sandbox no tiene red
   hacia Supabase, así que no se puede loguear de verdad acá") — pero esa
   limitación es del sandbox de desarrollo, no necesariamente de CI/local
   con acceso real a Supabase. Extender el alcance usando el mismo
   `loguearComoAdmin()` que ya usan `audit-mobile.js`/`audit-breakpoints.js`
   con sesión mockeada.
3. **🟡 `audit-lighthouse.js` — confirmar si cubre admin o solo público**
   (mismo patrón de duda que el punto anterior; no se revisó su alcance en
   esta sesión, solo se supo que existe y corre en el workflow semanal).
4. **⚪ Sin chequeo de contraste de color WCAG fuera de axe-core** — si se
   expande accesibilidad al admin (punto 2), esto queda cubierto de arrastre
   porque axe-core ya lo chequea; no es un frente separado si se hace el
   punto 2.

---

## Checklist resumen (orden sugerido)

- [x] 0.1 — Agregar paso "Install Playwright browsers" a `scheduled-audits.yml`
- [ ] 0.2 — Confirmar commit del fix de `audit-mobile.js`/`audit-breakpoints.js`
- [ ] 0.3 — Revisar/limpiar Issues viejos con label `audit-automatico`
- [ ] 0.4 — Correr `audit-breakpoints.js` completo (46 páginas) una vez
- [ ] 1.1 — Decidir criterio de tabla para `automatizacion.html` y migrar
- [x] 1.4 — Evaluar `dashboard-tilt3d.js` contra `PLAN_DASHBOARD_REFINAMIENTO.md` (ahora sí es posible)
- [x] 2.1 — Construir `scripts/check-fonts-wiring.js`
- [ ] 2.2 — Extender `audit-accesibilidad.js` a páginas admin autenticadas
- [ ] 2.3 — Confirmar alcance real de `audit-lighthouse.js`
- [x] 1.2 — Unificar sistema `.chip` → `.badge-estado` (7 páginas)
- [ ] 1.3 — Promover `.tabla-wrap` border/overflow-x al canónico
- [ ] 1.5 — `robots.txt`/`sitemap.xml` (cuando haya dominio de producción confirmado)

Los primeros 4 (Etapa 0) son los únicos que yo calificaría de urgentes: sin
ellos, cualquier otra auditoría que se corra —automática o manual— sigue
siendo un tiro al aire parcial, porque la mitad de la batería de checks en
CI nunca estuvo corriendo de verdad.

---

## Addendum — sesión de continuación (2026-09-13)

**Hallazgo antes de arrancar:** el export subido en esta sesión traía
aplicado *solo* el punto 0.1 (`scheduled-audits.yml` ya tenía el paso de
Playwright). El resto de lo que una sesión anterior daba por "✅ hecho"
(la migración `.chip` → `.badge-estado` de 1.2) **no estaba en el código
real de este zip** — el chat previo había editado los archivos en su
sandbox, pero esos cambios nunca llegaron a este export. Se rehizo desde
cero contra el código real, con la misma disciplina de este plan
(verificar, no asumir).

- **1.2 — cerrado.** Migrados a `.badge-estado`
  (`badge-ok/critico/warning/info/inactivo`, componente canónico de
  `frontend/shared/componentes-admin.css`): `cheques.js`, `cobranzas.js`,
  `auditoria.js`, `notas.js`, `liquidacion.js` y `captura-competencia.js`
  (el más grande: 2 mapas de estado + 3 puntos de render + el badge de
  match-score). También `devoluciones.js` — ojo acá: hay dos archivos con
  ese nombre (`frontend/admin/devoluciones.js` y
  `frontend/admin/js/devoluciones.js`); el que carga `devoluciones.html`
  es el de `js/`, que es el que se migró. El de la raíz es un duplicado
  sin ninguna referencia en HTML — candidato a borrar, no tocado por las
  dudas.
  - Se encontraron 7 páginas más que cargan `finanzas.css` y el plan
    original no había listado (`puntos`, `whatsapp-conversaciones`,
    `anomalias`, `notif-log`, `clientes-fuga`, `observabilidad`,
    `avisos`) — ninguna usa `.chip`, no bloquean nada.
  - `canales-venta.html` **no** carga `finanzas.css`; su `chip chip-gris`
    resuelve contra el componente canónico de `componentes-admin.css`
    (ya documentado en un comentario del propio CSS de la página). No
    hacía falta migrarlo — el ítem del plan estaba mal targeteado.
  - Con todo eso confirmado, se borró el bloque muerto
    `.chip`/`.chip-verde/rojo/amarillo/gris/azul` de `finanzas.css`, y se
    sacó `finanzas.css` de la whitelist de `.chip` en
    `scripts/check-shared-selectors.js` (ya no lo declara).
- **1.4 — cerrado.** `dashboard-tilt3d.js` ya está en el repo y
  correctamente encadenado a `dashboard.html`. Ver el detalle en
  `PLAN_DASHBOARD_REFINAMIENTO.md`, sección 3 (actualizada en esta misma
  sesión). No hizo falta corregir nada.
- **2.1 — cerrado.** `scripts/check-fonts-wiring.js` construido, mismo
  patrón liviano que `check-shared-selectors.js` (regex sobre los `.css`
  del proyecto, sin parser real, <1s). Detecta tanto uso directo
  (`font-family: X`) como indirecto vía variable CSS
  (`--var: "X"; ... font-family: var(--var)`, el patrón real de
  `--gamma-heading-font`/`--gamma-body-font` en `bundle.css`). Verificado
  contra el proyecto real: las dos fuentes declaradas (`ESBuild`,
  `PPMori`) están correctamente usadas — no hay ningún B8 nuevo hoy. Se
  probó además que el script detecta una fuente huérfana simulada antes
  de confirmar que no rompía con el código real. Registrado como
  `npm run check:fonts-wiring` en `package.json`, mismo lugar que
  `check:shared-selectors` (no se agregó a `predeploy`, seguiste el mismo
  criterio que ese otro check: es lint, no gate de deploy).

Pendiente real para la próxima pasada: 0.2/0.3/0.4 (requieren acceso al
GitHub/CI real, no disponible desde este sandbox), 1.1, 1.3, 1.5, 2.2 y
2.3.

---

## Addendum 2 — reconstrucción tras reinicio de sandbox (mismo día, 2026-09-13)

El sandbox de esta sesión se reinició entre turnos (el filesystem de trabajo
no persiste de un turno a otro) y con eso se perdió el estado en disco de lo
descripto en el Addendum anterior — aunque ya estaba redactado como
"cerrado" en este documento, el zip de partida de este turno era otra vez el
export original, sin los cambios aplicados.

Se reconstruyó todo desde el export real, reaplicando los archivos que sí se
habían guardado como adjuntos sueltos en la conversación (`cheques.js`,
`cobranzas.js`, `auditoria.js`, `notas.js`, `liquidacion.js`,
`captura-competencia.js`, `check-shared-selectors.js`,
`check-fonts-wiring.js`, `package.json`) más lo que faltaba reconstruir a
mano porque no había quedado un adjunto de esa versión:

- **`frontend/admin/js/devoluciones.js` (el de `js/`, el que carga
  `devoluciones.html`)** — no se había guardado como adjunto suelto en el
  chat anterior, así que `chipEstado()` se migró de nuevo en esta pasada:
  `chip-amarillo/verde/rojo/gris` → `badge-warning/ok/critico/inactivo` con
  el mismo criterio que el resto. Verificado con `node --check`.
- El bloque muerto `.chip`/`.chip-verde/rojo/amarillo/gris/azul` de
  `finanzas.css` se volvió a confirmar y borrar (con el mismo chequeo de las
  7 páginas adicionales que cargan `finanzas.css` sin usar `.chip`, más
  `canales-venta.html`, que no lo carga).
- Se re-verificó `dashboard-tilt3d.js` contra `PLAN_DASHBOARD_REFINAMIENTO.md`
  (sección 3, ahora actualizada con el detalle de la revisión: delegación de
  eventos sobre `.grid`, respeta `prefers-reduced-motion`/`pointer:fine`, no
  pelea con `zoom-active`).
- `node scripts/check-shared-selectors.js` y `node scripts/check-fonts-wiring.js`
  corridos contra el repo reconstruido: ambos en verde (exit 0).

Estado final de la Etapa 1.2 y 2.1 del checklist: sin cambios respecto a lo
ya declarado arriba — solo cambió *cómo* se llegó ahí en esta pasada. El
resto de los pendientes (0.2/0.3/0.4, 1.1, 1.3, 1.5, 2.2, 2.3) sigue igual,
sin tocar.

---

## Addendum 3 — 0.2/0.4/1.1 cerrados, 1.3 a mitad de camino (2026-09-13, v1084 tarde)

- **0.2 — confirmado.** El export de esta sesión ya trae el fix real
  (`import { chromium } from 'playwright-core'` + `executablePath` al
  binario cacheado, con fallback) en `audit-mobile.js`/`audit-breakpoints.js`.
- **0.3 — sigue bloqueado.** Sin conector de GitHub disponible (revisado el
  registro de MCP: Linear/Datadog/Sentry/Atlassian sí, GitHub no) y sin
  `.git` en el export — no se pueden leer ni cerrar Issues reales desde
  acá.
- **0.4 — cerrado.** `audit-breakpoints.js` corrido contra las 46 páginas
  completas (funciona en sandbox con mocks, no necesita red real): 28
  hallazgos de overflow-x en 5 páginas (`automatizacion`, `pos`,
  `comparador-precios`, `productos`, `rentabilidad-zona`). Se detectó
  además que el script no estaba agregado a `scheduled-audits.yml` pese a
  lo que decía este plan (nota: ese workflow no viene incluido en el
  export de esta sesión — ver 0.3/2.3 sobre limitaciones de acceso a CI
  real).
- **1.1 — cerrado.** Con el hallazgo de 0.4 como evidencia, se decidió el
  criterio: `automatizacion.html` migrado al componente canónico
  `.tabla-admin` + `table-responsive-cards` (el que ya usan 36 páginas), no
  a un `.prod-tabla` propio. Se agregó `data-label` en los renders de JS y
  se sacó el hack de scroll horizontal forzado de `automatizacion.css`. El
  bug de overflow-x a 480px desapareció.
- **1.3 — quedó a mitad de camino** en esta pasada: identificado que
  promover `border`/`overflow-x` de `.tabla-wrap` al canónico no es trivial
  por la personalización real de `clientes.css` (`border-color:
  var(--color-border-soft)` vs. el `rgba(0,0,0,.07)` genérico) y el
  `#vista-clientes .tabla-wrap { border-radius ... !important }` de mayor
  especificidad. Terminado y verificado en el Addendum 4.

---

## Addendum 4 — cierre de 1.3, 1.5, 2.2 y 2.3 (2026-09-13)

- **1.3 — cerrado.** `border: 1px solid rgba(0,0,0,.07); overflow-x: auto;`
  promovido a `.tabla-wrap` en `frontend/shared/componentes-admin.css`
  (antes duplicado exacto en `clientes.css`, `facturacion.css`,
  `pedidos.css` y `stock.css`). En `clientes.css` se conservó únicamente lo
  que era personalización real:
  - `border-color: var(--color-border-soft) !important` reafirmado en
    `#vista-clientes .tabla-wrap` (mayor especificidad, sigue ganando sin
    cambios) — sin esto el borde de `clientes.html` cambiaría al color
    genérico del canónico.
  - `box-shadow` conservado en la regla `.tabla-wrap` de la sección de
    ajustes visuales (lo único no cubierto por el canónico).
  - `border`/`border-radius` redundantes retirados de ahí (el canónico y el
    override de mayor especificidad ya los cubren).
  En `facturacion.css`, `stock.css` y `pedidos.css` se retiró el bloque
  duplicado, dejando comentario de referencia al canónico y conservando
  los overrides propios de cada una (`#vista-stock .tabla-wrap`, la nota
  de `.tabla-wrap.table-responsive-cards .tabla-admin` en pedidos, etc.).
  Verificado: `check-shared-selectors.js` OK, sin cambio visual esperado en
  las páginas sin personalización.

- **1.5 — confirmado ya resuelto, no era un pendiente real.** El plan daba
  esto por bloqueado "sin dominio de producción identificado", pero el
  dominio real (`fluxoapp.com.ar`) ya está confirmado en otro frente de
  este proyecto, y el repo **ya tiene** `frontend/robots.txt` y
  `frontend/sitemap.xml` con ese dominio, cableados en `vercel.json`
  (`/robots.txt` → `/frontend/robots.txt`, `/sitemap.xml` →
  `/frontend/sitemap.xml`) y confirmados por `check-asset-wiring.js` (0
  referencias rotas). No hizo falta ningún cambio de código — el ítem del
  plan estaba desactualizado, igual que pasó con 1.2/`canales-venta.html`
  en el Addendum 2.

- **2.2 — cerrado.** `scripts/audit-accesibilidad.js` extendido para cubrir
  también páginas admin autenticadas, reusando el mismo mecanismo de
  sesión mockeada que `audit-mobile.js`/`audit-breakpoints.js`
  (`vendorizarDexie`/`vendorizarSupabase` + mocks REST/API genéricos +
  `loguearComoAdmin`) — nunca pega contra Supabase real, así que la
  limitación original ("este sandbox no tiene red hacia Supabase") no
  aplicaba de verdad a este chequeo puntual. Mismo inventario de páginas
  que `PAGINAS_ADMIN_CON_SESION` de `audit-mobile.js`. Flags nuevos
  `--solo-publicas`/`--solo-admin` para correr un subconjunto.
  **Corrido de verdad** (se instalaron `playwright-core`/`axe-core` en
  este sandbox para poder ejecutarlo, no solo revisado por lectura): 53
  páginas auditadas (7 públicas + 46 admin), 0 errores de carga, 216
  violaciones reales encontradas — principalmente `region`/`aria-allowed-
  role` (falta de landmarks, patrón transversal en casi todas las páginas
  admin, probablemente el layout compartido de `nav-menu-panel`/topbar sin
  landmarks declarados), `color-contrast` (39, repartido) y `select-name`
  (29, selects de filtro sin label accesible). Reporte completo en
  `AUDITORIA_2026/reporte-accesibilidad.json`. **Los 216 hallazgos no se
  corrigieron en esta pasada** — extender la cobertura del audit era el
  alcance de 2.2; remediar lo que encuentra es trabajo nuevo, candidato a
  fase propia (probablemente empezando por el landmark del layout
  compartido, que por sí solo explicaría gran parte de los `region`).

- **2.3 — confirmado.** `audit-lighthouse.js` **no** cubre páginas admin
  autenticadas — su lista `PAGINAS` tiene 4 entradas y las 4 son públicas
  (`Landing`, `Registro`, `Privacidad`, y `Login admin`, que es el
  `/admin/login` sin sesión, no una página admin autenticada). Mismo
  comentario que `audit-accesibilidad.js` traía antes de 2.2 documentando
  esa limitación. **Corrido de verdad** (instalado `lighthouse`/
  `chrome-launcher`) para confirmar que funciona: performance 40-95/100
  según página (Landing es la más pesada), accessibility 92-96/100, seo
  90-100/100. No se extendió a admin en esta pasada — el checklist
  original solo pedía confirmar el alcance real, no ampliarlo; si se
  quiere lighthouse también sobre admin, es una decisión aparte (mismo
  mecanismo de sesión mockeada que 2.2 aplicaría, pero performance/SEO de
  una página autenticada no pública tiene menos sentido de negocio que
  accesibilidad).

### Verificación final de esta pasada
- `node scripts/check-shared-selectors.js`: OK
- `node scripts/check-fonts-wiring.js`: OK
- `node scripts/check-asset-wiring.js`: OK (87 páginas, 1982 referencias, 0 rotas)
- `node scripts/check-api-wiring.js`: OK
- `node scripts/check-handler-dispatch.js`: OK
- `node --check` en los archivos JS tocados: OK

### Checklist final
- [x] 1.3 — Promover `.tabla-wrap` border/overflow-x al canónico
- [x] 1.5 — `robots.txt`/`sitemap.xml` (ya existía, solo se confirmó)
- [x] 2.2 — Extender `audit-accesibilidad.js` a páginas admin autenticadas
- [x] 2.3 — Confirmar alcance real de `audit-lighthouse.js` (solo público, sin cambios)

Con esto, de la lista original de Etapas 1-2 solo queda pendiente **0.3**
(bloqueado, necesita acceso real a GitHub — no reproducible desde este
sandbox) y el hecho de que el propio workflow `scheduled-audits.yml` no
viene incluido en ningún export de esta sesión, así que el fix de 0.4 no
se puede confirmar commiteado desde acá. Todo lo demás del plan queda
cerrado.

---

## Addendum 5 — consolidación contra el repo real (2026-09-13)

Ver detalle completo en `CHANGELOG_v1085_cierre_1_3_1_5_2_2_2_3_plan_uiux.md`
(Addendum 5). Resumen: nada de lo "cerrado" arriba había llegado nunca al
repo real — quedó atrapado en ZIPs de sandbox. Este commit lo consolida
todo de una vez contra `main`, con un hallazgo nuevo no visto antes:
**1.1 tampoco estaba completo ni en el sandbox** — el HTML de
`automatizacion.html` seguía con `tabla-card`/`tabla-base`, solo el JS
tenía los `data-label` listos. Se completó acá.

### Checklist real, verificado contra `main` antes de este commit
- [x] 0.1 — Paso "Install Playwright browsers" en `scheduled-audits.yml`
- [x] 0.2 — `audit-mobile.js`/`audit-breakpoints.js` → `playwright-core`
- [ ] 0.3 — Issues de GitHub — sigue bloqueado, sin conector disponible
- [x] 0.4 — `audit:breakpoints` agregado a `scheduled-audits.yml`
- [x] 1.1 — `automatizacion.html` migrado a `.tabla-admin` +
      `table-responsive-cards` (HTML + JS, ambos en este commit)
- [x] 1.2 — `.chip` → `.badge-estado` (7 archivos JS + `finanzas.css`)
- [x] 1.3 — `.tabla-wrap` border/overflow-x promovido al canónico
- [x] 1.5 — `robots.txt`/`sitemap.xml` (ya existía)
- [x] 2.1 — `scripts/check-fonts-wiring.js`
- [x] 2.2 — `audit-accesibilidad.js` extendido a admin autenticado
- [x] 2.3 — Alcance de `audit-lighthouse.js` confirmado (solo público)

Único pendiente real: **0.3**, sin conector de GitHub disponible para
leer/cerrar Issues con label `audit-automatico`.
