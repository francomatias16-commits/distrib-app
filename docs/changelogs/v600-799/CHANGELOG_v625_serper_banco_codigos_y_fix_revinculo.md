# CHANGELOG v625 — Imagen precisa (sin ML) + refrescar cache + fix reconexión celular

## Problema 1: imagen incorrecta al escanear productos

### Síntoma
Al escanear un producto (p. ej. TALCO VERITAS código 7791520009729), el sistema
cargaba el nombre correcto pero una imagen completamente equivocada — una foto
verde de otro producto, que se repetía aunque se re-escaneara.

### Causa raíz: dos problemas encadenados

**A) La imagen de ML es de un vendedor tercero, no del fabricante.**
Los vendedores de Mercado Libre suben sus propias fotos, que frecuentemente
son incorrectas, están en contexto equivocado o no corresponden al EAN del
producto. Cuando Serper buscaba `"7791520009729 producto"` en imágenes, la
página con ese código en ML aparecía con la foto del vendedor (incorrecta) y
esa foto se cacheaba como correcta.

**B) La imagen incorrecta quedaba cacheada en `banco_codigos_producto`.**
Una vez guardada, todas las búsquedas posteriores del mismo código devolvían
el cache sin re-consultar las fuentes externas — la imagen errónea era
"permanente" hasta borrar la fila en Supabase manualmente.

---

### Fix A: búsqueda de imagen por nombre, excluyendo ML de los primeros intentos

La imagen ahora se busca en este orden de prioridad:

| Intento | Fuente | Por qué |
|---------|--------|---------|
| 1 | Carrefour, COTO, Farmacity, Jumbo, La Anónima | Cadenas que sincronizan fotos con el fabricante — máxima confiabilidad |
| 2 | Búsqueda general **sin ML** | Otros retailers, sitio del fabricante, prensa — sin 3P de ML |
| 3 | Mercado Libre (último recurso) | Solo si todo lo anterior falla |

```js
// ANTES — ML primero (foto de vendedor tercero, poco confiable)
const porML = await buscarImagenSerper(`site:mercadolibre.com.ar ${nombre}`);

// AHORA — supermercados primero (fotos verificadas por la cadena)
const SUPERMERCADOS = 'site:carrefour.com.ar OR site:cotodigital3.com.ar OR ...';
const porSuper = await buscarImagenSerper(`(${SUPERMERCADOS}) ${nombre}`);
// → si no encuentra → búsqueda sin ML → si no → ML como último recurso
```

---

### Fix B: acción `refrescar` en banco-codigos + botón "Imagen incorrecta"

**Backend:** nuevo endpoint `POST /api/banco-codigos?accion=refrescar { codigo }`:
1. Borra la foto almacenada en Storage (`banco-codigos/<codigo>.jpg`).
2. Pone `foto_url = null` en `banco_codigos_producto` (sin borrar el nombre).
3. Re-ejecuta `buscarEnFuentesExternas` completo con la nueva estrategia.
4. Guarda el resultado nuevo en el banco.
5. Devuelve `{ ok, encontrado, nombre, foto_url, fuente }`.

**Frontend:** nuevo botón "⚠ Imagen incorrecta — intentar otra" en
`productos-scanner-remoto.js`. Aparece automáticamente debajo de la foto
cada vez que el auto-scan completa la imagen. Si la foto es correcta, el
usuario simplemente la ignora. Si es incorrecta, la toca y:
- El backend re-busca con la nueva estrategia (supermercados primero).
- Si encuentra una imagen distinta → la carga en el formulario.
- Si no encuentra ninguna → quita la imagen y avisa que cargue a mano.

---

## Problema 2: Serper en DOS FASES para nombre y imagen separados

### Por qué separar nombre de imagen

Buscar imagen directamente por código de barras (`"7791520009729 producto"` en
Google Images) es impreciso: Google puede devolver cualquier página que
mencione ese número, incluyendo páginas donde figura en contexto equivocado.

**Nueva estrategia en banco-codigos.js:**

```
Fase 1 (web search, endpoint /search):
  Busca "7791520009729 producto" → extrae el nombre del <title> de tiendas
  conocidas o del Knowledge Graph de Google → "TALCO VERITAS ORIGINAL 180G"

Fase 2 (image search, endpoint /images):
  Busca "TALCO VERITAS ORIGINAL 180G" en supermercados/farmacias
  → foto verificada del fabricante ✓
```

---

## Problema 3: hay que vincular el celular en cada escaneo de producto

### Síntoma
Al escanear el segundo producto, el modal de "Vincular celular" mostraba el
QR estáticamente — el usuario tenía que re-escanear aunque el celular seguía
activo en la URL del scanner.

### Fix: ping automático + QR nuevo si no responde

Cuando `abrir()` detecta token vivo pero `camaraConectada=false`:

1. Muestra "Reconectando…" (spinner, no QR estático).
2. Envía `ping` al celular → responde `listo` en ~1-2s → "Conectado" ✓
3. Si no responde en 6s → genera QR nuevo automáticamente ✓

---

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `lib/handlers/banco-codigos.js` | Fix imagen: supermercados antes que ML; acción `refrescar`; Serper dos fases |
| `frontend/admin/js/productos-scanner-remoto.js` | Botón "Imagen incorrecta" con llamada a `refrescar` |
| `frontend/shared/vincular-celular.js` | Reconexión automática: ping → QR nuevo si no responde |

## Sin cambios necesarios

- Supabase / migraciones: no requiere tabla nueva (usa la misma `banco_codigos_producto`)
- `frontend/scan-pos/portal.js`: sin cambios
- `api/index.js`: sin cambios
- `lib/handlers/pos-scanner.js`: sin cambios
