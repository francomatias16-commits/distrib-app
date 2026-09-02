---
slug: glosario-de-terminos
categoria: general
roles: [dueno, admin, vendedor, contador]
---

# Glosario de términos y siglas

Este artículo junta términos y siglas que aparecen en distintas pantallas del
sistema pero que no tienen una explicación dedicada en ningún otro artículo.
Si preguntás "qué es tal cosa" y es alguno de estos, esta es la fuente.

## Precio OC

El "precio OC" es el precio unitario al que quedó cargado un producto en una
Orden de Compra (OC) a un proveedor — es el precio que se pactó al pedirle
la mercadería, no el precio de venta al público. Se usa como referencia al
recibir la mercadería y al cargar la factura del proveedor, para detectar
si el proveedor facturó a un precio distinto del acordado en la OC.

## OC (Orden de Compra)

Es el pedido de mercadería que la empresa le hace a un proveedor. Se genera
desde la sección de Compras, se le hace seguimiento en "Órdenes de Compra y
Recepción" hasta que la mercadería llega al depósito, y después se concilia
contra la factura que manda el proveedor.

## Cruce (conciliación OC ↔ Factura)

"Cruce" es la comparación automática entre lo que decía la Orden de Compra
(cantidades y precios pactados) y lo que terminó facturando el proveedor.
El sistema marca como discrepancia cualquier ítem donde la factura no
coincide con la OC (precio distinto, cantidad distinta, ítem de más o de
menos), para que se revise antes de pagar.

## FEFO (First Expired, First Out)

Es el criterio con el que el sistema elige qué lote de stock descontar
primero cuando se vende o se prepara un pedido: siempre el lote que vence
antes, aunque no sea el que entró primero al depósito. El objetivo es
minimizar la mercadería que se vence en el depósito.

## CBU

Clave Bancaria Uniforme: el número que identifica una cuenta bancaria en
Argentina, usado en el sistema para registrar cuentas de cobro/pago por
transferencia (proveedores, clientes).

## Condición frente al IVA (CF / RI / EX)

Categoría impositiva de un cliente o proveedor ante AFIP, que determina qué
tipo de factura le corresponde (A, B o C):
- **RI — Responsable Inscripto**: paga IVA, puede recibir factura A.
- **CF — Consumidor Final**: no discrimina IVA, recibe factura B.
- **EX — Exento**: no paga IVA, recibe factura B o C según el caso.

## CUIT

Clave Única de Identificación Tributaria: el número de identificación fiscal
en Argentina, obligatorio para emitir o recibir facturas A.

## CAE

Código de Autorización Electrónico que otorga AFIP a cada factura
electrónica válida. Sin CAE, una factura no tiene validez fiscal. Ver el
artículo "Facturación electrónica AFIP" para el detalle completo del
proceso de emisión.
