---
slug: auditoria-y-seguridad
categoria: administracion
roles: [dueno, admin]
---

# Auditoría y detección de anomalías

## Registro de auditoría

El sistema guarda un historial de cambios sensibles: qué tabla se modificó, qué registro, qué acción se hizo, los datos antes y después del cambio, quién lo hizo y desde qué dirección IP. Esto permite reconstruir qué pasó ante cualquier duda o reclamo.

## Detección de anomalías

El sistema puede detectar automáticamente patrones sospechosos, por ejemplo:
- Descuentos repetidos fuera de lo habitual.
- Ajustes de stock sin una orden de compra que los respalde.
- Movimientos de stock modificados o eliminados después de creados.

Cuando se detecta una anomalía, se puede avisar automáticamente al admin o al dueño por notificación push, y queda un registro para que alguien la revise y la marque como resuelta, dejando notas de qué se concluyó.

## Preguntas frecuentes

**¿Quién puede ver el registro de auditoría?**
Normalmente solo el admin o el dueño de la empresa.

**¿Una anomalía detectada significa necesariamente que hubo un problema?**
No siempre — el sistema marca patrones que ameritan revisión, pero puede haber explicaciones legítimas (por ejemplo, un ajuste de stock autorizado verbalmente que todavía no tenía la orden de compra cargada). Por eso cada anomalía se revisa y se documenta el resultado.
