# v408 — Excedente de proveedor en recepción de OC

## Contexto
Continuación de la sesión anterior (recepción de mercadería, jabón líquido
OC 00000001: pedidas 15, recibidas 20). Ya estaba aplicado en producción:

- Backend: `recepcionar_orden_compra()` valida en dos pasos (todo-o-nada) que
  ninguna cantidad recibida supere lo pendiente contra la OC.
- Frontend: input de "A recibir" con `max="${pendiente}"` (decorativo, ya
  que el submit es `fetch()` manual y no dispara la validación nativa del
  navegador).

## Qué faltaba y se agrega ahora
El backend bloqueaba el exceso, pero no había ninguna vía para el caso
legítimo: el proveedor realmente entregó más de lo pedido.

Diseño (dos conceptos separados, sin mezclarlos):
- **Recepción contra la OC** → siempre estricta, nunca > pendiente. Protege
  la trazabilidad del documento.
- **Excedente físico real** → se registra aparte como ajuste de stock
  (motivo `excedente_proveedor`, notas con referencia a la OC), usando la
  misma RPC `ajustar_stock` que ya usa el módulo de Stock para
  ingresos/egresos manuales (vía sesión del usuario, no service_role).

### Cambios
- `frontend/admin/js/compras.js`:
  - `confirmarRecepcion()` ahora separa, por fila, lo que entra dentro de lo
    pendiente de lo que excede. Si hay excedente, no envía nada todavía:
    muestra el panel de confirmación (`mostrarPanelExcedente`).
  - Nuevo `confirmarConExcedente()`: envía la recepción capada a lo
    pendiente y, si es exitosa, registra cada excedente con `ajustar_stock`
    (delta positivo, motivo `excedente_proveedor`, notas con el número de
    OC).
  - Nuevo `_enviarRecepcion()`: extrae el POST a `/api/compras?accion=recepcionar`
    a una función reusable (con modo `silencioso` para no cerrar el modal
    ni tostar antes de procesar el excedente).
  - Reset del panel de excedente al abrir el modal (por si quedó abierto de
    una recepción anterior).
- `frontend/admin/compras.html`:
  - Panel `#panel-excedente-recepcion` (oculto por defecto) con el detalle
    de los excedentes detectados y dos botones: "Volver a editar" /
    "Confirmar de todos modos".

### Dato histórico (OC 00000001, jabón líquido)
Pendiente de decisión del usuario — no se corrigió: no está claro si (a) se
recibieron 15 en verdad (typo/OCR: hay que bajar `cantidad_recibida` a 15 Y
restar 5 del stock) o (b) se recibieron 20 en verdad (el stock está bien,
solo hay que bajar `cantidad_recibida` a 15 y crear un ajuste
`excedente_proveedor` de +5 para que quede auditado como corresponde).

### Pendiente aparte (no relacionado, marcado en la sesión anterior)
`recepcionar_orden_compra` no valida que `p_empresa_id` coincida con la
empresa real del usuario autenticado (mismo patrón SEC-010, ~18 veces
corregido en `migracion_*`). No se tocó — queda para sesión de seguridad.
