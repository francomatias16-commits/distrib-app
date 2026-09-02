# v943 — Usuarios: avatar de iniciales + pastilla de Rol (sincronizado con Clientes)

## Motivo
La pantalla `usuarios.html` se quedó atrás del resto del panel (Clientes,
Pedidos, WhatsApp) que ya usan el patrón "avatar circular de iniciales +
nombre + dato secundario" para la columna principal, y pastillas con color
para atributos categóricos. Usuarios seguía con texto plano en columnas
separadas de Nombre/Email/Rol.

## Cambios

**`frontend/admin/usuarios.html`**
- Columnas "Nombre" y "Email" fusionadas en una sola `<th>Usuario</th>`.
- `colspan` de las filas de carga/vacío bajado de 6 a 5 (una columna menos).

**`frontend/admin/js/usuarios.js`**
- Agregado helper `iniciales(nombre)` (mismo patrón que
  Clientes/Pedidos/WhatsApp).
- Agregado `ROL_COLOR`: a diferencia de esos otros listados, acá el color
  del avatar y de la pastilla de Rol NO es aleatorio por nombre — es fijo
  por rol (dueño=violeta, admin=azul, vendedor=verde, depositero=naranja,
  chofer=rojo, contador=gris), porque lo que importa reconocer de un
  vistazo en esta pantalla es el nivel de acceso, no diferenciar contactos.
- `renderTabla()`: celda "Nombre"/"Email" reemplazada por una celda
  `.td-usuario` con avatar + nombre (+ pill "vos" si es el propio usuario)
  + email como línea secundaria; celda "Rol" pasa de texto plano a
  `<span class="badge-rol">`.

**`frontend/admin/css/usuarios-gentelella.css`**
- Nuevas reglas para `.td-usuario`/`.usr-avatar`/`.usr-nombre`/`.usr-email`/
  `.usr-pill-vos` (estructura calcada de `.td-cliente`/`.cli-avatar` de
  `clientes.css`, ya que Usuarios no tiene un CSS base propio análogo).
- Nueva regla `.badge-rol`: mismo alto/forma de pastilla que
  `.badge-estado` canónico, pero con el color fijado inline por fila
  (no se tocó `componentes-admin.css` ni sus 11 páginas consumidoras).

## No incluido en este cambio
- No se tocó el badge de Estado (`.badge-estado`) ni `renderFilaAcciones` —
  ya venían del componente canónico desde la migración de Fase 3.
- No se agregó ningún token `--ge-*` nuevo; los colores por rol reusan los
  ya existentes (`--ge-purple`/`--ge-blue`/`--ge-teal`/`--ge-orange`/
  `--ge-red`/`--ge-muted`).
