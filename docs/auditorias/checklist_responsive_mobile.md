# Checklist de pase manual — Auditoría Responsive Mobile (sección 4)

**Objetivo:** el análisis estático de `AUDITORIA_RESPONSIVE_MOBILE.md` cubrió el
100% del código, pero no reemplaza ver el layout real en pantalla — esto es lo
que queda para confirmar a ojo, en el celular o en el emulador del navegador
(F12 → ícono de celular/tablet → elegir tamaño).

Marcá cada ✅ a medida que lo probás. Si algo se ve roto, anotá la página
exacta, el ancho de pantalla y qué se ve (una captura ayuda mucho).

---

## 0. PRIORITARIO — Hero de la landing tras sacar los `!important` (v945)

Esto es lo que se tocó en esta sesión (`frontend/landing/mobile-hero-v935.css`):
se sacaron los 85 `!important` del archivo. El análisis de cascada dice que no
debería cambiar nada visualmente (todo ganaba por orden de carga + misma
especificidad igual), pero es exactamente el tipo de cambio que la propia
auditoría marca como "no confiar solo en el análisis estático" — por eso es lo
primero a mirar, antes que el resto del checklist.

1. Abrir `/` (la landing) en el celular real (no solo emulador), con caché
   vacía o en modo incógnito para asegurar que carga `mobile-hero-v935.css?v=20260822-04`
   y no una versión vieja cacheada.
2. ✅ El hero (título + diapositiva + carril de puntos) se ve igual que antes:
   texto arriba, diapositiva debajo, botón "Entrar a la demo en vivo" debajo de
   la diapositiva, carril de puntos horizontal al final.
3. ✅ El botón "Ver cómo funciona" sigue sin aparecer en mobile (debe verse
   solo "Entrar a la demo en vivo").
4. Hacer scroll lento a través de todo el hero.
5. ✅ Las diapositivas cambian de forma sincronizada con el scroll, sin saltos
   raros ni congelamientos — esto depende de `hero-transitions-v937.css`, que
   no se tocó, pero conviene confirmar que sigue andando igual.
6. ✅ Ningún elemento decorativo de escritorio (círculos, texto flotante
   "01 PEDIDO · 02 STOCK...") aparece superpuesto al texto en mobile.
7. Repetir los pasos 2-6 en al menos dos tamaños distintos (ver sección 1)
   y, si es posible, en un Android real además de iPhone — son motores de
   renderizado distintos.

---

## 1. Anchos de pantalla mínimos (emulador o dispositivo real)

- [ ] 360×640 (Android gama baja/media — el más común en LatAm)
- [ ] 390×844 (iPhone 12/13/14 estándar)
- [ ] 320×568 (iPhone SE / el "peor caso" real)

En cada uno, recorrer al menos: landing (`/`), un módulo de landing
(`/modulos/...`), `/cliente/catalogo`, `/cliente/checkout`, `/admin/pos`, y
dos o tres pantallas admin al azar. Buscar específicamente: texto o botones
cortados, contenido que se sale de la pantalla (scroll horizontal inesperado),
elementos que se superponen entre sí.

## 2. Rotación landscape

- [ ] `/cliente/checkout` — rotar el celular a horizontal a mitad de un
      formulario largo. ✅ El contenido sigue siendo usable, sin campos
      cortados ni botón de confirmar fuera de pantalla.
- [ ] `/chofer/remito` — mismo chequeo, es la pantalla que más usa el
      repartidor en la calle.

## 3. Teclado virtual abierto en formularios largos

- [ ] `/cliente/checkout`, `/cliente/cuenta`, `/chofer/login` — abrir el
      teclado tocando un input de texto. ✅ El campo activo queda visible
      (no tapado por el teclado) y el botón de submit sigue siendo
      alcanzable con scroll.

## 4. Safari iOS específicamente

- [ ] Revisar cada input de `/cliente/checkout` y `/chofer/login`. ✅ Ningún
      input dispara zoom automático al enfocar (si alguno lo hace, es un
      `font-size` menor a 16px en ese input — anotar cuál).
- [ ] Confirmar que el pinch-to-zoom funciona en toda la landing (el
      `maximum-scale=1` que lo bloqueaba ya se sacó — solo falta confirmar en
      un iPhone real).

---

## Resumen para reportar

Al terminar, contame:
- Qué ítems marcaste ✅ sin problemas.
- Cualquier ❌: página exacta, ancho de pantalla, qué esperabas vs. qué viste
  (una captura ayuda mucho).
