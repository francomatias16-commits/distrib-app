# Sincronización funcional de los CTAs con la landing vieja (demo en vivo)

Cruce de datos completo entre `frontend/index.html` (landing vieja, v870,
tema oscuro / demo pública) y `frontend/landing/app.js` (landing nueva,
React, v921) para alinear los botones de llamada a la acción.

## Hallazgo

La landing vieja tiene 4 CTAs, todos apuntando directo a `/demo` (ruta ya
funcional en el proyecto — `lib/demo-mode.js` y las migraciones de
`usuario_demo_solo_lectura` la respaldan):

| Ubicación               | Texto viejo                    |
|--------------------------|---------------------------------|
| Nav desktop               | "Ver demo en vivo →"           |
| Nav mobile                 | "Ver demo en vivo →"           |
| Hero (botón primario)      | "Entrar a la demo en vivo →"   |
| Banda CTA final             | "Ver la demo en vivo →"        |

La landing nueva, en cambio, no linkeaba a `/demo` en ningún lado: los 4
botones equivalentes decían "Comienza gratis" (×3, apuntando a `#contacto`,
un ancla al banner de cierre) o "Ver mi operación" (banda final, apuntando
a `mailto:hola@fluxo.app`). Ninguno entraba realmente a la demo.

## Cambios aplicados (solo estos 4 botones — texto + href)

| Ubicación                  | Antes                                          | Ahora                                       |
|------------------------------|--------------------------------------------------|------------------------------------------------|
| Header desktop (`header-cta`) | "Comienza gratis" → `#contacto`                 | "Ver demo en vivo" → `/demo`                  |
| Menú móvil (CTA final)         | "Comienza gratis" → `#contacto`                 | "Ver demo en vivo" → `/demo`                  |
| Hero (botón primario)          | "Comienza gratis" → `#contacto`                 | "Entrar a la demo en vivo" → `/demo`          |
| Banda CTA final                 | "Ver mi operación" → `mailto:hola@fluxo.app`    | "Ver la demo en vivo" → `/demo`               |

El texto de cada botón replica exactamente la frase que usaba la landing
vieja en la ubicación equivalente (nav corto = "Ver demo en vivo", hero =
"Entrar a la demo en vivo", banda final = "Ver la demo en vivo"), para que
quede sincronizado como pediste.

No se tocaron los otros dos links del header ("Regístrate" → `/registro`
e "Inicio de sesión" → `#contacto`) porque no son botones de demo — son
flujos separados, igual que en la landing vieja ("Registrarme"/"Regístrate"
e "Ingresar" son acciones distintas de "Ver demo en vivo").

## Cruce de datos adicional (sin cambios, solo hallazgos)

- La landing vieja tiene un link `/admin/login` ("Ingresar") funcional y
  separado del botón de demo. La landing nueva no tiene ese link — su
  "Inicio de sesión" apunta a `#contacto` (ancla, no a una página real).
  Lo dejo señalado por si en algún momento quieren un login real ahí;
  no lo toqué porque no formaba parte de lo pedido.
- Las 13 "reglas" del asistente IA de la landing vieja (alertas de stock,
  cobranza, riesgo BCRA, etc.) son más granulares que la descripción del
  asistente IA de la landing nueva ("Adjuntá un archivo y la IA lo
  procesa"). Son enfoques de producto distintos, no un texto
  desalineado — no se tocó.

## Verificación

`node --check app.js` sin errores. Confirmado por grep: 4/4 botones con
`href:"/demo"`, 0 restos de "Comienza gratis" o "Ver mi operación".
