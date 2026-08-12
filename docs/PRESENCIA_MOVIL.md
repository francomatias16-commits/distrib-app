# Presencia móvil — estado PWA, Play Store (TWA) e iOS

## 7.1 Auditoría manual de la PWA (sin correr Lighthouse)

No pude correr Lighthouse desde acá (necesita Chrome real); lo que sigue es una
revisión manual del código contra los mismos criterios que Lighthouse evalúa en
la sección PWA. Conviene de todos modos correr Lighthouse una vez en producción
para tener el número real, pero esto ya adelanta dónde van a aparecer los
warnings.

| Criterio | Admin | Chofer | Estado |
|---|---|---|---|
| `manifest.json` con `name`, `short_name`, `icons` (192/512), `start_url`, `display: standalone`, `theme_color` | Ya existía, completo | **Agregado** en esta sesión (`frontend/chofer/manifest.json`) | OK ambos |
| Service Worker registrado | Ya existía (`sw-admin.js`) | **Agregado** (`sw-chofer.js`) | OK ambos |
| Funciona offline (al menos shell + última data) | Sí, con SWR/Network-First por sección | **Agregado**: shell cache-first + último remito/ruta conocida en network-first | OK ambos |
| HTTPS | Sí (Vercel) | Sí (Vercel) | OK |
| Botón / flujo de instalación (`beforeinstallprompt`) | **Agregado** en `auth.js` | **Agregado** en `pwa-init.js` | OK ambos |
| Viewport meta tag correcto | Sí | Sí | OK |
| Sin errores de consola al cargar (no verificado en runtime real) | — | — | **Pendiente probar en dispositivo** |

**Lo que falta para tener el número real de Lighthouse:**
1. Deployar estos cambios.
2. Abrir el admin y `/chofer` en Chrome DevTools → Lighthouse → categoría PWA, en mobile.
3. Si aparece algún warning de "maskable icon", se puede agregar un ícono adicional con `"purpose": "maskable"` en el manifest — no es bloqueante para el score pero sí para que el ícono se vea bien recortado en algunos launchers de Android.

## Cómo probar instalación y modo offline (Android Chrome)

1. Abrir el sitio en Chrome para Android.
2. Debería aparecer el botón "Instalar app" flotante (o el menú ⋮ → "Instalar app" / "Agregar a pantalla de inicio").
3. Instalar, abrir la app desde el ícono.
4. Activar modo avión, navegar — el shell y la última ruta/remito cargados deberían seguir visibles. Las acciones de escritura (confirmar entrega, registrar pago) van a fallar mostrando que no hay conexión: es el comportamiento esperado por ahora (no hay cola offline tipo IndexedDB para esas acciones todavía — quedaría como mejora futura si en la práctica los choferes pierden señal seguido en el momento exacto de confirmar).

---

## 7.2 Publicar en Play Store vía TWA (Trusted Web Activity)

Requisitos antes de arrancar:
- [x] PWA con manifest válido (admin y chofer, listo en esta sesión)
- [ ] Score de Lighthouse > 80 confirmado en producción (paso manual, ver arriba)
- [x] `assetlinks.json` — **creado** en `.well-known/assetlinks.json` con placeholder de fingerprint
- [ ] Cuenta Google Play Console ($25 único pago) — esto lo tenés que crear vos, no hay forma de automatizarlo
- [ ] Generar el `.aab` con Bubblewrap

### Pasos para generar el `.aab`

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://[tudominio].com.ar/admin/manifest.json
bubblewrap build
```

Esto te va a pedir generar (o usar) un keystore. **El SHA-256 de ese keystore es el que tenés que pegar en `.well-known/assetlinks.json`** reemplazando el placeholder `REEMPLAZAR_CON_SHA256_DEL_KEYSTORE_DE_BUBBLEWRAP`. Bubblewrap te muestra ese hash al final del `build`, o lo podés sacar con:

```bash
keytool -list -v -keystore android.keystore -alias android
```

Después de actualizar `assetlinks.json`, hay que volver a deployar el sitio (no la app) para que el archivo quede publicado en `/.well-known/assetlinks.json` — eso es lo que Android usa para verificar que el dueño del dominio autorizó esa app.

### Checklist de publicación

- [ ] `.aab` generado y probado en un dispositivo Android real (instalar el `.aab` localmente con `bubblewrap install` antes de subir a Play Console)
- [ ] Cuenta Google Play Console creada
- [ ] Ficha de la app completa: nombre, descripción corta y larga, ícono 512x512, capturas de pantalla (mínimo 2, mobile)
- [ ] Política de privacidad publicada (la necesita Play Console para aprobar la ficha — usar la misma que tenga la landing)
- [ ] Subir `.aab`, esperar revisión de Google (3 a 7 días hábiles)

**Decisión a tomar:** ¿se publica solo el admin, solo la app de chofer, o las dos como apps separadas en Play Store? Lo más probable es que tenga sentido comercial publicar el **admin** (es lo que ve el dueño/decisor de la distribuidora que busca el producto en la tienda) y dejar la app de chofer como instalación directa vía link/QR para el personal interno, sin pasar por Play Store.

---

## 7.3 iOS

Confirmado como baja prioridad por el propio plan, y no hay nada para adelantar sin una decisión de negocio primero (¿hay clientes pidiéndolo concretamente?). Si en algún momento se vuelve necesario:

- Cuenta Apple Developer: $99 USD/año.
- Necesita Mac para compilar (o un servicio cloud tipo MacStadium).
- No hay equivalente a TWA; la opción es Capacitor + WKWebView.
- Apple es más estricto rechazando apps que sean "solo un sitio web" — probablemente haya que agregar alguna funcionalidad nativa real (push, cámara, etc.) para que pase la revisión, no alcanza con empaquetar la PWA tal cual.

No recomiendo invertir tiempo acá hasta tener tracción y un pedido concreto de un cliente con flota de iPhones.
