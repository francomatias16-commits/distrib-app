# Etapa 7 — POS (venta, caja, devoluciones)

**Estado:** 🟢 Auditoría completa. 5 hallazgos: 2 de housekeeping/deuda
técnica (código), 2 de documentación de usuario, 1 ya resuelto
anteriormente (se deja registrado). Ningún fix de código nuevo requerido
en esta pasada — nada crítico abierto.

Alcance revisado: apertura/cierre de turno y arqueo, venta (multi-pago,
descuentos con PIN de supervisor, precios especiales, promociones), anular
venta, devoluciones, movimientos manuales de caja, favoritos, ventas sin
conexión (offline), contra los 5 artículos de ayuda del módulo
(`docs/ayuda/pos-*.md`).

## Hallazgo 1 — Dos migraciones con el mismo número de versión "119"
🟡 Media (housekeeping)

`supabase/migrations/119_deteccion_automatica_codigo_barras.sql` y
`supabase/migrations/119_offline_pos_sync.sql` comparten el número 119.
Cualquier herramienta que trackee migraciones aplicadas por número/orden
(o un `ORDER BY filename` asumiendo unicidad) puede tratarlas como la
misma migración o aplicarlas en un orden no determinístico. No causó
problema hasta ahora porque ambas ya están aplicadas en producción, pero
es un riesgo latente para el próximo `supabase db reset`/migración nueva.

**Sugerido:** renumerar una de las dos (ej. `119b_...`) o correrla a un
número libre, y dejar constancia en el changelog correspondiente.

## Hallazgo 2 — Migraciones 119 y 120 son "stubs" sin el SQL real
🟡 Media (deuda técnica / trazabilidad)

`119_deteccion_automatica_codigo_barras.sql` y
`120_balanza_devoluciones_promociones.sql` son solo un comentario
("ya fue aplicada a producción vía apply_migration... este archivo es el
registro local") — no contienen el `CREATE TABLE`/`CREATE FUNCTION` real.
Esto afecta específicamente:
- `fn_es_codigo_barras_valido`, `fn_productos_autodetectar_codigo`
- Tablas `devoluciones_pos`, `devoluciones_pos_items`, `promociones`
- Función `rpc_registrar_devolucion_pos` (la que ejecuta la devolución:
  valida cantidades, repone stock, registra)

**Consecuencia práctica:** si algún día hay que reconstruir la base desde
cero a partir de las migraciones versionadas en este repo, estas
tablas/funciones no se crearían. También impide auditar en el código el
detalle de cómo se evita devolver dos veces el mismo ítem (la ayuda dice
"no debería duplicarse" — no se pudo verificar la lógica exacta porque no
está versionada, solo confiar en que existe en producción).

**Sugerido:** la próxima vez que se tenga acceso a Supabase, hacer
`pg_dump` o `list_migrations`/introspección de estas funciones y tablas, y
completar estos dos archivos con el SQL real (o al menos con el `CREATE
TABLE`/`CREATE FUNCTION` actual tal como está en producción).

## Hallazgo 3 — Arqueo no consideraba movimientos manuales (ya resuelto antes de esta auditoría)
🟢 Resuelto — se deja registrado por completitud

La versión original de `cerrar_turno_caja` (migración 075) calculaba
`monto_calculado = monto_inicial + total_efectivo`, ignorando por completo
`movimientos_caja` (sangría/refuerzo/retiro final) — contradiciendo la
documentación, que dice explícitamente que el cálculo es "fondo inicial +
ventas en efectivo + ingresos manuales − egresos manuales". Se verificó
que la migración 101 (`pos_fase3`) ya corrigió esto antes de esta
auditoría: `monto_calculado = monto_inicial + total_efectivo +
neto_movimientos` (refuerzo suma, sangría/retiro_final resta). Confirmado
en el código actual de `lib/handlers/pos.js` / la función SQL vigente. No
requiere acción.

## Hallazgo 4 — Falta documentar la anulación directa de venta (admin)
🟡 Baja (documentación de usuario)

`docs/ayuda/pos-realizar-venta.md` dice, en las preguntas frecuentes:
"¿Se puede anular una venta ya confirmada? No se anula directamente; se
hace a través de una devolución." Pero existe `POST /api/pos/anular`
(`anularVentaHandler`), restringido a `dueno`/`admin`, que sí anula
directamente una venta completa (revierte stock y estado en una sola RPC
transaccional). Un admin que necesite anular una venta entera no tiene
forma de enterarse de que esa función existe, ni cuándo conviene usarla en
vez de la devolución (típicamente: error total de carga, vs. devolución
parcial de ítems específicos).

**Sugerido:** agregar un párrafo a la ayuda aclarando que dueño/admin
tienen una función de anulación total para casos excepcionales, y que la
devolución sigue siendo el camino estándar para el cajero y para
devoluciones parciales.

## Hallazgo 5 — Falta documentar el PIN de supervisor para descuentos grandes
🟡 Baja (documentación de usuario)

El backend exige PIN de supervisor cuando un descuento por línea supera un
umbral configurable (`supervisor_umbral_descuento_pct`, default 15%) —
tanto en frontend como validado de nuevo server-side. `docs/ayuda/pos-
realizar-venta.md` menciona el descuento por ítem y el descuento global
pero no dice nada sobre este control. Un cajero que se encuentra con el
pedido de PIN sin previo aviso no tiene dónde consultar qué es o a quién
pedírselo.

**Sugerido:** agregar una nota breve en la sección de descuentos.

## No se encontraron problemas en
- Apertura de turno: un solo turno abierto por caja (constraint único +
  mensaje accionable con quién lo dejó abierto), asignación automática de
  depósito si falta, cierre forzado auditable para dueño/admin.
- Venta: validación server-side de descuentos, resolución de precios
  especiales por cliente, cálculo de totales en el servidor (no confía en
  el front), multi-pago validado contra el total en la RPC, mensajes de
  error específicos y accionables (stock insuficiente, pagos no coinciden,
  turno cerrado, límite de crédito).
- Ventas offline: `local_id` autoincremental de IndexedDB usado como
  `offline_local_id`, index único en base para deduplicar, reintentos con
  tope y marcado de error permanente, sincronización FIFO.
- Devoluciones: acotadas a dueño/admin, validan que la venta no esté
  anulada, delegan a una RPC única.
- Movimientos de caja y favoritos: multi-tenant correctamente acotado
  (`empresa_id` en cada query), turno debe estar abierto para registrar
  movimientos.
- Seguridad: `rpc_registrar_devolucion_pos` y funciones relacionadas ya
  fueron revocadas de `anon`/`authenticated` y acotadas a `service_role`
  en una etapa anterior de la auditoría de seguridad (migración 143) —
  verificado que sigue vigente.

## Pendiente
Ningún fix de código pendiente de deploy generado en esta etapa (los
hallazgos 1 y 2 son de housekeeping de migraciones, no requieren
`git push` — se resuelven directo contra el repo/Supabase; los hallazgos 4
y 5 son solo documentación).
