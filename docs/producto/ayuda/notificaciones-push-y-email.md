---
slug: notificaciones-push-y-email
categoria: notificaciones
roles: [dueno, admin, cliente, vendedor, chofer]
---

# Notificaciones (push y email)

## Notificaciones push

El sistema puede enviar notificaciones push a los dispositivos de usuarios y clientes que hayan aceptado recibirlas (por ejemplo, avisos de despacho, confirmación de pedido, alertas de stock o de score). Cada notificación queda registrada con si fue enviada y si fue leída.

Para recibir push, el dispositivo debe estar registrado en el sistema — esto pasa automáticamente cuando el usuario acepta los permisos de notificación en el navegador o la app.

## Notificaciones por email

Se envían emails automáticos para eventos como confirmación de pedido, estado de cuenta, aviso de despacho, recepción de mercadería a proveedores, o recuperación de contraseña. Cada envío queda registrado, incluyendo si se entregó correctamente y, si falló, el motivo.

### Reintentar un email que falló

Desde **Notificaciones → Historial**, cualquier fila de email marcada como fallida tiene un botón **Reintentar**. Al usarlo, el sistema vuelve a armar el email con los datos actuales (no reenvía una copia guardada del anterior) y lo despacha de nuevo. El resultado del reintento queda como una fila nueva en el historial, así se conserva el rastro de todos los intentos.

Hoy se puede reintentar: confirmación de pedido, aviso de despacho, estado de cuenta y recepción de mercadería a proveedores. Requiere rol dueño o admin.

## Preferencias automáticas por empresa

El admin puede activar o desactivar qué tipos de aviso automático quiere recibir la empresa, por ejemplo:
- Aviso cuando un cliente queda bloqueado.
- Aviso cuando hay un error en la cola de procesos financieros.
- Aviso de quiebre de stock o de una orden de compra automática generada.
- Aviso ante una caída crítica en el score de un cliente.
- Aviso ante una anomalía detectada (por ejemplo, descuentos repetidos sospechosos o ajustes de stock sin orden de compra asociada).

## Preguntas frecuentes

**¿Por qué un cliente no recibe notificaciones push?**
Puede ser que nunca aceptó los permisos de notificación en su dispositivo, o que el dispositivo quedó marcado como inactivo.

**¿Se puede reenviar un email que falló?**
Sí — en el historial de notificaciones, las filas de email fallidas tienen un botón "Reintentar" (ver arriba). Cubre confirmación de pedido, despacho, estado de cuenta y recepción a proveedores; otros tipos todavía no se pueden reintentar desde el panel.
