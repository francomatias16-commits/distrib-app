# Resumen — Fixes aplicados sobre AUDITORIA_CRUD_TABLAS_2026.md

## 1. Categorías de producto — RESUELTO ✅
Modal "Administrar categorías" en `frontend/admin/productos.html`, accesible
con el link "(administrar)" junto al select de categoría del alta de
producto. Permite crear, editar (nombre/orden/descripción), dar de baja y
reactivar, con filtro activas/inactivas/todas.

Usa el endpoint genérico `/api/maestros?recurso=categorias` que ya existía
en el backend (mismo patrón que zonas/depósitos/listas de precio) — no se
tocó nada del lado servidor.

Archivos: `frontend/admin/productos.html`, `frontend/admin/js/productos.js`

## 2. Desbloqueo de cliente — RESUELTO ✅
Antes existía `bloquearCliente()` (motor automático de mora) pero ninguna
función simétrica de desbloqueo manual. El único desbloqueo automático
ocurría al saldar la deuda completa vía `registrar_cobro_completo`.

- `lib/repos/clientes.js`: nueva función `desbloquearCliente()` — revierte
  `clientes.bloqueado/bloqueado_motivo` y `bloqueos_cliente.activo`, mismo
  criterio que usa el RPC de cobro.
- `lib/handlers/clientes.js`: nuevo endpoint `POST /api/clientes?_svc=desbloquear`
  (body: `{ cliente_id }`), solo dueño/admin.
- `frontend/admin/clientes.html` / `js/clientes.js`: botón "Desbloquear
  cliente" en el modal de edición, visible solo cuando `cliente.bloqueado`
  es true.

## 3. Eliminar cheque — RESUELTO ✅ (aplicado a producción)
`eliminarCheque()` hacía `DELETE` real contra la REST de Supabase, sin
pasar por ningún handler/repo backend (todo el módulo de cheques pega
directo a Supabase desde el frontend). Fix: pasa a `PATCH estado='anulado'`
(valor ya soportado por `cheques_estado_check`), con motivo opcional y
opción de "Reactivar" (deshacer, vuelve a `en_cartera`).

**Migración aplicada directamente a Supabase** (proyecto `jgiquzjwoedmzwqgzubr`):
- Columna `cheques.motivo_anulacion` (texto, nullable).
- `fn_cheques_lista`: excluye `anulado` del listado por defecto; se
  respeta si se filtra explícitamente por ese estado.
- `fn_cheques_contadores`: agrega `monto_anulados`/`cant_anulados`.

Archivos: `frontend/admin/cheques.html`, `frontend/admin/js/cheques.js`

## 4. Cajas POS — YA ESTABA COMPLETO, sin cambios necesarios ✅
Al revisar `frontend/admin/cajas.html` + `lib/handlers/pos.js` (acción
`cajas-admin`) + `lib/repos/pos.js`, el ABM completo de cajas POS (alta,
edición de nombre/depósito, activar/desactivar con chequeo de turno
abierto, y hasta "forzar cierre de turno" con motivo auditado) ya estaba
implementado de punta a punta. No había ningún hallazgo real pendiente acá.
