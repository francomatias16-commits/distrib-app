# CHANGELOG v304 — Auditoría 2026, etapas 13 a 18 (21 hallazgos)

Continuación de la Auditoría 2026 (00_PLAN_MAESTRO.md). Se ejecutaron los
21 hallazgos completamente documentados de las etapas 13 a 18. Las etapas
1 a 12 (~41 hallazgos) quedan pendientes: solo hay resumen de una línea
por finding, se necesitan los archivos de detalle
(01_pedidos.md … 12_riesgo_cheques.md) antes de tocar código real de
plata/stock/AFIP sobre esos.

## Backend / Supabase (aplicado directo con `apply_migration`, ya persistido)

- **Etapa 18, Hallazgo 1** — `deshacer_sesion_migracion()`: no revertía
  altas en `productos` ni `pedidos`, solo un subconjunto de entidades.
  Ahora también revierte esas dos.
- **Etapa 13, Hallazgo 2** — `registrar_movimiento_puntos()` no era
  `SECURITY DEFINER` ni validaba rol: cualquier usuario logueado de la
  empresa (incluido rol `cliente` del portal) podía acreditarse puntos
  infinitos llamando el RPC directo. Ahora es `SECURITY DEFINER`,
  revocada de `PUBLIC/anon/authenticated`, otorgada solo a `service_role`.
- **Etapa 13, Hallazgo 4** — misma función: la rama `'canje'` restaba de
  `puntos_totales`, que debe ser un contador histórico que nunca baja
  (igual que ya hacía correctamente `canjear_puntos()`). Corregido.
- **Etapa 17, Hallazgo 3** — `get_empresa_id()` y `get_rol_usuario()` no
  validaban `empresas.activa`/`empresas.saas_suspendida`, solo
  `usuarios.activo`. La suspensión SaaS por falta de pago era 100% gate
  de frontend. Ahora ambas funciones cortan el acceso a nivel de RLS
  para toda tabla que dependa de ellas (prácticamente todo el sistema).
- **Etapa 13, Hallazgo 3 (mitad backend)** — nueva función
  `sumar_saldo_puntos_fallback(p_cliente_id, p_empresa_id, p_cantidad)`,
  `SECURITY DEFINER`, solo `service_role`. Hace el `UPDATE` atómico de
  saldo vía `ON CONFLICT ... DO UPDATE SET puntos_disponibles =
  saldo_puntos.puntos_disponibles + p_cantidad` en vez de un upsert que
  pisaba el valor.

## Código (backend Node / frontend JS)

- **`lib/handlers/pedidos.js`** (etapa 13, Hallazgo 3) — el fallback que
  corre cuando falla el RPC `registrar_movimiento_puntos` hacía un
  `upsert` que PISABA `puntos_disponibles`/`puntos_totales` con el valor
  del pedido actual en vez de sumarle al saldo existente. Si un cliente
  ya tenía puntos acumulados y el RPC fallaba, el fallback le reseteaba
  el saldo. Ahora llama a `sumar_saldo_puntos_fallback()`.
- **`frontend/admin/js/migracion.js`** (etapa 18, Hallazgos 2 y 3):
  - El loop por lotes (`ejecutarLoteConfirmacion`, usado por
    `confirmarSesion()` y `reintentarFallidas()`) perdía todo el
    progreso parcial si una tanda intermedia tiraba error — el usuario
    veía "Error" sin saber cuánto sí se había confirmado. Ahora el error
    lleva `err.progresoParcial` y ambos callers lo muestran.
  - `onArchivoElegido()` no avisaba nada antes de parsear archivos
    grandes (XLSX/CSV), lo que congelaba la pestaña sin feedback. Ahora
    hay un guard de tamaño (>15MB) que avisa y deja pintar el mensaje
    antes de arrancar el parseo.
- **`frontend/admin/js/ui-utils.js`** (etapa 16, Hallazgo 1) — nuevo
  helper `window.hoyLocalISO()`: `new Date().toISOString().split('T')[0]`
  usa UTC, así que entre las 21:00 y las 00:00 hora Argentina (UTC-3) ya
  precargaba la fecha de MAÑANA en inputs de tipo date. Reemplazado en:
  - `frontend/admin/js/rutas.js` (filtro y alta de ruta)
  - `frontend/admin/js/rutas-resumen.js` (`hoyISO()`)
  - `frontend/admin/js/cheques.js` (fecha de recepción)
  - `frontend/admin/js/cta-cte.js` (fecha de cobro)
  - `frontend/admin/js/notas.js` (fecha de nota)
- **`frontend/admin/saas-billing.html`** (etapa 17, Hallazgo 1) —
  `reactivarEmpresa()`, `suspenderEmpresa()` y `cambiarPrecio()` hacían
  un `UPDATE` directo contra Supabase con el cliente del navegador,
  sujeto a RLS. Como la policy `empresas_update` solo deja tocar la
  propia empresa, el `UPDATE` afectaba 0 filas en la empresa ajena que
  el superadmin quería tocar, sin tirar error, y el toast decía
  "reactivada correctamente" de todas formas. Ahora llaman a los
  endpoints reales (`/api/saas/reactivar`, `/api/saas/suspender`,
  `/api/saas/precio`) que sí usan `service_role`.
- **`frontend/admin/js/clientes.js`** (etapa 17, Hallazgo 2) —
  `guardarCliente()` insertaba directo contra Supabase
  (`sb.from('clientes').insert()`), lo que bypaseaba por completo
  `exigirLimitePlan()` — el enforcement del cupo de clientes del plan
  contratado solo corre del lado del handler HTTP. Ahora pasa por
  `POST`/`PATCH /api/clientes`, igual que el resto de las pantallas de
  este archivo (precios, direcciones), con manejo específico del error
  `LIMITE_PLAN_ALCANZADO`.
- **`frontend/admin/js/notif-log.js`** (etapa 15, Hallazgo 3) — el badge
  de estado solo distinguía "Enviado" vs "— Sin ID", sin decir por qué
  había fallado un envío. Ahora trae `entregada`/`motivo` del `select` y
  el badge, el modal de detalle y el CSV exportado muestran el motivo
  real (`sin_dispositivos`, `error_consultando_dispositivos`,
  `todos_los_tokens_fallaron`, `rate_limit_interno`) cuando está
  disponible.

## Pendiente / fuera de este alcance

- Etapas 1 a 12 de la Auditoría 2026 (~41 hallazgos): requieren subir
  `01_pedidos.md` … `12_riesgo_cheques.md` con el detalle exacto antes de
  tocar código.
- `suspendida.html`: si una empresa queda suspendida, esa página necesita
  poder seguir leyendo sus propios datos vía `service_role` (porque ahora
  `get_empresa_id()` le devuelve `NULL` bajo RLS normal). Estaba rota de
  antes y queda para un fix aparte.
