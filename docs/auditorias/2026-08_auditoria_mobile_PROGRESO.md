# Progreso — fix de los 139 hallazgos de 2026-08_auditoria_mobile.md

**CERRADO.** Corrida final de `npm run audit:mobile` (máquina del usuario,
Windows, Node 24, Chromium de Playwright instalado): **6 hallazgos en 2
páginas**, ambos las exclusiones intencionales ya documentadas más abajo.
No queda ningún bug de layout mobile real pendiente de los 139 originales.

Progresión de las 3 corridas:
- Corrida 1 (antes de este trabajo): 139 hallazgos.
- Corrida 2 (tras agregar wrappers + data-label a las 15 páginas
  originales): 72 hallazgos en 6 páginas — causa: CSS obsoleto
  (`min-width` fijo por tabla) saboteando el modo cards en 3 páginas, y
  1 tabla de conciliacion-bancaria que había quedado sin convertir.
- Corrida 3 (tras sacar el CSS obsoleto y completar conciliacion-bancaria):
  **6 hallazgos en 2 páginas** — pos y productos, ambos por diseño.

## Los 6 hallazgos finales (esperados, no son bugs)
- `pos` → `#pos-quickbar-admin`: barra de accesos rápidos con scroll
  horizontal intencional, mismo patrón que `.dash-quick-nav`.
- `productos` → tabla de productos (5 variantes del mismo elemento: table/
  thead/tr/tbody/tr): tabla densa con checkbox, foto con zoom, donut de
  margen y columna sticky de acciones. Se dejó con scroll horizontal
  contenido en vez de convertir a cards — decisión de diseño, no bug.
  Si en algún momento se quiere pasar a cards, es trabajo de diseño aparte
  (recomendado antes de tocar el JS, por la complejidad de esas columnas).

## Segunda pasada (tras la corrida real de auditoría — resuelto)

Los 72 hallazgos eran de solo 6 páginas:

1. **reportes-financieros / reportes-stock / reportes-ventas (62 de los 72
   hallazgos)** — causa raíz real: un bloque `@media (max-width: 768px)`
   en `reportes.css`, comentado como `AUDITORIA-RESPONSIVE-ETAPA5`, forzaba
   `min-width` en píxeles fijos (640px, 460px, 820px, etc.) por cada una de
   las 12 tablas de estas 3 páginas. Ese bloque es de una fase **anterior**
   a la conversión a `table-responsive-cards` (que hicimos después) y nunca
   se borró — estaba saboteando el modo cards forzando cada tabla a un
   ancho fijo mayor al viewport. **Se eliminó el bloque completo** en
   `frontend/admin/css/reportes.css` y se bumpeó `?v=` en las 11 páginas
   que cargan ese CSS.
2. **conciliacion-bancaria (6 hallazgos, en `#tbody-movimientos`)** — a esta
   tabla nunca se le había agregado `table-responsive-cards` (quedó afuera
   sin querer cuando se hizo el resto); su wrapper (`.tabla-overflow`) solo
   tenía `overflow-x:auto` clásico. Se agregó la clase
   `table-responsive-cards` al wrapper y `data-label` a las 7 columnas
   (incluida la compleja "Candidatos / Match") en
   `frontend/admin/js/conciliacion-bancaria.js`. Se bumpeó `?v=` del JS.
3. **pos (`#pos-quickbar-admin`, 1 hallazgo) y productos (5 hallazgos)** —
   sin cambios: son las 2 exclusiones intencionales ya documentadas más
   abajo (scroll horizontal a propósito en pos; tabla densa sin cards en
   productos). El audit script las sigue marcando porque mide overflow
   crudo, no si es un bug real — coincide exactamente con lo esperado.

**Pendiente:** ya confirmado — ver corrida 3 arriba. Nada pendiente.

---

Estado histórico (antes de la corrida real): **estructuralmente resuelto,
pulido de data-label completo en todos los archivos identificados**.

## Causas raíz (6 patrones, no 139 bugs sueltos)

1. Tablas sin ningún wrapper (reportes-stock/ventas/financieros, saas-billing,
   proveedores 2ª tabla) → envueltas en `.tabla-wrap.table-responsive-cards`.
2. `.tabla-wrap` existente pero tabla intrínsecamente más ancha que el
   viewport (cc-proveedores, comparador-precios, export-contable,
   reglas-precio, rentabilidad-producto-vendedor, rentabilidad-zona) →
   se agregó `table-responsive-cards` (convierte a cards en mobile).
3. `conciliacion-bancaria`: grid sin `min-width:0` en los hijos → una sola
   línea CSS (`.layout-conciliacion > div { min-width: 0; }`) resuelve los
   16 hallazgos de esa página.
4. `.prod-tabla-wrap` (productos) y `.lotes-wrap` (conciliacion-bancaria) no
   estaban registrados en la regla global de `overflow-x:auto` de
   responsive-mobile.css → agregados.
5. `facturacion`: `.fac-tabs` sin `flex-wrap` → agregado en `@media(max-width:480px)`.
6. `pos` (`#pos-quickbar-admin`): **decisión, no bug** — es una barra de
   scroll horizontal intencional (mismo patrón que `.dash-quick-nav`,
   documentado como excepción aceptada en responsive-mobile.css). Se dejó
   sin tocar.

## Hecho
- Wrappers + clase `table-responsive-cards` en TODAS las tablas de los 15
  archivos de la auditoría (excepto productos, ver abajo).
- `data-label` agregado en JS/HTML de render de: cc-proveedores,
  comparador-precios (2 tablas), export-contable, reglas-precio,
  rentabilidad-producto-vendedor (2 tablas), rentabilidad-zona (2 tablas),
  reportes-financieros.js (3 tablas: deuda, cobranzas, margen),
  reportes-stock.js (5 tablas: stock, críticos, valorización, movimientos,
  conteos), reportes-ventas.js (4 tablas: vendedores, clientes, productos,
  zonas), saas-billing.html (4 tablas: empresas, historial de facturas del
  tenant, migraciones, eventos de negocio — render inline en `<script>`
  dentro del propio .html), proveedores.js (2ª tabla, `tabla-links-activos`).
- Cache-busting (`?v=`) bumpeado en todos los archivos CSS/JS tocados
  arriba que tienen un `<script src=...?v=...>` propio. `saas-billing.html`
  no necesita bump: su lógica está en un `<script>` inline dentro del mismo
  HTML, así que no hay archivo `.js` separado cacheado aparte — el HTML se
  sirve fresco.
- `productos.html`: **no convertida a cards a propósito** — tabla compleja
  (checkbox, avatar/foto con zoom, donut de margen, columna sticky de
  acciones). Se dejó solo con scroll horizontal contenido
  (`.prod-tabla-wrap` ahora sí tiene `overflow-x:auto` real). Técnicamente
  seguirá apareciendo en una corrida estricta del audit script porque la
  tabla en sí es más ancha que el viewport — no es un bug de layout roto,
  es una tabla densa de datos con scroll propio. Si se quiere card view acá,
  es trabajo de diseño aparte (recomendado antes de tocar el JS).

## Falta
- **Confirmar con `npm run audit:mobile`** que el conteo bajó a 0 (o a solo
  el hallazgo esperado de `productos.html`). Todo el trabajo de código de
  este documento está terminado; lo único pendiente es la verificación
  automatizada.

## Auditoría automatizada — por qué no se corrió
El script (`scripts/audit-mobile.js`) usa Playwright/Chromium contra un
servidor estático local con mocks (no pega a producción). En este entorno
de trabajo:
- `npm install` sí funcionó (490 paquetes, sin bloqueos de red).
- `npx playwright install chromium` **falló silenciosamente**: el binario
  de Chromium se descarga desde un CDN que no está en la whitelist de red
  de este sandbox (solo están habilitados npm/pypi/crates/github, no el
  CDN de Playwright). No es un problema del código ni de la auditoría en
  sí, es una restricción de este entorno puntual.
- Recomendación: correr `npm run audit:mobile` en un entorno con acceso de
  red completo (CI, tu máquina local, o un devbox) antes de pasar esto a
  producción. Si sale algo distinto de 0 hallazgos (fuera del esperado en
  `productos.html`), avisame y lo reviso.
