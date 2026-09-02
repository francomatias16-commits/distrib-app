# v269 — Integración de la auditoría UX al proyecto completo

Integra al proyecto completo (base v268) los 4 archivos que ya se habían
ajustado por separado a partir de la auditoría UX v2 (corregida). Sin
cambios de comportamiento adicionales a los ya descriptos en
CAMBIOS_APLICADOS.md — este commit es sólo la integración/merge.

## Archivos integrados (reemplazo directo, diff limpio sin conflictos)

1. **frontend/admin/js/nav-data.js**
   - `diario: true` en "Repartos" (workspace Ventas).
   - `diario: true` en "Cajas" (workspace Ventas).
   - Comentario de diseño sobre `/admin/compras` corregido: la entrada de
     menú "Compras" ya existía (FIX 092), el comentario anterior decía
     lo contrario.

2. **frontend/shared/adminlte-components.css**
   - `.page-intro`: 12.5px → 13.5px, contraste de
     `--color-text-light` a `--color-text-muted` / `--color-text`.

3. **frontend/shared/tokens.css**
   - Nueva utilidad `.urgente--pulso` (+ variante `.urgente--pulso-ambar`):
     halo suave 1.6s, sin parpadeo, con `prefers-reduced-motion` respetado.

4. **frontend/admin/js/dashboard-optimizado.js**
   - Tarjeta "Algo prendido fuego": suma `urgente--pulso` mientras
     `totalFuego > 0`, se apaga sola en 0.
   - Botón "Reponer" en fila de stock crítico: pulsa sólo cuando
     `cantidad_disponible <= 0` (quiebre real), con `title` explicativo.

## Verificación

- `node --check` OK en ambos `.js` modificados.
- Llaves balanceadas en ambos `.css` modificados.
- Diff de cada uno de los 4 archivos contra `cambios_auditoria_ux.zip`:
  idéntico tras la copia (0 diferencias).

## Pendiente (sin tocar, requiere decisión de producto — sección 6/7 del
informe de auditoría)

- `dashboard-v2.html` / `setup-wizard.html`: decidir si se fusionan, se
  eliminan o se documenta cuál es la vigente. Nota: `setup.html` y
  `setup-wizard.html` son las únicas pantallas sin título ni
  `page-intro`; probablemente se resuelva junto con esta decisión.
- Registro de cobro (monto + medio de pago) en la confirmación de
  entrega del chofer (`/frontend/chofer/remito.html`): función nueva,
  requiere agregar campos a `cobros`/`entregas` y a la UI.
- Reglas de precio: evaluar si conviene duplicar el acceso también
  desde Ventas (hoy sólo está en Facturación).
- Candidatos de prioridad Media/Baja para `.urgente--pulso` (badge de
  Recordatorios/Pendientes, pestaña "¿A quién llamo hoy?" en
  Cobranzas, botón "Confirmar entrega" del chofer) quedaron fuera de
  este alcance — el informe sólo pedía aplicar la prioridad Alta.
