// lib/utils/storage-urls.js
// Helper compartido para servir archivos de buckets privados de Storage
// (SEC-05 — auditoría integral 2026: remitos, devoluciones y
// facturas-proveedor pasaron de `public=true` a `public=false`).
//
// A partir de ahora las columnas foto_url/archivo_url/firma_url en DB NO
// contienen una URL pública: contienen el PATH del objeto dentro del
// bucket (ej: "<empresa_id>/<chofer_id>/foto-169...jpg"). La URL firmada
// se genera recién al momento de responder al cliente, con vencimiento
// corto, usando el client de service_role (el único rol con permiso de
// lectura sobre estos tres buckets).
//
// Los uploads (endpoints POST) deben guardar `path`, no `publicUrl`.
// Los reads (endpoints GET / listados) deben pasar el row por
// `firmarCampoUrl` / `firmarCampoUrlEnLista` antes de responder.

const EXPIRACION_DEFAULT_SEG = 60 * 10; // 10 minutos: alcanza para cargar la vista, no queda "viva" para siempre

/**
 * Genera una signed URL para un único path. Devuelve null si el path es
 * null/vacío (mismo comportamiento que antes con foto_url/archivo_url
 * ausente) o si falla la firma (no tira excepción para no romper listados
 * completos por un solo archivo con problema).
 */
export async function firmarUrlStorage(client, bucket, path, expiracionSeg = EXPIRACION_DEFAULT_SEG) {
  if (!path) return null;

  // Compatibilidad con datos viejos: si por algún motivo todavía quedara
  // una URL pública completa en vez de un path (registros previos a la
  // migración de datos de SEC-05), extraemos el path de ahí en vez de
  // fallar.
  const pathLimpio = extraerPathDeUrlPublicaSiHaceFalta(bucket, path);

  // FIX (2026-08-25, auditoría CPU Hobby): se encontraron filas (11 en
  // devoluciones, 4 en entregas) con foto_url/firma_url = 'demo://foto/...'
  // — data huérfana de un seed viejo, ningún script vigente del repo genera
  // ese esquema. Cada lectura de esas filas terminaba llamando a
  // createSignedUrl() contra Storage, que siempre fallaba con "Object not
  // found" (ida y vuelta HTTP + log de error, tirado a la basura). Ya se
  // limpiaron las filas existentes (migración 546), pero se corta acá
  // también por las dudas: si después de intentar limpiar una URL pública
  // legítima el valor TODAVÍA tiene forma de esquema ("algo://"), no es un
  // path real de Storage y no vale la pena ni intentar firmarlo.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathLimpio)) {
    console.warn(`[storage-urls] Path con esquema no soportado, se omite firma: ${bucket}/${pathLimpio}`);
    return null;
  }

  const { data, error } = await client.storage.from(bucket).createSignedUrl(pathLimpio, expiracionSeg);
  if (error) {
    console.error(`[storage-urls] No se pudo firmar ${bucket}/${pathLimpio}:`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * Reemplaza `objeto[campo]` (un path) por su signed URL. Devuelve un
 * objeto nuevo (no muta el original) para evitar efectos secundarios en
 * cachés/objetos compartidos por otras partes del handler.
 */
export async function firmarCampoUrl(client, bucket, objeto, campo, expiracionSeg = EXPIRACION_DEFAULT_SEG) {
  if (!objeto) return objeto;
  const url = await firmarUrlStorage(client, bucket, objeto[campo], expiracionSeg);
  return { ...objeto, [campo]: url };
}

/**
 * Igual que firmarCampoUrl pero para un array de filas (listados). Firma
 * en paralelo para no serializar N llamadas a Storage.
 */
export async function firmarCampoUrlEnLista(client, bucket, filas, campo, expiracionSeg = EXPIRACION_DEFAULT_SEG) {
  if (!Array.isArray(filas) || filas.length === 0) return filas;
  return Promise.all(filas.map((fila) => firmarCampoUrl(client, bucket, fila, campo, expiracionSeg)));
}

/**
 * Variante para filas con más de un campo de archivo (ej: pedidos con
 * firma_url Y foto_url, ambos del bucket 'remitos').
 */
export async function firmarCamposUrl(client, bucket, objeto, campos, expiracionSeg = EXPIRACION_DEFAULT_SEG) {
  if (!objeto) return objeto;
  const entradas = await Promise.all(
    campos.map(async (campo) => [campo, await firmarUrlStorage(client, bucket, objeto[campo], expiracionSeg)])
  );
  return { ...objeto, ...Object.fromEntries(entradas) };
}

export async function firmarCamposUrlEnLista(client, bucket, filas, campos, expiracionSeg = EXPIRACION_DEFAULT_SEG) {
  if (!Array.isArray(filas) || filas.length === 0) return filas;
  return Promise.all(filas.map((fila) => firmarCamposUrl(client, bucket, fila, campos, expiracionSeg)));
}

function extraerPathDeUrlPublicaSiHaceFalta(bucket, valor) {
  const marcador = `/storage/v1/object/public/${bucket}/`;
  const idx = valor.indexOf(marcador);
  if (idx === -1) return valor; // ya es un path limpio
  return decodeURIComponent(valor.slice(idx + marcador.length));
}
