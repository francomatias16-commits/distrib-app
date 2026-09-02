---
slug: facturacion-electronica-afip
categoria: facturacion
roles: [dueno, admin, contador]
---

# Facturación electrónica (AFIP/ARCA)

El sistema emite comprobantes fiscales electrónicos automáticamente contra los servicios de ARCA (ex AFIP).

## Configuración inicial (una sola vez por empresa)

El admin o dueño debe cargar en la configuración de facturación:
- CUIT y razón social de la empresa.
- Punto de venta habilitado en ARCA.
- Condición frente al IVA.
- El certificado digital y la clave privada emitidos por ARCA para autenticación.

Mientras el modo **homologación** esté activo, los comprobantes emitidos son de prueba y no tienen validez fiscal real — es el modo que se usa para testear antes de salir a producción.

## Cómo se emite una factura

1. Se genera automáticamente al confirmar un pedido o una venta POS (según tu configuración), o se emite manualmente.
2. El sistema solicita autorización a ARCA (obtiene un CAE — Código de Autorización Electrónico — y su vencimiento).
3. Si ARCA autoriza, la factura queda en estado **emitida** con su CAE y se genera el PDF.
4. Si hay un rechazo o error de conexión, la factura queda en estado **error_afip**, con el detalle del motivo del error visible para que el admin lo revise.

## Estados posibles de una factura

- **pendiente**: todavía no se intentó emitir.
- **emitida**: aprobada por ARCA, con CAE válido.
- **parcial**: cobrada solo parcialmente.
- **error_afip**: falló la emisión — revisar el motivo del error para reintentar.
- **anulada**: se anuló (normalmente vía nota de crédito).

## Reintentos automáticos

Si falla la conexión con ARCA (por ejemplo, un corte temporal del servicio), el sistema reintenta automáticamente el envío en segundo plano, sin que tengas que reemitir la factura a mano.

## Preguntas frecuentes

**¿Por qué una factura quedó en error_afip?**
Puede ser un problema de conexión temporal con ARCA, un dato mal cargado (CUIT del cliente inválido, por ejemplo), o el certificado digital vencido. El mensaje de error específico queda guardado junto a la factura.

**¿Se puede facturar sin conexión a internet?**
No, la emisión de un comprobante fiscal siempre requiere conexión con los servicios de ARCA en el momento de autorizar el CAE.

**¿Qué pasa si vence el certificado digital?**
Todas las emisiones van a fallar hasta que se renueve el certificado en ARCA y se vuelva a cargar en la configuración de facturación. Esto lo gestiona el admin o el contador de la empresa.
