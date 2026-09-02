# v868 — Rutas sincronizadas y borradores funcionales

## Objetivo

Cerrar la integración de las dos pantallas refinadas —**Control de repartos** y
**Armar ruta**— con el flujo operativo real del proyecto, sin cambiar sus
consultas, permisos ni contratos de Supabase.

## Cambios incluidos

- La fecha del resumen/cola y la fecha de la nueva ruta quedan sincronizadas:
  cambiar una actualiza la otra y recarga la operación del día correcto.
- Los borradores de ruta ahora funcionan en el navegador, separados por empresa
  y fecha, y se restauran al volver a abrir la jornada.
- El borrador conserva pedidos seleccionados, chofer y notas internas.
- La interfaz informa si el borrador quedó guardado en el dispositivo.
- La confirmación de ruta diferencia entre ruta creada y chofer realmente
  notificado por WhatsApp o push.
- Se mantiene el rediseño compacto v866/v867: una sola vista de escritorio,
  scroll únicamente dentro de listas/tablas y las seis pestañas operativas.
- El ZIP no incluye credenciales de entorno; se agrega `.env.example` con la
  configuración mínima para completar desde el gestor de secretos.