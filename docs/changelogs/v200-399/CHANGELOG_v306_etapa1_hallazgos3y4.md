# CHANGELOG v306 — Etapa 1 (Pedidos), Hallazgos 3 y 4

Continuación de `AUDITORIA_2026/etapas_modulos/01_pedidos.md`. Con esto
cierra la Etapa 1 completa: 4/4 hallazgos corregidos en código.

## Hallazgo 3 — Pedido duplicado por reintento sin idempotencia

Se implementó el fix de fondo (idempotency_key real), no el parche rápido.

### Supabase (aplicado directo, ya en producción)
- `pedidos.idempotency_key` (uuid, nullable) + índice único parcial
  `(empresa_id, cliente_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
- `crear_pedido_cliente()`: nuevo parámetro `p_idempotency_key`. Si ya
  existe un pedido con esa key para ese cliente, lo devuelve
  (`ya_existia: true`) en vez de duplicar. Race entre dos requests
  simultáneos con la misma key: la que pierde contra el índice único cae
  en `EXCEPTION WHEN unique_violation` y también devuelve el pedido que sí
  se creó.
- **Nota técnica:** el `CREATE OR REPLACE` con un parámetro nuevo generó
  un *overload* de 11 args en vez de reemplazar la función — nació con
  los grants por defecto del schema (`EXECUTE` a `anon`/`authenticated`),
  pisando el hardening de SEC-012 de la auditoría anterior. Se revocó
  explícitamente (incluyendo el grant residual heredado de `PUBLIC`,
  mismo patrón que `fix_sec012_parte2`) y se eliminó la función vieja de
  10 args. Verificado con `has_function_privilege`: solo `service_role`
  puede ejecutarla, igual que antes.

### Código (pendiente de deploy)
- **`lib/handlers/pedidos.js`**: valida `idempotency_key` del body (debe
  ser UUID; si falta o es inválida, sigue funcionando igual que antes —
  compat con clientes viejos que no la mandan). La pasa al RPC. Cuando el
  RPC devuelve `ya_existia: true`, se **omiten** los efectos secundarios
  (WhatsApp, email, push, factura, puntos) — ya habían corrido en el
  intento original.
- **`frontend/cliente/carrito.html`**: genera `crypto.randomUUID()` al
  entrar al carrito (`sessionStorage`), la manda en cada intento de
  confirmar, y la limpia recién cuando el pedido se confirma con éxito. Si
  el `fetch` falla por red antes de eso, el próximo click reintenta con la
  misma key — el backend detecta el duplicado en vez de crear un pedido
  nuevo.

## Hallazgo 4 — Sesión vencida da mensaje poco accionable

- **`frontend/cliente/carrito.html`**: la respuesta `401` ahora se detecta
  antes de tratarla como error de negocio genérico. Muestra "Tu sesión
  expiró..." y redirige a `/cliente/login` — el carrito no se pierde
  (vive en `carrito_items` en la base, sobrevive el re-login). El mensaje
  del `catch` de error de red también se actualizó para explicitar que
  reintentar ahora es seguro (gracias al Hallazgo 3).

## Estado de la Etapa 1
4/4 hallazgos corregidos. Migraciones SQL activas en producción
(retrocompatibles — `idempotency_key` es opcional, el código viejo que
todavía no la manda sigue funcionando exactamente igual). El código
(backend + frontend) sigue sin desplegar — mismo estado que v304/v305.
