# v261 — Alerta de cheques vencidos sin gestionar

## Contexto
Se agrega un nuevo tipo de alerta al panel de notificaciones del dashboard
(`/api/admin/alertas`) para cheques en cartera cuya fecha de vencimiento ya
pasó y que todavía no fueron depositados, rechazados ni devueltos.

Nota: el tema de las 44 transacciones pendientes en `transacciones_pago`
(vinculado a la integración de MercadoPago inactiva) queda deliberadamente
fuera de este cambio — se decidió no tratarlo como cerrado sin verificación
adicional, y no forma parte de este release.

## Cambios

### Backend — `lib/handlers/admin.js`
- Nueva sección 4 dentro de `handleAlertas()`: consulta `cheques` filtrando
  `estado='en_cartera'` y `vencimiento < hoy` (empresa_id del token), límite
  5, orden por vencimiento ascendente (los más viejos primero).
- Cada cheque vencido genera una alerta `tipo: 'cheque_vencido'` con
  cliente, número, monto formateado y fecha de vencimiento en el cuerpo, y
  `link: '/admin/cheques.html'`.
- Verificado contra el esquema real de `cheques`: columnas `numero`,
  `monto`, `vencimiento`, `estado`, `cliente_id` confirmadas por consulta
  directa a information_schema. (La tabla tiene además una columna
  `fecha_vto` duplicada/legacy, sincronizada con `vencimiento` — no se usó
  para evitar depender de una columna que podría eliminarse a futuro.)

### Frontend — `frontend/admin/js/dashboard-optimizado.js`
- Agregado `cheque_vencido` al mapa `colorTipo` de `renderListaAlertas()`
  (ícono 📄, color `--color-box-danger` por tratarse de dinero ya vencido,
  a diferencia de `migracion_pendiente` que usa `--color-box-warning`).
- Agregado `cheque_vencido` al mapa de `iconoAlerta()`.

## Verificación
- `node --check` sobre ambos archivos: OK.
- Confirmado contra la base real (proyecto `jgiquzjwoedmzwqgzubr`) que la
  query trae los cheques vencidos esperados de la empresa de prueba.

### Contador agregado (tarjeta proactiva en el dashboard)
- `handleAlertas()` ahora también devuelve `resumen_cheques_vencidos: { cantidad, monto_total }`, calculado sin el límite de 5 filas (cuenta y suma **todos** los cheques vencidos de la empresa, no solo los que se listan en el panel de notificaciones).
- Nueva tarjeta proactiva `#alerta-cheques-vencidos` en `dashboard.html`, renderizada por `renderAlertaChequesVencidos()` — mismo patrón que `renderAlertaStockProactiva`/`renderAlertaMigracionPendiente`. Reusa el fetch de `/api/admin/alertas` ya existente, no agrega ninguna llamada nueva.
- Variante CSS `--cheques` (rojo, `#dc2626`) agregada en `dashboard.css` siguiendo la misma convención de `--migracion`/`--onboarding`.
- Verificado contra la base real: 6 cheques vencidos por $377.299 total — coincide con el conteo agregado.

## Pendiente / fuera de alcance
- Revisar si conviene deprecar formalmente la columna `fecha_vto` de
  `cheques` en una migración aparte.
- El reskin del setup wizard / fix de cuenta suspendida (mencionados en el
  nombre del zip base v260) se revisaron y ya estaban completos — no había
  nada pendiente ahí.
