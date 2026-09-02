// lib/handlers/pedidos/_helpers.js
// Helpers internos compartidos entre lib/handlers/pedidos/chofer.js y
// lib/handlers/pedidos/devoluciones.js. Extraído de lib/handlers/pedidos.js
// (25/08/2026) como parte del split documentado en
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

import {
  actualizarEstadoRuta,
  listarEstadosEntregasDeRuta,
  obtenerEstadoRuta,
} from '../../repos/pedidos.js';

export async function sincronizarEstadoRuta(ruta_id) {
  if (!ruta_id) return;

  const ruta = await obtenerEstadoRuta(ruta_id);

  // Nunca pisar una ruta cancelada o ya completada.
  if (!ruta || ruta.estado === 'cancelada' || ruta.estado === 'completada') return;

  const entregas = await listarEstadosEntregasDeRuta(ruta_id);

  if (!entregas || entregas.length === 0) return;

  const TERMINALES = ['entregado', 'no_entregado'];
  const todasTerminadas = entregas.every(e => TERMINALES.includes(e.estado));
  const algunaIniciada  = entregas.some(e => TERMINALES.includes(e.estado) || e.estado === 'en_camino');

  let nuevoEstado = null;
  if (todasTerminadas) {
    nuevoEstado = 'completada';
  } else if (algunaIniciada && ruta.estado === 'pendiente') {
    nuevoEstado = 'en_camino';
  }

  if (nuevoEstado && nuevoEstado !== ruta.estado) {
    await actualizarEstadoRuta(ruta_id, nuevoEstado);
  }
}

export function hoyArgentina() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

export function validarImagenReal(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
