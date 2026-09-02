---
slug: bloqueos-y-score-de-cliente
categoria: clientes
roles: [dueno, admin, vendedor]
---

# Bloqueo de clientes y score de cliente

## Bloqueo de clientes

Un cliente puede quedar bloqueado para nuevos pedidos, generalmente por deuda que supera su límite de crédito. El bloqueo registra el motivo y el monto de deuda al momento de bloquear. Un admin puede desbloquear al cliente manualmente cuando la situación se regulariza.

## Score de cliente

El sistema calcula automáticamente un puntaje (score) por cliente, que combina varios factores:
- Comportamiento de pago (paga en término o no).
- Frecuencia de compra.
- Nivel de deuda actual.
- Historial de devoluciones.

Ese score se traduce en una **categoría** (por ejemplo: premium, bueno, normal, riesgo), configurable por umbrales que define cada empresa.

## Para qué se usa el score

La categoría de un cliente puede afectar automáticamente:
- El **límite de crédito** y los **días de crédito** que se le habilitan (clientes de mejor categoría acceden a condiciones más flexibles).
- El **bonus de puntos** que recibe en el programa de fidelización (ver artículo de fidelización).

Cuando el score de un cliente cambia significativamente, se genera una alerta para que el equipo comercial la revise — por ejemplo, ante una caída brusca que podría anticipar un problema de pago.

## Preguntas frecuentes

**¿El score se actualiza en tiempo real?**
Se recalcula cuando ocurren eventos relevantes (un pago, una nueva deuda, una devolución), no es un valor fijo.

**¿Se puede ajustar manualmente el score de un cliente?**
El score se calcula automáticamente según las reglas configuradas; lo que sí se puede ajustar son esas reglas (los umbrales y multiplicadores) a nivel empresa.
