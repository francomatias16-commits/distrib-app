# v288 — Fix config_id incorrecto en WhatsApp Embedded Signup

## Problema
El error "Parámetro no válido: se requiere 'config_id'" al tocar "Conectar mi
WhatsApp" no era un bug de código ni de configuración del producto en Meta —
el Configuration ID cargado en `frontend/env-config.js` tenía un dígito "8"
de más por un error de transcripción manual:

| Origen                | Valor                |
|------------------------|----------------------|
| Meta (config real "ES Config") | `28288615890741251`  |
| `env-config.js` (antes)  | `282888615890741251` (con un "8" extra) |

Como ese ID no existe, Facebook no podía resolver la configuración y el
diálogo OAuth caía en el error genérico de config_id inválido.

## Fix
Se corrigió `WA_EMBEDDED_CONFIG_ID` en `frontend/env-config.js` para que
coincida exactamente con el Identificador de configuración mostrado en
Meta for Developers → Inicio de sesión con Facebook para empresas →
Configuraciones → "ES Config".

## Recomendación
Al cargar cualquier ID de Meta (App ID, Configuration ID, WABA ID, etc.) en
el código, usar siempre el botón "Copiar" del dashboard en vez de tipearlo a
mano, para evitar este tipo de errores de transcripción.
