# Manual de usuario — Fluxo

> Guía de uso del panel administrativo y la app de chofer. Pensada para que un
> usuario nuevo pueda operar el sistema sin intervención del equipo de soporte.

---

## 1. Primeros pasos

### 1.1 Ingresar al sistema

1. Entrá a `https://[tudominio].com.ar/admin` (o `/admin/dashboard` si ya tenés sesión guardada).
2. Ingresá el email y contraseña que te fueron asignados.
3. Si es tu primer ingreso, el sistema te va a pedir cambiar la contraseña provisoria.

### 1.2 Configuración inicial de la empresa

Antes de cargar el primer pedido, conviene completar:

- **Datos de la empresa**: razón social, CUIT, condición frente al IVA, dirección.
- **Punto de venta y tipo de comprobante** por defecto (necesario para facturar).
- **Logo**: se usa en el panel y en los remitos/facturas que ve el cliente.

Esto se configura desde *Configuración → Empresa*.

### 1.3 Cargar el primer producto

1. Andá a *Productos → Nuevo producto*.
2. Completá nombre, categoría, precio y stock inicial.
3. Si tenés un catálogo grande, es más rápido importarlo por CSV (ver *Productos → Importar*) en lugar de cargar uno por uno.

### 1.4 Cargar el primer cliente

1. Andá a *Clientes → Nuevo cliente*.
2. Completá razón social, CUIT (si factura A), dirección de entrega y condición de pago.
3. La cuenta corriente del cliente se crea automáticamente; no hace falta ningún paso extra.

---

## 2. Pedidos

### 2.1 Crear un pedido

1. *Pedidos → Nuevo pedido*.
2. Elegí el cliente, agregá productos y cantidades.
3. El sistema valida stock disponible al momento de cargar cada línea.
4. Guardá como **presupuesto** si todavía no es una venta confirmada, o como **pedido** si ya está confirmado.

### 2.2 Estados de un pedido

| Estado | Significa |
|---|---|
| Presupuesto | Cotización enviada, no descuenta stock |
| Pendiente | Confirmado, en espera de preparación |
| En preparación | Se está armando en depósito |
| Listo para entrega | Asignable a una ruta |
| En reparto | Asignado a un chofer, en camino |
| Entregado | Confirmado por el chofer en destino |
| Cancelado | Anulado, repone stock si correspondía |

### 2.3 De presupuesto a pedido confirmado

Un presupuesto se convierte en pedido con el botón **Confirmar** dentro del detalle del presupuesto. Ahí recién se descuenta stock.

---

## 3. Rutas y logística

### 3.1 Asignar un pedido a una ruta

1. *Rutas → Nueva ruta* (o sumar a una ruta del día existente).
2. Elegí el chofer y los pedidos "Listos para entrega" que va a llevar.
3. El sistema ordena las paradas; podés reordenarlas manualmente si conocés mejor el recorrido.

### 3.2 Seguimiento de la ruta

Desde *Rutas → [ruta del día]* se ve en tiempo real qué paradas se completaron y cuáles quedan pendientes, a medida que el chofer va confirmando entregas desde su app.

### 3.3 La app de chofer

El chofer ingresa desde `/chofer` con su usuario. Ahí ve:

- Su ruta del día, ordenada por parada.
- El remito de cada entrega, con el detalle de productos.
- Botón para confirmar entrega (y registrar devoluciones parciales si corresponde, con foto).

La app de chofer funciona aunque la conexión sea mala: la ruta del día y los remitos quedan disponibles localmente una vez que se cargaron por primera vez.

### 3.4 Confirmación de entrega

El chofer confirma la entrega desde su celular. Eso actualiza el estado del pedido a "Entregado" y dispara, si corresponde, la generación del comprobante de venta.

---

## 4. Stock

### 4.1 Ajuste manual de stock

*Stock → [producto] → Ajustar*. Se usa para correcciones (rotura, conteo físico, diferencias de inventario). Todo ajuste manual queda registrado con usuario y motivo.

### 4.2 Punto de pedido

Cada producto puede tener un **punto de pedido** (stock mínimo) configurado en su ficha. Cuando el stock cae por debajo de ese número, el producto aparece en el listado de "Productos a reponer".

### 4.3 Piloto automático de stock

Si se activa para un producto o categoría, el sistema sugiere (o genera automáticamente, según configuración) órdenes de compra a proveedores cuando el stock proyectado cae por debajo del punto de pedido, considerando el consumo histórico. Se configura desde *Automatización → Piloto automático*.

---

## 5. Cobranzas

### 5.1 Cuenta corriente del cliente

*Clientes → [cliente] → Cuenta corriente* muestra el historial completo: facturas, pagos, notas de crédito/débito y saldo actual.

### 5.2 Registrar un cobro

1. *Cobranzas → Nuevo cobro*.
2. Elegí el cliente, el medio de pago y el monto.
3. Podés imputar el cobro a una o varias facturas pendientes, o dejarlo como saldo a favor.

### 5.3 Notas de crédito y débito

Se generan desde *Cobranzas → Notas* o directamente desde una factura (para devoluciones o ajustes). Afectan la cuenta corriente del cliente al confirmarse.

---

## 6. Facturación

### 6.1 Configuración ARCA (ex AFIP)

Antes de emitir la primera factura electrónica hay que cargar, en *Configuración → Facturación*:

- Punto de venta habilitado en ARCA.
- Certificado digital de la empresa.
- Tipo de comprobante por defecto (A, B o C, según condición del cliente).

### 6.2 Emitir una factura

Una factura se genera desde un pedido entregado (*Pedidos → [pedido] → Facturar*) o de forma manual desde *Facturación → Nueva factura*. El sistema arma el comprobante, lo envía a ARCA y guarda el CAE recibido.

### 6.3 Anular una factura

ARCA no permite borrar comprobantes ya emitidos. Para anular, se emite una **nota de crédito** por el mismo importe desde *Facturación → [factura] → Anular*, que es lo que efectivamente "cancela" el efecto de la factura original en la cuenta corriente y en ARCA.

---

*Este manual se actualiza a medida que se agregan funcionalidades. Si encontrás un paso desactualizado o un caso no contemplado, avisá al canal de soporte (ver `SOPORTE.md`).*
