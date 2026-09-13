# v1085 — Cierre de 1.3, 1.5, 2.2 y 2.3 de PLAN_UIUX_OPTIMIZACION_TOTAL.md

Continuación directa de v1084 (que dejó 1.3 a mitad de camino, y 1.5/2.2/2.3
sin empezar). Ver Addendum 3 y 4 del plan para el detalle completo.

## 1.3 — Promover `.tabla-wrap` border/overflow-x al canónico

`border: 1px solid rgba(0,0,0,.07); overflow-x: auto;` movido a
`.tabla-wrap` en `frontend/shared/componentes-admin.css` — antes cada
página que lo necesitaba lo declaraba suelto e idéntico
(`clientes.css`, `facturacion.css`, `pedidos.css`, `stock.css`).

`clientes.css` es el único caso con personalización real, tratado con
cuidado por el conflicto de especificidad ya documentado en la sesión
anterior: se conservó `border-color: var(--color-border-soft) !important`
en `#vista-clientes .tabla-wrap` (sigue ganando, sin cambios) y el
`box-shadow` propio de la sección de ajustes visuales; se retiraron los
`border`/`border-radius` que quedaban redundantes una vez promovidos al
canónico.

## 1.5 — `robots.txt`/`sitemap.xml`

No fue necesario ningún cambio: el repo ya tiene `frontend/robots.txt` y
`frontend/sitemap.xml` apuntando a `fluxoapp.com.ar` (dominio real
confirmado en otro frente del proyecto), cableados en `vercel.json`. El
plan lo daba por bloqueado con información desactualizada — mismo patrón
que el caso de `canales-venta.html` en la sesión anterior.

## 2.2 — `audit-accesibilidad.js` extendido a admin autenticado

`scripts/audit-accesibilidad.js` reescrito: agrega auditoría de las 46
páginas admin (mismo inventario que `PAGINAS_ADMIN_CON_SESION` de
`audit-mobile.js`), usando sesión mockeada
(`vendorizarDexie`/`vendorizarSupabase` + mocks REST/API +
`loguearComoAdmin`, nunca contra Supabase real). Flags nuevos
`--solo-publicas`/`--solo-admin`.

Corrido de verdad contra el proyecto (se instalaron `playwright-core` +
`axe-core` en este sandbox para poder ejecutarlo): **53 páginas, 0 errores
de carga, 216 violaciones reales** — ver
`AUDITORIA_2026/reporte-accesibilidad.json`. Principales:
`region`/`aria-allowed-role` (falta de landmarks, transversal — probable
causa raíz en el layout compartido de nav/topbar), `color-contrast` (39) y
`select-name` (29, selects de filtro sin label). **No se corrigió nada de
esto en esta pasada** — 2.2 era extender la cobertura del audit, no
remediar lo que encuentra; queda anotado como candidato a fase propia.

## 2.3 — Alcance real de `audit-lighthouse.js`

Confirmado (no solo leído — corrido de verdad instalando
`lighthouse`/`chrome-launcher`): cubre únicamente 4 páginas públicas
(Landing, Registro, Privacidad, Login admin sin sesión). No cubre ninguna
página admin autenticada. El checklist solo pedía confirmar esto, no
ampliarlo — sin cambios de código.

## Verificación

- `node scripts/check-shared-selectors.js`: OK
- `node scripts/check-fonts-wiring.js`: OK
- `node scripts/check-asset-wiring.js`: OK (87 páginas, 1982 refs, 0 rotas)
- `node scripts/check-api-wiring.js`: OK
- `node scripts/check-handler-dispatch.js`: OK
- `node --check` en los JS tocados: OK

## No incluido en esta entrega

- **0.3** — sigue bloqueado: no hay forma de leer/cerrar Issues reales
  desde este entorno (ver Addendum 5).
- Remediación de los 216 hallazgos de accesibilidad detectados por 2.2:
  fuera de alcance de este ítem, queda como trabajo nuevo pendiente de
  decisión (fase propia o incorporado a otro plan).

## Addendum 5 — consolidación contra el repo real (2026-09-13)

Conectado el repo real (`francomatias16-commits/distrib-app`) se confirmó
lo que este plan venía sospechando: **nada de lo dado por "cerrado" en las
sesiones anteriores había llegado a GitHub.** Todo quedó atrapado en ZIPs
de sandbox. Verificado línea por línea contra `main` antes de este commit:

- 0.2 era falso: `audit-mobile.js`/`audit-breakpoints.js` reales seguían
  con `import { chromium } from 'playwright'` (paquete completo).
- 2.1 nunca llegó: `scripts/check-fonts-wiring.js` no existía.
- 1.2 nunca llegó: `finanzas.css` real todavía tenía las 8 ocurrencias de
  `.chip`; los 6 archivos JS de la migración `.chip → .badge-estado`
  tampoco estaban aplicados.
- 1.3 nunca llegó: `componentes-admin.css` real no tenía el `border`/
  `overflow-x` promovido.
- `scheduled-audits.yml` real no tenía el paso "Install Playwright
  browsers" (0.1) ni corría `audit:breakpoints` (0.4) — a diferencia de lo
  que este documento daba por cerrado.
- **Hallazgo nuevo, no detectado en ninguna sesión de sandbox anterior:**
  1.1 tampoco estaba completo ni en el propio ZIP de sandbox más reciente.
  `automatizacion.js` sí tenía los `data-label` agregados, pero
  `automatizacion.html` seguía con `tabla-card`/`tabla-base` (el patrón
  viejo) en las dos tablas (reglas y tareas) — la migración de HTML nunca
  se había hecho, ni siquiera en sandbox.

Este commit consolida en un solo paquete, verificado contra el código real
del repo (no contra un export viejo): **0.1, 0.2, 1.1 (HTML + JS), 1.2,
1.3, 2.1 y 2.2**, más el paso `audit:breakpoints` agregado a
`scheduled-audits.yml` (0.4 corría en sandbox pero nunca estaba cableado a
CI). Verificación repetida contra el repo real antes de este commit:
`check-shared-selectors`, `check-fonts-wiring`, `check-asset-wiring`
(87 páginas, 1982 refs, 0 rotas), `check-api-wiring`, `check-handler-dispatch`
y `node --check` en todo el JS tocado — todo en verde.

0.3 (Issues de GitHub) sigue sin poder resolverse desde este entorno: no
hay conector de GitHub disponible para leer/cerrar Issues reales con label
`audit-automatico`. Queda para quien tenga acceso directo al repo.
