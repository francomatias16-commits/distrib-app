# Checklist de pase manual — Auditoría de páginas (Fase 2/3/4)

**Objetivo:** confirmar en navegador real los fixes que hasta ahora solo se
verificaron con análisis estático de código. Tiempo estimado: 40-50 min.

Marcá cada ✅ a medida que lo probás. Si algo falla, anotá qué pasó
exactamente (pantalla, acción, resultado) para poder corregirlo.

---

## 0. HALLAZGO EXTRA (no estaba en el checklist original) — "No se pudo crear el acceso al portal" en /admin/clientes ✅ RESUELTO 2026-08-10

- **Síntoma:** botón "Generar acceso y mensaje WhatsApp" fallaba con 400 para
  cualquier cliente (probado con "La Esquina").
- **Causa raíz:** `db.auth.admin.listUsers()` (usado en
  `lib/handlers/clientes.js` → `crearAccesoPortal()`) hace un SELECT de toda
  la tabla `auth.users`. 6 usuarios semilla/demo (`11100000-0000-...`,
  incluyendo `exempleado@distribuidoradellitoral.com.ar`) tenían columnas de
  token (`confirmation_token`, `recovery_token`, `email_change_token_new`,
  `email_change`, etc.) en `NULL` en vez de `''`. Postgres no puede
  escanear `NULL` a string en el driver de Supabase Auth → toda la llamada
  admin.listUsers() fallaba en bloque, no solo para esos 6 usuarios.
- **Fix aplicado (SQL directo en Supabase producción, 2026-08-10):**
  `UPDATE auth.users SET confirmation_token = COALESCE(confirmation_token, ''), ...`
  para las 8 columnas de token afectadas. 0 filas con NULL después del fix.
- **Fix de código acompañante (`lib/handlers/clientes.js` línea 83):** el
  error real que devolvía Supabase se descartaba (`throw new Error('Error al
  verificar usuarios existentes')` sin incluir `listErr.message`), lo que
  hacía casi imposible diagnosticar esto por los logs. Ahora se loguea el
  mensaje real (`errorSeguro` ya se encarga de no exponerlo al navegador,
  solo mejora lo que ve el equipo en los logs de Vercel). **Pendiente
  deploy.**
- **Nota:** este fix de datos no está en ninguna migración versionada del
  repo (se aplicó directo vía SQL ejecutado por asistente). Mismo patrón de
  riesgo que PUNTOS-001/COMPRAS-001/SCORE-001 — ver sección pendiente al
  final de este documento.

## 1. F4-01 — Filtro "Borrador" en Pedidos (2 min) ✅ CONFIRMADO 2026-08-10

**Antes:** el chip decía "Pendiente" y nunca traía resultados (estado
inexistente en la base).

1. Ir a `/admin/pedidos`.
2. Mirar la fila de chips de filtro de estado (arriba de la tabla).
3. ✅ Verificar que el chip dice **"Borrador"** (no "Pendiente").
4. Hacer clic en el chip "Borrador".
5. ✅ Si hay algún pedido en estado borrador, tiene que aparecer en la
   lista. Si no hay ninguno, la lista debe quedar vacía con el mensaje de
   "sin resultados" — no debe romperse ni quedar cargando infinito.

---

## 2. F4-02 — Precio del catálogo vs. precio al confirmar (5-8 min) ⚠️ FIX APLICADO 2026-08-10, RE-PROBAR

- **Síntoma en el pase manual:** con "Supermercado La Esquina" (tiene
  precio especial $1.600 en Coca Cola 2.25L) logueado por
  `/cliente/login` real, el catálogo mostraba el precio de lista
  normal, sin tachar.
- **Causa raíz:** no era la RPC ni el dato (verificado en vivo contra
  Supabase, ambos correctos) — era `frontend/cliente/sw-cliente.js`,
  que tenía `/api/cliente/productos` en `SWR_PATTERNS` desde antes del
  fix F4-02 original. Con stale-while-revalidate el Service Worker
  servía el precio viejo cacheado y revalidaba recién en segundo
  plano. Ver `CHANGELOG_v708_fix_sw_cachea_precio_catalogo_cliente.md`.
- **Fix:** `/api/cliente/productos` movido a `NETWORK_ONLY_PATTERNS`.
- **Pendiente:** repetir los pasos 1-8 de abajo con el fix deployado.

**Antes:** el catálogo del cliente mostraba `precio_base` crudo, ignorando
precios especiales/reglas; recién al confirmar el pedido se aplicaba el
precio real.

**Necesitás:** un cliente que tenga un precio especial, una regla de
precio (volumen/zona/temporada), o una lista de precios asignada. Si no
sabés cuál usar, andá a `/admin/reglas-precio` o a la ficha del cliente en
`/admin/clientes` (tab "Comercial") para confirmar cuál tiene algo
configurado.

1. Iniciar sesión como ese cliente en el portal (`/cliente/login` o el
   link que use tu flujo de pruebas).
2. Ir a `/cliente/catalogo`.
3. Anotar el precio mostrado para un producto que sepas que tiene
   descuento/regla para ese cliente.
4. ✅ Verificar que el precio mostrado **ya es el precio con descuento**
   (no el precio de lista general). Si la corrección funciona, puede
   aparecer un precio de lista tachado junto al "Tu precio".
5. Agregar ese producto al carrito (`/cliente/carrito`).
6. ✅ Verificar que el subtotal en el carrito coincide con el precio visto
   en el catálogo (no cambia).
7. Confirmar el pedido y llegar a `checkout.html`.
8. ✅ Verificar que el total final coincide con lo que se vio en catálogo
   y carrito — no debería haber sorpresas ni diferencias.

---

## 3. F4-03 — Portal proveedor no debe mostrar OCs en borrador/pendientes de aprobar (5 min)

**Antes:** el proveedor veía órdenes de compra que el admin todavía no
había enviado ni aprobado internamente.

1. En `/admin/compras`, crear una orden de compra nueva para un
   proveedor de prueba y **dejarla en estado "Borrador"** (no enviarla).
2. Si tu flujo usa aprobación interna, crear otra y dejarla en
   "Pendiente de aprobación".
3. Abrir el link del portal de ese proveedor (`/admin/proveedores` →
   ficha del proveedor → link del portal, o `/proveedor/portal?token=...`
   si ya lo tenés a mano).
4. ✅ Verificar que **ninguna** de las OCs recién creadas (borrador /
   pendiente de aprobación) aparece en la lista del proveedor.
5. ✅ Verificar que el contador "OCs totales" y el "Total abierto" del
   portal proveedor **no** incluyen el monto de esas dos OCs.
6. Volver a `/admin/compras`, cambiar una de esas OCs a "Enviada".
7. Recargar el portal del proveedor.
8. ✅ Ahora esa OC sí debe aparecer.

---

## 4. F4-04 / Migración de stock — `cantidad_disponible` consistente (8-10 min)

**Antes:** admin (`/admin/stock`) y cliente (`/cliente/catalogo`) podían
mostrar números de stock distintos para el mismo producto, según qué
operación había tocado el stock por última vez.

**Estado real (auditado en esta sesión — no existe ninguna migración de
"columna generada"; esa frase era una premisa sin verificar, igual que
pasó con F4-01/02/03):** `stock.cantidad_disponible` se mantiene con el
trigger `trg_sync_stock_disponible` (`GREATEST(0, cantidad -
cantidad_reservada)`) cada vez que se actualiza `cantidad` o
`cantidad_reservada`, y el catálogo del cliente (RPC
`cliente_productos_disponibles`) recalcula el mismo valor en vivo en SQL,
sin depender de esa columna. Repasé el código de los 3 flujos (POS,
anulación, transferencia) y de ambas lecturas: matemáticamente deberían
coincidir siempre. No encontré un bug estático — por eso este bloque
sigue siendo importante probarlo en el navegador con datos reales. Si
encontrás una diferencia, anotá producto, depósito y los dos números
exactos (no solo "no coinciden") para poder ir directo a la causa.
Probar los 3 flujos que antes más se desincronizaban:

### 4a. Venta por POS
1. Anotar `cantidad_disponible` de un producto en `/admin/stock`.
2. Anotar el stock del mismo producto en `/cliente/catalogo` (como ese
   cliente, o revisando la API si no tenés sesión de cliente a mano).
3. Hacer una venta de ese producto por `/admin/pos` (o `/scan-pos`).
4. ✅ Recargar ambas pantallas — los dos números deben haber bajado en la
   misma cantidad, y coincidir entre sí.

### 4b. Anular una venta POS
1. Anular la venta que acabás de hacer en el paso anterior (desde el
   historial de ventas POS o donde corresponda).
2. ✅ Recargar `/admin/stock` y `/cliente/catalogo` — el stock debe volver
   al valor original en ambas pantallas.

### 4c. Transferencia entre depósitos
1. En `/admin/stock`, hacer una transferencia de stock de un producto
   entre dos depósitos.
2. ✅ Verificar que `cantidad_disponible` del depósito origen bajó y la
   del destino subió, y que el total general del producto (suma de
   ambos depósitos) es el mismo antes y después.
3. ✅ Verificar que `/cliente/catalogo` muestra el mismo total que
   `/admin/stock` después de la transferencia (no debería haber
   diferencia — antes era justamente acá donde se desincronizaban).

---

## 5. UI-003 — Modal "Zona" en Rutas no debe abrirse solo (2 min)

1. Ir a `/admin/rutas`.
2. Hacer clic en la pestaña **"Zonas"**.
3. ✅ Verificar que **no** aparece ningún modal abierto automáticamente al
   entrar a la pestaña — la pantalla debe verse limpia, sin overlay.
4. Hacer clic en el botón para crear/editar una zona.
5. ✅ Verificar que el modal se abre y se cierra normalmente con los
   botones correspondientes.

---

## 6. F3-03 — Banner "por vencer" y badge de lotes (5 min)

**Antes:** `actualizar_estado_lotes()` nunca se invocaba (badges
mostraban "Activo" para lotes vencidos/agotados) y el banner "por vencer"
siempre contaba 0.

1. Ir a `/admin/vencimientos`.
2. ✅ Si hay lotes con `fecha_vencimiento` dentro de los próximos 7 días,
   el banner de alerta "por vencer" debe mostrar un número mayor a 0 (no
   debería estar en 0 si efectivamente hay lotes por vencer).
3. Buscar un lote cuya fecha de vencimiento ya pasó.
4. ✅ Verificar que su badge dice **"Vencido"**, no "Activo".
5. Si tenés forma de dejar un lote en 0 unidades, verificar que su badge
   pasa a **"Agotado"**.

---

## 7. F3-04 — KPIs de Cobranzas se actualizan tras registrar un cobro (5 min)

**Antes:** los KPIs ("Cobrado hoy", "Vence hoy", "Total vencido", medios
de pago) quedaban con el valor viejo hasta recargar la página a mano.

1. Ir a `/admin/cobranzas`, quedarse en la pestaña **"¿A quién llamo
   hoy?"**.
2. Anotar el valor de "Cobrado hoy".
3. Sin recargar la página, hacer clic en "Cobrar" sobre una factura de la
   lista (o cambiar a la pestaña "Saldos por cliente" y registrar un
   cobro genérico ahí).
4. Completar y confirmar el cobro.
5. Volver a la pestaña "¿A quién llamo hoy?" (sin recargar la página).
6. ✅ "Cobrado hoy" debe haber subido con el monto del cobro que acabás de
   registrar, sin necesidad de F5.
7. ✅ El desglose de medios de pago también debe reflejar el nuevo cobro.
8. ✅ Si el cobro estaba vinculado a una factura puntual, esa factura debe
   desaparecer (o reducirse) de la lista de "Facturas pendientes" sin
   recargar.

---

## 8. F3-05 — Emitir una Nota de Crédito actualiza el tab "Facturas" (5 min)

**Antes:** al emitir una NC vinculada a una factura, esa factura quedaba
marcada como "Emitida" (estado viejo) en el tab "Facturas" hasta recargar
la página — con el botón "Anular" todavía disponible.

1. Ir a `/admin/facturacion`, quedarse en el tab **"Facturas"**.
2. Elegir una factura de prueba, anotar su número y verificar que su
   estado es "Emitida".
3. Sin recargar la página, cambiar al tab **"Notas de crédito"**.
4. Crear una NC nueva, vinculada a esa factura (seleccionarla en el campo
   correspondiente del formulario).
5. Guardar la NC y luego emitirla contra ARCA (o en modo manual si no hay
   config ARCA activa en el ambiente de prueba).
6. Volver al tab **"Facturas"** (sin recargar la página).
7. ✅ La factura vinculada debe aparecer ahora como **"Anulada"**, sin
   necesidad de F5.
8. Abrir el modal de detalle de esa factura.
9. ✅ El botón **"Anular" ya no debe estar disponible** (el modal debe
   mostrar solo "Ver/descargar PDF" y "Cerrar", como corresponde a una
   factura anulada).

---

## 9. UI-001 / UI-002 — Modales no se abren solos al cargar (5-8 min)

**Antes:** varios modales dependían 100% del JS para ocultarse; si el
JS tardaba o el CSS cambiaba de orden, se veían abiertos un instante (o
directamente quedaban abiertos) al entrar a la página.

No tengo en esta sesión la lista puntual de las 11 páginas de UI-002 (era
de una sesión anterior a esta carpeta de trabajo), así que probá al menos
estas, que son las que sabemos con certeza que tuvieron el fix:

1. Ir a `/admin/vencimientos` (UI-001, el bug original) — recargar la
   página 3-4 veces seguidas (Ctrl+R rápido).
2. ✅ El modal "Nuevo lote" **nunca** debe aparecer abierto solo al cargar.
3. Repetir el mismo recargado rápido en estas páginas, mirando que
   ningún modal quede abierto sin que vos lo hayas abierto:
   - `/admin/cc-proveedores`
   - `/admin/reglas-precio`
   - `/admin/fidelizacion`
   - `/admin/puntos`
   - `/admin/anomalias`
   - `/admin/notif-log`
   - `/admin/whatsapp-conversaciones`
   - `/admin/auditoria`
   - `/admin/saas-billing`
   - `/admin/rutas` (además del chequeo específico de UI-003 en §5)
4. Si encontrás algún modal abierto solo en una página que no está en
   esta lista, es un hallazgo nuevo — anotá la página exacta y el nombre
   del modal (inspeccionar elemento → `id` del div) para que lo pueda
   localizar en el código.

---

## Resumen para reportar

Al terminar, contame:
- Qué ítems marcaste ✅ sin problemas.
- Cualquier ❌: en qué paso, qué esperabas vs. qué pasó, y si es posible
  una captura de pantalla o el mensaje de error de la consola del
  navegador (F12 → Console).
