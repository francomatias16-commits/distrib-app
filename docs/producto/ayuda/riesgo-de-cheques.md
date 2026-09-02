---
slug: riesgo-de-cheques
categoria: cobranzas
roles: [dueno, admin, contador]
---

# Riesgo de cheques

## Para qué sirve

Antes de depositar un cheque o de aceptar uno nuevo de un cliente, esta pantalla (Cobros y Pagos → Riesgo de cheques) cruza los cheques que tenés en cartera con el score de salud de cada cliente, para que puedas priorizar la revisión sobre los casos más delicados.

## Qué muestra

Una fila por cada cliente que tiene cheques en cartera/depositados o que tuvo cheques rechazados en el pasado, con:

- **Score y categoría** del cliente (premium, bueno, normal, riesgo, bloqueado) — el mismo cálculo que ya usa la ficha de cliente.
- **Monto y cantidad de cheques en cartera** de ese cliente.
- **Cheques rechazados históricos** (monto y cantidad).
- **Deuda actual frente al límite de crédito**, con el porcentaje del límite ya utilizado.
- **Última alerta de caída de score**, si tuvo una recientemente.

Arriba de la tabla hay cuatro indicadores generales (clientes en riesgo con cheques activos, monto expuesto, rechazos históricos y alertas sin resolver), y un aviso destacado cuando algún cliente con cheques en cartera tuvo una caída de score reciente.

## Cómo usarla

- Ordená mentalmente por prioridad: la tabla ya viene ordenada con el score más bajo primero.
- Usá el filtro de categoría o el buscador para enfocarte en un segmento (por ejemplo, solo "Riesgo" y "Bloqueado").
- El check "Solo con rechazos o alertas" oculta a los clientes sin antecedentes, para revisar rápido a los que sí los tienen.
- El botón **Ver cheques** de cada fila te lleva a la pantalla de Cheques con ese cliente ya filtrado.

## Preguntas frecuentes

**¿Esto bloquea o rechaza cheques automáticamente?**
No. Es una vista de análisis para ayudarte a decidir; las acciones sobre cada cheque (depositar, marcar como rechazado, etc.) se siguen haciendo desde la pantalla de Cheques.

**¿De dónde sale la deuda actual y el límite de crédito?**
Del mismo cálculo que usa el resto del sistema para priorizar cobranzas (ver artículo de Cobros y cuenta corriente), no es un número aparte.

**¿Con qué frecuencia se actualiza?**
Se recalcula cada vez que entrás a la pantalla, o con el botón "Actualizar". El score del cliente en sí se recalcula automáticamente ante eventos relevantes (ver artículo de Bloqueos y score de cliente).
