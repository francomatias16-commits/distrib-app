# Auditoría CRUD por tabla — Supabase (jgiquzjwoedmzwqgzubr) vs. frontend

Fecha: 2026-08-13. Alcance: las 118 tablas de `public` en el proyecto Supabase
real, cruzadas contra `lib/repos/*.js` + `lib/handlers/*.js` (backend) y
`frontend/admin/js/*.js` + `frontend/admin/*.html` (panel admin), para
determinar si cada una tiene **Alta / Baja (o anulación) / Modificación /
Deshacer** implementados de punta a punta, o solo en parte.

## Metodología

1. `Supabase:list_tables` sobre el proyecto real → 118 tablas en `public`.
2. Para cada tabla candidata a ABM manual, se ubicó el repo/handler que la
   escribe (`.from('tabla')` + `.insert/.update/.delete`, o RPC vía
   `db.rpc('...')`) y se confirmó la función expuesta.
3. Se cruzó cada función de backend contra el frontend admin: botón/acción
   que la dispara (`onclick=`, `window.xxx = async function`).
4. Las tablas técnicas (logs, colas, tokens, snapshots, junction tables
   pobladas solo por triggers/RPCs internas) se separaron aparte: por
   diseño no tienen ni deben tener ABM manual.

No se ejecutó ninguna escritura sobre la base real — todo lo de abajo es
lectura de esquema + lectura de código.

## Resumen ejecutivo

De los ~45 módulos con datos gestionables por un usuario, **41 tienen el
ciclo completo** (alta, modificación, baja/anulación y — donde corresponde
— reversión) implementado tanto en el backend como en un botón real del
panel admin. Se encontraron **4 huecos concretos**, detallados en la
sección "Hallazgos", el más importante siendo que **Categorías de
producto** solo tiene alta rápida: el backend ya soporta editar y dar de
baja pero ningún botón del frontend lo expone.

---

## 1. Maestros (catálogos base)

| Tabla | Alta | Modificar | Baja / Anular | Deshacer | Frontend |
|---|---|---|---|---|---|
| `zonas` | ✅ | ✅ | ✅ (soft, `activa=false`) | ✅ Activar | `rutas.html` → `zonas.js` |
| `depositos` | ✅ | ✅ | ✅ (soft) | ✅ Activar | `stock.html` → modal "Gestionar depósitos" (`stock.js`) |
| `listas_precios` | ✅ | ✅ | ✅ (soft) | ✅ Activar | `clientes.html` (tab "Listas de precio", migrado desde una página propia) |
| `categorias` | ⚠️ **Solo alta** | ❌ | ❌ | — | `productos.html` → modal "Nueva categoría" (alta rápida embebida en el form de producto). Ver Hallazgo 1. |
| `productos` | ✅ | ✅ | ✅ (delete real, con guarda de FK → sugiere desactivar) | ✅ (campo `activo`) | `productos.html`/`productos.js` |
| `proveedores` | ✅ | ✅ | ✅ (soft, activar/desactivar) | ✅ | `proveedores.html`/`proveedores.js` |
| `usuarios` | ✅ | ✅ | ✅ (soft, `cambiarEstado`) | ✅ Reactivar | `usuarios.html`/`usuarios.js` |
| `cliente_direcciones` | ✅ | ✅ | ✅ | — (borrado directo, no crítico) | `clientes.html` (tab Direcciones) |
| `precios_clientes` (precios especiales) | ✅ (upsert) | ✅ | ✅ | — | `clientes.html` (tab Comercial) |
| `reglas_precio` | ✅ | ✅ | ✅ | — | `reglas-precio.html`/`reglas-precio.js` |
| `promociones` | ✅ | ✅ | ✅ | — | POS → `pos.js` (`crearPromocion`/`actualizarPromocion`/`eliminarPromocion`) |
| `bloqueos_cliente` | ⚠️ **Solo automático** | — | ❌ | ❌ | Ver Hallazgo 2 — sin botón manual |

## 2. Transaccionales (venta / compra / logística)

| Tabla | Alta | Modificar | Anular/Cancelar | Deshacer | Frontend |
|---|---|---|---|---|---|
| `pedidos` + `pedido_items` | ✅ | ✅ (13 puntos de update: estado, items, etc.) | ✅ Cancelar | — (cancelación es el "deshacer") | `pedidos.html`/`pedidos.js` |
| `presupuestos` + `presupuesto_items` | ✅ | ✅ | ✅ | — | `presupuestos.html`/`presupuestos.js` |
| `facturas` | ✅ (emitir) | ✅ | ✅ Anular | — | `facturacion.html` |
| `notas_credito` + items | ✅ (crear) | — (no editable tras emitir, correcto para un doc. fiscal) | ✅ Anular (`notas.js` → RPC `anular_nota_cta_cte`) | — | `cta-cte.html`/`notas-credito.js` + `notas.html`/`notas.js` |
| `cheques` | ✅ | ✅ | ⚠️ Eliminar es DELETE real vía REST directo | ❌ | `cheques.html`/`cheques.js`. Ver Hallazgo 3. |
| `cobros` + `cobro_facturas_aplicadas` | ✅ (`registrar_cobro_completo`) | — | — | — | `cobranzas.html` |
| `cta_cte` | ✅ (asiento) | — (es un ledger, no se edita) | — | — | `cta-cte.html` (solo lectura, correcto) |
| `ordenes_compra` + items | ✅ | ✅ | ✅ Cancelar | — | `compras.html`/`compras.js` |
| `recepciones_mercaderia` | ✅ | — | — | — | `compras.html` |
| `facturas_proveedor` + items | ✅ | ✅ | ✅ | — | `cc-proveedores.html`/`cc-proveedores.js` |
| `pagos_proveedor` | ✅ | — | — | — | `cc-proveedores.html` |
| `notas_debito_proveedor` | ✅ | — | — | — | `devoluciones.html` (se generan desde ahí) |
| `lotes` | ✅ | ✅ | ✅ Dar de baja (impacta stock) | — | `lotes.html`/`lotes.js` |
| `movimientos_stock` | ✅ (ajuste manual) | — (ledger) | — | — | `stock.html` |
| `conteos_stock` | ✅ (`registrar_conteo_stock`, mismo modal que "ajuste") | — | — | — | `stock.html`. No tiene una vista propia de historial de conteos separada del log de movimientos — funcional pero mezclado. |
| `producto_insumos` (BOM) | ✅ | — (se rehace: quitar + agregar) | ✅ | — | `productos.html` (tab Receta/insumos) |
| `rutas` + `ruta_items` + `entregas` | ✅ | ✅ | ✅ | — | `rutas.html`/`rutas.js` |
| `devoluciones` + items | ✅ | ✅ (revisar) | ✅ Aprobar/Rechazar | — | `devoluciones.html` (auditada y recompactada hoy mismo) |
| `ventas_pos` + items + pagos | ✅ | — | ✅ Anular venta | — | `pos.html`/`pos.js` |
| `devoluciones_pos` + items | ✅ | — | — | — | `pos.html` |
| `turnos_caja` | ✅ Abrir | — | ✅ Cerrar (incl. cierre forzado ante conflicto) | — | `pos.html`/`pos.js` |
| `movimientos_caja` | ✅ (ingreso/egreso manual) | — | — | — | `pos.html`/`pos.js` |
| `cajas_pos` | ❌ Sin alta/edición desde UI | — | — | — | Ver Hallazgo 4 |
| `conciliacion_bancaria_lotes/movimientos` | ✅ (importar CSV) | — | ✅ Descartar/rematchear | — | `conciliacion-bancaria.html` |
| `reglas_automatizacion` | ✅ | ✅ | ✅ | ✅ Toggle activa | `automatizacion.html`/`automatizacion.js` |
| `tareas_automatizacion` | (autogenerada por reglas) | — | ✅ Completar | — | `automatizacion.html` |
| `notas_internas` | ✅ (`NotasInternas.agregar`) | — (no editable, es un log de auditoría entre usuarios, correcto) | ✅ Archivar | — | Compartido: `clientes.html`, `pedidos.html` |
| `chofer_invitaciones` | ✅ | — | — | — | `usuarios.html` (invitar chofer) |
| `reglas_liquidacion` / `ofertas_liquidacion` | ✅ (configurar reglas) | ✅ | — | — | `liquidacion.html`/`liquidacion.js` |
| `facturacion_config` | ✅ (upsert) | ✅ | — | — | `facturacion-config.html` |

## 3. Hallazgos concretos (gaps reales) — ⚠️ VER RECONCILIACIÓN 2026-08-25

**Los 4 hallazgos de abajo ya fueron atendidos en el código actual.** Reverifiqué
uno por uno contra el zip vigente antes de tocar nada de este documento:

- **Hallazgo 1 (categorías):** resuelto. Existe `abrirModalCategoriasAbm()` en
  `productos.js` — modal ABM completo (crear/editar/dar de baja/reactivar),
  disparado desde un link "(administrar)" en `productos.html` línea 557,
  mismo patrón que zonas/depósitos.
- **Hallazgo 2 (bloqueo de cliente):** resuelto **a medias**. Se agregó
  `desbloquearCliente()` en `lib/repos/clientes.js` — el comentario en el
  código cita textualmente este hallazgo ("Hallazgo AUDITORIA_CRUD_TABLAS_2026")
  — con endpoint (`POST /api/clientes?_svc=desbloquear`) y botón real
  (`btn-desbloquear`) en `clientes.js`. Lo que **no** se agregó: un botón para
  **bloquear manualmente**. Existe `bloquearCliente(empresa_id, cliente_id, motivo)`
  en `lib/repos/clientes.js`, pero sigue sin importarse en
  `lib/handlers/clientes.js` y sin ningún punto de entrada en el frontend — es
  el mismo código muerto que señalaba el hallazgo original, todavía sin usar.
  Bajar la severidad, no cerrarlo: la reversión (lo más urgente, según la
  recomendación de prioridad de este mismo documento) está resuelta; el
  bloqueo manual, no.
- **Hallazgo 3 (cheques):** resuelto. `eliminarCheque()` en `cheques.js` ya no
  hace `DELETE` real — el comentario en el código también cita este hallazgo
  explícitamente. Ahora hace `PATCH` a `estado='anulado'` (con motivo
  opcional) y existe `reactivarCheque()` como deshacer. Mismo patrón que
  facturas/notas de crédito.
- **Hallazgo 4 (cajas POS):** resuelto. `cajas.html` tiene botón "Nueva caja"
  y un modal de alta/edición que llama a `POST /api/pos/cajas-admin` con
  `accion: crear|editar|activar|desactivar`, validando depósito y nombre
  duplicado, con registro en `audit_log`.

**Recomendación de prioridad actualizada:** de los 4 puntos originales, solo
queda pendiente el bloqueo manual de cliente (segunda mitad del Hallazgo 2).
El resto puede darse por cerrado.

---

### Hallazgo 1 — Categorías de producto: falta editar/dar de baja
El backend (`lib/repos/maestros.js`, recurso `categorias`) ya soporta
`actualizarMaestro` y `eliminarMaestro` (baja lógica) exactamente igual que
zonas/depósitos/listas de precio — es el mismo endpoint genérico
`/api/maestros?recurso=categorias`. Pero el único punto de entrada en el
frontend es `abrirModalCategoriaRapida()` en `productos.js`, que solo hace
`POST` (alta). No existe ningún botón "Editar" ni "Dar de baja" para una
categoría ya creada — a diferencia de zonas/depósitos/listas de precio, que
sí tienen su tabla de gestión completa con esos dos botones.
**Impacto:** si se carga una categoría con el nombre mal escrito, no hay
forma de corregirla desde el panel — hay que hacerlo a mano en la base.

### Hallazgo 2 — Bloqueo de cliente: sin acción manual ni reversión
Existen **dos** funciones `bloquearCliente()` distintas en el repo:
- `lib/repos/cierre.js` — la que realmente se usa, llamada solo desde el
  motor automático de cierre/mora (`lib/handlers/cierre.js`).
- `lib/repos/clientes.js` — está definida pero **no la llama ningún
  handler ni ningún archivo del frontend**. Código muerto o funcionalidad
  a medio construir.

En `clientes.html` el tab "Historial" (`cargarBloqueos()`) solo **lee**
`bloqueos_cliente`; no hay botón para bloquear manualmente a un cliente,
y no existe en ningún lado del código una función de **desbloqueo**. Una
vez que el motor automático bloquea a un cliente, no hay ningún control en
la UI para revertirlo — habría que confirmarlo en vivo, pero no se
encontró ningún endpoint ni RPC de "desbloquear".
**Impacto:** riesgo operativo — un cliente bloqueado por error o tras
regularizar su deuda podría quedar bloqueado sin que el equipo tenga forma
de revertirlo desde el panel.

### Hallazgo 3 — Eliminar cheque hace DELETE real, sin registro ni deshacer
`eliminarCheque()` en `cheques.js` pega un `DELETE` directo contra
`/rest/v1/cheques` (Supabase REST), **saltándose** la capa de
repo/handler que usan el resto de las tablas financieras. A diferencia de
facturas o notas de crédito (que se **anulan**, conservando el registro),
un cheque eliminado desaparece sin dejar rastro en `audit_log` y sin
posibilidad de deshacer el borrado.
**Impacto:** para un instrumento financiero (cheque de cliente) esto es
más arriesgado que en otras tablas — lo esperable sería un estado
"anulado"/"eliminado" en vez de un borrado físico, igual que se hizo con
facturas y notas de crédito.

### Hallazgo 4 — Cajas POS (`cajas_pos`): sin alta/edición desde el panel
`cajas.html` es un dashboard de reportes (ventas por caja, alertas de
stock) — no encontré ningún `cajas.js` ni formulario que permita crear o
editar un punto de cobro físico (`cajas_pos`, hoy 2 filas). Da la
impresión de que las cajas se cargaron a mano en la base al configurar la
empresa y nunca más se tocan desde la UI.
**Impacto:** bajo en el día a día (no es una tabla que cambie seguido),
pero si un cliente abre un local nuevo o agrega una caja, hoy no hay forma
de darla de alta sin entrar a Supabase directamente.

---

## 4. Tablas técnicas/derivadas — sin ABM manual por diseño

Estas **no** deberían tener botones de alta/baja/edición en el panel — se
pueblan solo mediante triggers, RPCs internas o el propio flujo de la app.
Se listan para dejar constancia de que fueron revisadas y no son un hueco:

- **Logs/auditoría (append-only):** `audit_log`, `notif_log`, `email_log`,
  `push_log`, `saas_email_log`, `export_contable_log`, `eventos_negocio`.
- **Derivadas/calculadas:** `stock` (resultado de `movimientos_stock`),
  `alertas_stock`, `alertas_score`, `scores_cliente`, `saldo_puntos`,
  `movimientos_puntos`.
- **Colas y tokens internos:** `cola_financiera`, `api_rate_limits`,
  `refresh_tokens`, `internal_secrets`, `tokens_wsaa`,
  `pos_scanner_tokens`, `proveedor_portal_tokens`,
  `whatsapp_reset_codigos`, `asistente_acciones_pendientes`.
- **Config singleton (una fila por empresa/SaaS):** `saas_config`,
  `planes_limites`, `contadores_empresa`, `notif_prefs_auto`,
  `programas_fidelizacion`, `demo_snapshots`, `empresa_whatsapp`.
- **Migración de datos (herramienta interna, no dato de negocio):**
  `migracion_sesiones`, `migracion_staging_rows`,
  `migracion_plantillas_mapeo`, `schema_migrations_registry`.
- **WhatsApp/asistente (poblado por webhooks/IA):**
  `whatsapp_conversaciones`, `whatsapp_mensajes`,
  `asistente_conversaciones`, `asistente_mensajes`, `asistente_uso`,
  `asistente_articulos`.
- **Otras:** `carrito_items` (carrito del cliente, se vacía solo),
  `pos_favoritos`, `sugerencias_pedido`, `dispositivos_push`,
  `notificaciones_push`, `banco_codigos_producto` (banco compartido
  entre empresas, se completa solo), `comprobantes_historicos`
  (informativo, pre-migración), `anomalias_revisadas`,
  `contador_uso_apis`, `integraciones_pago`/`transacciones_pago` (0
  filas — Mercado Pago está integrado pero estas dos tablas puntuales
  no tienen escritura confirmada; si el flujo de pagos online está en
  uso valdría la pena confirmarlo aparte, no se profundizó acá).

---

## 5. Recomendación de prioridad

1. **Hallazgo 2 (bloqueo de cliente)** — el más importante: no tener forma
   de desbloquear manualmente a un cliente es un riesgo operativo real.
2. **Hallazgo 3 (eliminar cheque)** — pasar de DELETE real a un estado
   "anulado", igual que facturas/NC, para no perder historial.
3. **Hallazgo 1 (categorías)** — agregar Editar/Dar de baja reusando el
   mismo patrón que ya existe para zonas/depósitos/listas de precio (es
   la pieza de backend que menos trabajo lleva, ya está todo ahí).
4. **Hallazgo 4 (cajas POS)** — el de menor urgencia, dado el bajo
   volumen de cambios en esa tabla.
