# CHANGELOG v249 — Fix de contraste WCAG AA (legibilidad global)

## Alcance
Corrección centralizada de contraste de texto, sin tocar layout, estructura
ni lógica de la app. Cambios hechos únicamente en las variables de color
globales (`:root` en `frontend/shared/tokens.css`) y en su capa de parche
(`frontend/shared/reskin-patch.css`), para que se propaguen automáticamente
a todas las secciones (admin, cliente, chofer, proveedor).

## Cambios

### `frontend/shared/tokens.css`
- `--color-text-light`: `#94A3B8` (2.56:1 sobre blanco, no pasaba AA) → `#64748B` (4.76:1).
  Afecta textos secundarios/explicativos, placeholders y texto de estados vacíos.
- `--color-border`: `#E2E8F0` (1.23:1) → `#A9B6C6` (~2.1:1). Bordes de inputs y
  contenedores (incl. área de arrastre de archivos) ahora se distinguen del fondo blanco.
- `--color-border-soft`: `#EEF2F7` → `#D7DEE7` (mismo criterio, para separadores sutiles).
- `--color-box-warning`: `#D97706` → `#B45309`. El texto blanco de botones/badges de
  advertencia pasaba de 3.19:1 a 5.02:1.
- `--color-box-success`: `#16A34A` → `#15803D`. De 3.30:1 a 5.02:1 con texto blanco.
- `--color-box-info`: `#3B82F6` → `#2A5FD1`. De 3.68:1 a 5.74:1 con texto blanco.
- `--nav-dark-text-sub` y `--nav-dark-border`: mismo ajuste que sus equivalentes arriba.

### `frontend/shared/reskin-patch.css`
- Reemplazo global de `#E2E8F0` → `#A9B6C6` y `#94A3B8` → `#64748B` (38 ocurrencias),
  ya que este archivo aplica overrides `!important` de esos mismos tonos.

## Resultado
- Textos secundarios/explicativos: ahora ≥ 4.5:1 sobre blanco (AA).
- Badges/botones con fondo de color (amarillo/naranja incluidos): texto blanco
  interior ahora ≥ 4.5:1.
- Bordes de inputs y contenedores: contraste no-textual duplicado sin oscurecer
  demasiado la interfaz (cambio sutil, según lo pedido).
- Cero cambios de layout, disposición de componentes o lógica — solo variables
  de color.
