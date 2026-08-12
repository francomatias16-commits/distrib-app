-- ============================================================================
-- 243_stock_auto_alerta_sin_proveedor.sql
--
-- Etapa 4 del plan (Compras inteligentes) — cierre de un gap encontrado al
-- auditar el loop stock predictivo → sugerencia de compra → OC automática
-- (lib/handlers/stock-auto.js, analizarYGenerarOrdenes).
--
-- DIAGNÓSTICO: cuando analizar_stock_autonomo() (071) marca un producto como
-- necesita_reponer=true pero el producto NO tiene proveedor_id_default, el
-- código agrupaba los ítems críticos por proveedor_id y, para la clave
-- 'sin_proveedor', hacía `continue` sin más: no se generaba OC (correcto,
-- no hay a quién enviarla) PERO tampoco se dejaba ningún rastro — no se
-- creaba alerta en alertas_stock, no se notificaba a nadie. Un producto
-- podía llegar a quiebre total (dias_restantes = 0) y el cron diario
-- (0 6 * * *) lo recalculaba cada mañana y lo volvía a descartar en
-- silencio. Confirmado en producción: "Yerba Mate 1kg" en quiebre total sin
-- ninguna alerta ni notificación por este motivo exacto.
--
-- FIX (código, no requiere esta migración): stock-auto.js ahora llama a
-- alertarSinProveedor() para ese grupo, que crea una alerta_stock con
-- tipo='sin_proveedor' y dispara un push a admins vía notifAuto().
--
-- ESTA migración solo agrega la columna de preferencia que notifAuto()
-- necesita para poder chequear "¿esta empresa quiere este tipo de aviso?"
-- (select dinámico por nombre de columna: sb.from('notif_prefs_auto')
-- .select(tipo) — si la columna no existe, esa query devuelve error y la
-- preferencia se trata como "no configurada", igual se notifica, pero el
-- toggle en frontend/admin/automatizacion.html no tendría persistencia
-- real). Sigue el mismo patrón que stock_quiebre/stock_orden_auto (037).
-- ============================================================================

ALTER TABLE public.notif_prefs_auto
  ADD COLUMN IF NOT EXISTS stock_sin_proveedor BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.notif_prefs_auto.stock_sin_proveedor IS
  'Producto necesita reponerse (analizar_stock_autonomo) pero no tiene '
  'proveedor_id_default: el motor de stock-auto no puede generarle una OC '
  'automática y en cambio deja una alerta_stock tipo=sin_proveedor y avisa '
  'a admins/dueños para que asignen un proveedor por defecto al producto.';
