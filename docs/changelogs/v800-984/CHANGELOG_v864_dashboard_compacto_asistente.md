# v864 — Dashboard compacto con asistente IA

## Cambios

- Reorganicé el mosaico principal en cuatro franjas:
  - actividad de Hoy y WhatsApp en la franja superior compacta;
  - asistente IA en una franja central visible;
  - operación y control en las dos franjas inferiores.
- Reduje el área visual del catálogo para dejar únicamente:
  - QR real generado con `QRCode`;
  - estado de publicación;
  - descripción breve y acceso a la configuración.
- Moví Comprobantes ARCA al espacio vertical liberado por el catálogo.
- Incorporé una tarjeta de entrada al asistente IA existente, con consultas rápidas para cobranzas, stock y pedidos.
- Cargué el CSS y el JavaScript existentes de `chat-widget` en el dashboard. No se creó una segunda conversación ni una segunda integración.
- Conservé los IDs que usan las consultas, el polling, el zoom, los tabs, realtime y la navegación.
- Añadí overflow vertical controlado en la grilla para ventanas de baja altura y mantuve el apilado responsive para mobile.
- Dejé de consultar productos, categorías y clientes solo para mostrarlos dentro del dashboard: esas métricas siguen disponibles en sus módulos específicos.

## Validaciones

- JavaScript inline del dashboard validado con `node --check`.
- No se modificaron backend, migraciones, esquema ni consultas de negocio.
- Se verificó que no queden referencias funcionales a los elementos eliminados del catálogo.