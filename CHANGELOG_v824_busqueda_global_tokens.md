# v824 — busqueda-global.js migrado al sistema de tokens (Hoja de Ruta)

Siguiente archivo de la cola tras `rutas.js` (v823), según
`audit_table.md`.

## Hallazgo: no era hex crudo, era 100% fallback desincronizado

De los 45 hits que marcaba `audit_table.md` para
`frontend/admin/js/busqueda-global.js`, ninguno era hex crudo real: el
archivo inyecta un `<style>` en `document.head` (línea 196, documento
vivo con acceso a `tokens.css`) y ya usaba `var(--token, #hex)` en todos
los casos salvo un `box-shadow`. El trabajo acá fue el mismo bug de
fallback desincronizado que se auditó en HTML (v489) y en JS (v729), no
migración mecánica de color crudo.

## Cambios en frontend/admin/js/busqueda-global.js

**6 fallbacks corregidos** al valor real actual de `tokens.css` (nombre
del token sin tocar):

| Token | Fallback viejo | Fallback correcto |
|---|---|---|
| `--color-surface` | `#FCFAF5` | `#FFFFFF` |
| `--color-border` | `#C7BFA9` | `#DDE1DC` |
| `--radius-md` | `6px` | `4px` |
| `--color-text-muted` | `#4B4A45` | `#5B6660` |
| `--color-bg` | `#F5F2EA` | `#F6F7F5` |
| `--color-text` | `#16181D` | `#111A17` |

**1 shadow crudo**: `box-shadow: 0 8px 32px rgba(0,0,0,.14)` del
dropdown de resultados → `rgba(22,24,29,.14)` (tinta ink, mismo mapeo
usado en el resto del frente).

Los tokens de color de los íconos por tipo de resultado
(`--color-info*`, `--color-success*`, `--color-warning*`,
`--color-danger*`, `--pill-purple/pink/orange/neutral*`) ya tenían el
fallback correcto — no requirieron cambio.

Verificado con `node --check` y con un chequeo comparativo de que no
queda ningún hex/rgba fuera de `var()` en el archivo (salvo el shadow ya
corregido). Sin cambios visuales esperados.

## audit_table.md re-auditado

Se recontaron los 34 archivos del frente JS con grep real (antes eran
números aproximados de memoria/sesión anterior). Aparecieron 5 archivos
con 1 caso cada uno (`topbar-widgets.js`, `productos-scanner-remoto.js`,
`presupuestos.js`, `notas.js`, `conciliacion-bancaria.js`) que no
figuraban en ninguna auditoría previa — quedan marcados como "sin
revisar" para confirmar en la próxima sesión si son deuda real o ruido
antes de asignarles prioridad.

## Siguiente en la cola

Ver `audit_table.md` — el resto de los 29 archivos pendientes, empezando
por confirmar los 5 casos nuevos y después seguir por tamaño
(`offline-core.js`, `pedidos.js`, `cc-proveedores.js`, `etiquetas.js`...).
