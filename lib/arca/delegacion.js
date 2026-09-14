// lib/arca/delegacion.js
//
// Verifica si una empresa en modo_certificado='delegado' (ver migración
// 628) ya autorizó a la CUIT del proveedor a facturar en su nombre desde
// su propio Administrador de Relaciones de Clave Fiscal.
//
// No hay un webservice de ARCA que informe "¿fulano me delegó tal
// servicio?" de forma directa. La forma estándar de verificarlo es hacer
// una llamada de solo lectura (FECompUltimoAutorizado) usando el token del
// PROVEEDOR pero pidiendo el <Auth><Cuit> de la EMPRESA: si la delegación
// está activa, ARCA responde con el último número de comprobante (aunque
// sea 0); si no, responde con un SOAP Fault del estilo "CUIT no autorizado
// a acceder al servicio". Esa llamada no tiene efectos secundarios.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { obtenerTokenWSAA } from './wsaa.js';
import { consultarUltimoNumero, WSFEV1_URL } from './wsfev1.js';

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

/**
 * Verifica contra ARCA si la delegación de la empresa está activa, y
 * actualiza facturacion_config.estado_delegacion con el resultado.
 *
 * @param {string} empresaId
 * @returns {{ estado: 'activa'|'rechazada'|'pendiente', mensaje: string }}
 */
export async function verificarDelegacionArca(empresaId) {
  const { data: config, error } = await supabase
    .from('facturacion_config')
    .select('cuit, punto_venta, homologacion, modo_certificado')
    .eq('empresa_id', empresaId)
    .eq('activo', true)
    .maybeSingle();

  if (error) {
    throw new Error(`[delegacion] Error leyendo facturacion_config: ${error.message}`);
  }
  if (!config) {
    throw new Error(`[delegacion] La empresa ${empresaId} no tiene facturacion_config activa.`);
  }
  if (config.modo_certificado === 'propio') {
    // No aplica: esta empresa usa su propio certificado, no depende de
    // ninguna delegación al proveedor.
    return { estado: 'activa', mensaje: 'Esta empresa usa certificado propio, no aplica delegación.' };
  }
  if (!config.cuit || !config.punto_venta) {
    return {
      estado: 'pendiente',
      mensaje: 'Faltan CUIT o punto de venta en la configuración de facturación.',
    };
  }

  let resultado;
  try {
    const { token, sign } = await obtenerTokenWSAA(empresaId, { service: 'wsfe' });
    const url = config.homologacion ? WSFEV1_URL.homologacion : WSFEV1_URL.produccion;

    // Probamos con Factura C (tipo 11) por ser el tipo más habilitado por
    // defecto; el objetivo no es el número en sí sino confirmar que ARCA
    // acepta el <Auth><Cuit> de esta empresa con el token del proveedor.
    await consultarUltimoNumero({
      url,
      token,
      sign,
      cuit: config.cuit,
      ptoVenta: config.punto_venta,
      tipoCbte: 11,
    });

    resultado = { estado: 'activa', mensaje: 'Delegación verificada correctamente.' };
  } catch (err) {
    const mensaje = err?.message || String(err);
    const noAutorizado = /no autorizad|no encuentra relacion|not authorized|cuit.*no.*habilitad/i.test(mensaje);

    resultado = noAutorizado
      ? {
          estado: 'pendiente',
          mensaje:
            'ARCA todavía no reconoce la delegación. Puede tardar unos minutos ' +
            'en propagarse después de confirmarla, o falta hacerla.',
        }
      : { estado: 'rechazada', mensaje: `Error verificando contra ARCA: ${mensaje}` };
  }

  await supabase
    .from('facturacion_config')
    .update({
      estado_delegacion: resultado.estado,
      delegacion_verificada_en: new Date().toISOString(),
      delegacion_error: resultado.estado === 'activa' ? null : resultado.mensaje,
    })
    .eq('empresa_id', empresaId);

  return resultado;
}

/**
 * Datos que necesita el wizard para mostrarle al usuario qué CUIT tiene
 * que autorizar. No expone nada del certificado (ni falta que hace).
 */
export async function obtenerDatosDelegacion() {
  const cuitProveedorHomo = process.env.ARCA_PROVEEDOR_CUIT;
  if (!cuitProveedorHomo) {
    throw new Error('[delegacion] Falta la env var ARCA_PROVEEDOR_CUIT.');
  }
  return { cuitProveedor: cuitProveedorHomo };
}
