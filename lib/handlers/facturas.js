// lib/handlers/facturas.js
// GET  /api/facturas             → lista de facturas
// GET  /api/facturas?id=uuid     → detalle de una factura
// POST /api/facturas             → emitir factura para un pedido
// POST /api/facturas?accion=anular      → anular factura (ver vercel.json rewrite)
// POST /api/facturas?accion=reintentar  → reintentar emisión (ver vercel.json rewrite)
//
// GET  /api/facturas/config             → lee la config de facturación ARCA
// POST /api/facturas/config             → guarda la config de facturación ARCA
// POST /api/facturas/config?accion=test → verifica las credenciales contra WSAA/ARCA
//
// v2: integración directa con ARCA (WSFEv1 / WSAA) — se eliminó TusFacturasAPP.
//
// NOTA: anular/reintentar/config/notas-credito se consolidaron acá para no
// superar el límite de 12 Serverless Functions del plan Hobby de Vercel.

import { crearClienteSupabaseLazy } from '../supabase-lazy.js';
import { emitirFactura, anularFactura } from '../facturas.js';
import { obtenerTokenWSAA } from '../arca/wsaa.js';
import { emitirNotaCreditoARCA } from '../arca/wsfev1.js';
import { generarPDFComprobante } from '../arca/comprobante-pdf.js';
import { rateLimit } from '../rate-limit.js';
import { cifrar } from '../crypto-secrets.js';
import { esEmpresaDemo } from '../demo-mode.js';
import { errorSeguro } from '../error-response.js';
import { puede } from '../permisos-service.js';
import * as FacturasRepo from '../repos/facturas.js';

const limiterLectura = rateLimit({ max: 60, windowMs: 60_000 });
const limiterEmision = rateLimit({ max: 10, windowMs: 60_000 }); // llamadas a ARCA, límite estricto
const limiterConfig  = rateLimit({ max: 20, windowMs: 60_000 });

const supabase = crearClienteSupabaseLazy(() => [process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY]);

export default async function handler(req, res) {
  // ── Sub-router: notas-credito ───────────────────────────────────────────
  const _svc = req.query._svc;
  if (_svc === 'notas-credito') return handleNotasCredito(req, res);
  if (_svc === 'comprobantes-historicos') return handleComprobantesHistoricos(req, res);

  // OPTIONS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Rate limiting ───────────────────────────────────────────────────────
  const { accion, recurso } = req.query;
  if (req.method === 'GET') {
    if (await limiterLectura(req, res)) return;
  } else if (req.method === 'POST' && !accion && recurso !== 'config') {
    if (await limiterEmision(req, res)) return;
  } else {
    if (await limiterConfig(req, res)) return;
  }

  if (recurso === 'config') {
    return configHandler(req, res);
  }

  if (req.method === 'POST' && accion === 'anular') {
    return anularFacturaHandler(req, res);
  }

  if (req.method === 'POST' && accion === 'reintentar') {
    return reintentarFacturaHandler(req, res);
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await FacturasRepo.obtenerPerfilFacturas(user.id);

  if (!perfil) return res.status(403).json({ error: 'Usuario no encontrado' });

  const empresa_id = perfil.empresa_id;
  const esAdmin    = puede(perfil, 'acceder', 'facturas');
  const esCliente  = perfil.rol === 'cliente';

  if (!esAdmin && !esCliente)
    return res.status(403).json({ error: 'Sin permisos para ver facturas' });

  if (req.method === 'GET') {
    const { id, estado, page = '1', limit = '50' } = req.query;

    if (id && accion === 'pdf') {
      const { data: factura, error: errFactura } = await FacturasRepo.obtenerFacturaParaPdf(id, empresa_id);

      if (errFactura || !factura) return res.status(404).json({ error: 'Factura no encontrada' });

      if (esCliente) {
        const cli = await FacturasRepo.obtenerClientePorEmail(user.email, empresa_id);
        if (!cli || factura.cliente_id !== cli.id)
          return res.status(403).json({ error: 'Acceso denegado' });
      }

      const { ok, url, error } = await generarPDFComprobante(id);
      if (!ok) return res.status(500).json({ error });
      return res.json({ ok: true, url });
    }

    if (id) {
      const { data, error } = await FacturasRepo.obtenerFacturaDetalle(id, empresa_id);

      if (error) return res.status(404).json({ error: 'Factura no encontrada' });

      if (esCliente) {
        const cli = await FacturasRepo.obtenerClientePorEmail(user.email, empresa_id);
        if (!cli || data.cliente_id !== cli.id)
          return res.status(403).json({ error: 'Acceso denegado' });
      }

      return res.json(data);
    }

    let cliente_id_filtro;
    if (esCliente) {
      const cli = await FacturasRepo.obtenerClientePorEmail(user.email, empresa_id);
      if (cli) cliente_id_filtro = cli.id;
    }

    const offsetLista = (+page - 1) * +limit;
    const { data, error, count } = await FacturasRepo.listarFacturasFiltradas(empresa_id, {
      estado, cliente_id: cliente_id_filtro, offset: offsetLista, limit: +limit,
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ data, total: count });
  }

  if (req.method === 'POST') {
    if (!esAdmin) return res.status(403).json({ error: 'Sin permisos para emitir facturas' });

    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id requerido' });

    // FIX (FACTURAS-002, auditoría 2026-07-26): antes se llamaba a
    // emitirFactura(pedido_id) directo con el valor del body, sin validar
    // que el pedido perteneciera a la empresa del usuario autenticado.
    // traerOrigenPedido() (lib/facturas.js) hace `.eq('id', pedidoId)` sin
    // filtro de empresa_id (usa el cliente service_role, bypassea RLS), así
    // que cualquier dueno/admin/contador de CUALQUIER empresa podía emitir
    // una factura ARCA real para un pedido de OTRA empresa, usando el
    // certificado/CUIT de esa otra empresa (facturacionConfig se resuelve
    // por pedido.empresa_id) — forzando la emisión de un comprobante fiscal
    // real que la empresa dueña del pedido no pidió.
    const { data: pedidoCheck, error: pedidoCheckErr } = await FacturasRepo.obtenerPedidoParaFactura(pedido_id);

    if (pedidoCheckErr || !pedidoCheck) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (pedidoCheck.empresa_id !== empresa_id) {
      return res.status(403).json({ error: 'No tenés acceso a este pedido' });
    }

    const resultado = await emitirFactura(pedido_id, user.id);
    if (!resultado?.ok) {
      // 422: condición de configuración pendiente, no una falla del servidor —
      // el frontend usa este código para mostrar un aviso claro y accionable
      // en vez de un toast de error genérico (ver pedidos.js:generarFactura).
      const status = resultado?.codigo === 'sin_configuracion_facturacion' ? 422 : 500;
      return res.status(status).json({
        error: resultado?.error || 'Error al emitir factura',
        codigo: resultado?.codigo || null,
      });
    }
    return res.json(resultado);
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ── Anular factura ──────────────────────────────────────────────────────────
// Body esperado: { factura_id: string, motivo: string }
async function anularFacturaHandler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const usuarioData = await FacturasRepo.obtenerUsuarioParaGestionFactura(user.id);

  if (!usuarioData || !['dueno', 'admin', 'contador'].includes(usuarioData.rol)) {
    return res.status(403).json({ error: 'No tenés permisos para anular facturas' });
  }

  const { factura_id, motivo } = req.body || {};
  if (!factura_id) return res.status(400).json({ error: 'Falta factura_id' });
  if (!motivo || !motivo.trim()) return res.status(400).json({ error: 'Falta el motivo de la anulación' });

  const { data: factura, error: facturaError } = await FacturasRepo.obtenerFacturaCompleta(factura_id);

  if (facturaError || !factura) {
    return res.status(404).json({ error: 'Factura no encontrada' });
  }

  if (factura.empresa_id !== usuarioData.empresa_id) {
    return res.status(403).json({ error: 'No tenés acceso a esta factura' });
  }

  if (factura.estado !== 'emitida') {
    return res.status(400).json({ error: 'Solo se pueden anular comprobantes emitidos' });
  }

  const resultado = await anularFactura(factura, motivo.trim(), user.id);

  if (!resultado.ok) {
    return res.status(422).json({ error: resultado.error });
  }

  return res.status(200).json({ ok: true, factura: resultado.factura });
}

// ── Reintentar emisión ──────────────────────────────────────────────────────
// Body esperado: { factura_id: string }
async function reintentarFacturaHandler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const usuarioData = await FacturasRepo.obtenerUsuarioParaGestionFactura(user.id);

  if (!usuarioData || !['dueno', 'admin', 'contador'].includes(usuarioData.rol)) {
    return res.status(403).json({ error: 'No tenés permisos para reintentar facturas' });
  }

  const { factura_id } = req.body || {};
  if (!factura_id) {
    return res.status(400).json({ error: 'Falta factura_id' });
  }

  const { data: factura, error: facturaError } = await FacturasRepo.obtenerFacturaParaReintentar(factura_id);

  if (facturaError || !factura) {
    return res.status(404).json({ error: 'Factura no encontrada' });
  }

  if (factura.empresa_id !== usuarioData.empresa_id) {
    return res.status(403).json({ error: 'No tenés acceso a esta factura' });
  }

  if (!['pendiente', 'error_afip'].includes(factura.estado)) {
    return res.status(400).json({ error: 'Esta factura ya fue emitida o anulada' });
  }

  if (!factura.pedido_id) {
    return res.status(400).json({ error: 'La factura no tiene un pedido asociado' });
  }

  const resultado = await emitirFactura(factura.pedido_id, user.id);

  if (!resultado.ok) {
    return res.status(422).json({ error: resultado.error, codigo: resultado.codigo || null });
  }

  return res.status(200).json({ ok: true, factura: resultado.factura });
}

// ── Configuración de facturación ARCA ──────────────────────────────────────
// GET  /api/facturas/config        → estado de configuración (sin exponer cert/clave)
// POST /api/facturas/config        → guarda CUIT, punto de venta, cert PEM, clave PEM
// POST /api/facturas/config?accion=test → prueba token WSAA con las credenciales cargadas
//
// Solo rol dueno o admin.
// El cert_pem y key_pem NUNCA viajan en la respuesta GET: eso lo
// garantiza tanto la RLS de facturacion_config como esta función, que
// solo devuelve la columna `configurado` + metadatos no sensibles.
async function configHandler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await FacturasRepo.obtenerPerfilFacturas(user.id);

  if (!perfil || !['dueno', 'admin'].includes(perfil.rol)) {
    return res.status(403).json({ error: 'Solo el dueño o admin pueden configurar la facturación' });
  }

  const empresa_id = perfil.empresa_id;

  // ── GET: leer estado de configuración (sin credenciales) ───────────────
  if (req.method === 'GET') {
    // get_facturacion_config() es una RPC SECURITY DEFINER que nunca expone
    // cert_pem ni key_pem (ver migración 085_facturacion_arca.sql).
    const { data, error } = await FacturasRepo.obtenerConfigFacturacionRpc();

    if (error) {
      console.error('[CONFIG ARCA] Error leyendo facturacion_config:', error.message);
      return res.status(500).json({ error: 'Error al leer la configuración' });
    }

    // La RPC devuelve null si no hay fila — se normaliza como "sin configurar"
    const cfg = data?.[0] ?? null;

    return res.json({
      configurado:   cfg?.configurado ?? false,
      cuit:          cfg?.cuit          || '',
      punto_venta:   cfg?.punto_venta   ?? '',
      condicion_iva: cfg?.condicion_iva || '',
      razon_social:  cfg?.razon_social  || '',
      domicilio:     cfg?.domicilio     || '',
      homologacion:  cfg?.homologacion  ?? true,
      activo:        cfg?.activo        ?? false,
    });
  }

  // ── POST: guardar o testear ───────────────────────────────────────────
  if (req.method === 'POST') {
    if (req.query.accion === 'test') return testearCredencialesARCA(req, res, empresa_id);
    return guardarConfigARCA(req, res, empresa_id);
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// Guarda (upsert) la configuración ARCA para la empresa.
// Acepta los campos no sensibles siempre; cert_pem y key_pem son opcionales
// para poder actualizar CUIT / punto_venta sin tener que resubir el cert.
async function guardarConfigARCA(req, res, empresa_id) {
  const {
    cuit, punto_venta, condicion_iva, razon_social, domicilio,
    cert_pem, key_pem, homologacion,
  } = req.body || {};

  // ── Corte de modo demo — mismo patrón que Mercado Pago/WhatsApp/email ──
  // No bloqueamos editar cuit/razon_social/etc. (no son sensibles y de
  // todos modos se resetean), pero nadie debería poder pegar un
  // certificado/clave REAL de ARCA en la cuenta demo pública compartida.
  if ((cert_pem || key_pem) && await esEmpresaDemo(empresa_id)) {
    return res.status(403).json({
      error: 'Cargar certificado/clave de ARCA está deshabilitado en la cuenta demo pública.',
    });
  }

  if (!cuit || !punto_venta) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: cuit y punto_venta son requeridos',
    });
  }

  // Leer la fila existente para hacer un upsert que no pise cert/key si no vienen
  const existente = await FacturasRepo.obtenerCertKeyExistente(empresa_id);

  const upsertData = {
    empresa_id,
    cuit:          cuit.trim().replace(/-/g, ''),
    punto_venta:   parseInt(punto_venta, 10),
    condicion_iva: condicion_iva?.trim() || null,
    razon_social:  razon_social?.trim()  || null,
    domicilio:     domicilio?.trim()     || null,
    homologacion:  homologacion !== false, // default true
    activo:        true,
    updated_at:    new Date().toISOString(),
    // Solo pisar cert/key si vienen en el body; conservar los anteriores si no.
    // SEGURIDAD: se cifran con AES-256-GCM antes de guardar (ver lib/crypto-secrets.js).
    // El certificado/clave privada de ARCA nunca debe quedar en texto plano en la BD.
    cert_pem:      cert_pem?.trim() ? cifrar(cert_pem.trim()) : (existente?.cert_pem || null),
    key_pem:       key_pem?.trim()  ? cifrar(key_pem.trim())  : (existente?.key_pem  || null),
  };

  const { error } = await FacturasRepo.guardarConfigFacturacion(upsertData);

  if (error) {
    console.error('[CONFIG ARCA] Error al guardar facturacion_config:', error.message);
    return res.status(500).json({ error: 'No se pudo guardar la configuración' });
  }

  return res.json({ ok: true, mensaje: 'Configuración ARCA guardada correctamente' });
}

// Prueba las credenciales intentando obtener un token WSAA real.
// No emite ningún comprobante; solo verifica que cert + clave + CUIT sean válidos
// y que ARCA responda correctamente en el entorno configurado (homo/producción).
async function testearCredencialesARCA(req, res, empresa_id) {
  // ── Corte de modo demo ────────────────────────────────────────────────
  // Esto dispara una llamada real a WSAA (AFIP/ARCA). Ninguna empresa demo
  // tiene motivo legítimo para probar credenciales reales de un tercero.
  if (await esEmpresaDemo(empresa_id)) {
    return res.status(403).json({
      ok: false,
      error: 'Probar credenciales de ARCA está deshabilitado en la cuenta demo pública.',
    });
  }

  try {
    const resultado = await obtenerTokenWSAA(empresa_id, { forzarRenovacion: true });

    return res.json({
      ok:        true,
      mensaje:   'Conexión con ARCA exitosa. Certificado y clave válidos.',
      expiration: resultado.expiration,
    });

  } catch (err) {
    console.error('[CONFIG ARCA] Error testeando credenciales:', err.message);

    // Distinguir errores comunes para dar feedback útil en el frontend
    let detalle = err.message;
    if (detalle.includes('cert_pem') || detalle.includes('key_pem')) {
      detalle = 'Falta cargar el certificado y/o la clave privada en la configuración.';
    } else if (detalle.includes('WSAA rechazó')) {
      // El mensaje de WSAA ya viene formateado desde wsaa.js
    } else if (detalle.includes('Error de red')) {
      detalle = 'No se pudo conectar con ARCA. Verificar conectividad o estado del servicio.';
    }

    return res.status(400).json({ ok: false, error: detalle });
  }
}

// ── Notas de Crédito ────────────────────────────────────────────────────────
// Absorto desde api/notas-credito/index.js para no superar el límite
// de Serverless Functions.
//
// Cambio v2: el bloque "emitir contra AFIP" ahora llama a
// emitirNotaCreditoARCA() (lib/arca/wsfev1.js) en vez de enviar a FacturAPI.
// Todo lo demás (lectura, creación pendiente, aplicar_nota_credito_cta_cte)
// permanece igual.

async function handleNotasCredito(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await FacturasRepo.obtenerPerfilFacturas(user.id);

  if (!perfil || !puede(perfil, 'leer', 'notas_credito'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;
  const esEscritor = puede(perfil, 'escribir', 'notas_credito');

  // ── GET ───────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { id, cliente_id, estado, desde, hasta,
            page = '1', limit = '50' } = req.query;

    if (id) {
      const { data, error } = await FacturasRepo.obtenerNotaCreditoDetalle(id, empresa_id);

      if (error || !data) return res.status(404).json({ error: 'Nota de crédito no encontrada' });
      return res.json(data);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { data, error, count } = await FacturasRepo.listarNotasCreditoFiltradas(empresa_id, {
      cliente_id, estado, desde, hasta, offset, limit: parseInt(limit),
    });
    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.json({ notas_credito: data || [], total: count || 0 });
  }

  // ── Escritura ─────────────────────────────────────────────────────
  if (!esEscritor) return res.status(403).json({ error: 'Sin permisos de escritura' });

  if (req.method === 'POST') {
    // ── Emitir NC contra ARCA ────────────────────────────────────
    if (req.query.accion === 'emitir') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id requerido' });

      const { data: nc, error: ncErr } = await FacturasRepo.obtenerNotaCreditoParaEmitir(id, empresa_id);

      if (ncErr || !nc) return res.status(404).json({ error: 'NC no encontrada' });
      if (nc.estado === 'emitida') return res.status(400).json({ error: 'Ya emitida' });

      // Verificar que haya config ARCA activa antes de intentar emitir.
      // La emisión real (token WSAA + SOAP WSFEv1) la hace wsfev1.js.
      const cfgARCA = await FacturasRepo.obtenerConfigArcaActiva(empresa_id);

      if (!cfgARCA) {
        // Sin config ARCA: marcar como emitida manualmente (útil en staging)
        const nroManual = `NC-${nc.tipo}-${Date.now().toString().slice(-6)}`;
        // FIX (auditoría etapa 9): antes no se revisaba el error de este RPC.
        // aplicar_nota_credito_cta_cte estaba rota (INSERT a cta_cte sin
        // empresa_id/monto, ambas NOT NULL) y fallaba SIEMPRE — el fallo
        // quedaba en silencio, el frontend mostraba "NC emitida" pero la NC
        // seguía 'pendiente' y el cliente nunca recibía el crédito. La
        // función ya se corrigió (migración 315), pero se agrega el chequeo
        // acá para que un fallo futuro sea visible en vez de silencioso.
        const { error: errAplicar } = await FacturasRepo.aplicarNotaCreditoCtaCteRpc({
          p_empresa_id: empresa_id,
          p_nc_id:      id,
          p_nc_numero:  nroManual,
          p_cae:        null,
          p_cae_vto:    null,
          p_pdf_url:    null,
        });
        if (errAplicar) {
          console.error('[notas-credito] Error aplicando crédito en cta_cte (modo manual):', errAplicar.message);
          return res.status(500).json({ error: 'No se pudo aplicar el crédito en la cuenta corriente. La NC sigue pendiente, reintentar.' });
        }
        const ncActualizada = await FacturasRepo.obtenerNotaCreditoActualizada(id);
        return res.json({ nc: ncActualizada, modo: 'manual' });
      }

      // Emitir contra ARCA vía wsfev1.js
      // emitirNotaCreditoARCA() recibe el facturaId de la factura original
      // (nc.facturas corresponde a la factura que esta NC cancela).
      try {
        const resultado = await emitirNotaCreditoARCA(nc.factura_id, nc.motivo || '');

        if (!resultado.ok) {
          await FacturasRepo.actualizarNotaCredito(id, {
            estado: 'error_afip',
            notas_error: resultado.error,
          });
          return res.status(422).json({ error: resultado.error });
        }

        // emitirNotaCreditoARCA crea la fila en facturas para la NC y actualiza
        // la factura original como 'anulada. Acá solo necesitamos persistir el
        // resultado en notas_credito y aplicar el crédito en cta_cte.
        //
        // El PDF se genera acá mismo (no en background) para poder guardar la
        // URL en notas_credito.pdf_url de una — antes quedaba siempre en null
        // (ver el comentario viejo "Bloque 4") y no había ninguna forma de
        // acceder al comprobante de la NC desde la interfaz.
        let pdfUrlNC = null;
        try {
          const pdfRes = await generarPDFComprobante(resultado.facturaNCId);
          if (pdfRes.ok) pdfUrlNC = pdfRes.url;
          else console.error('[notas-credito] No se pudo generar el PDF:', pdfRes.error);
        } catch (pdfErr) {
          console.error('[notas-credito] Error generando PDF (no crítico):', pdfErr.message);
        }

        // FIX (auditoría etapa 9): mismo chequeo que en el modo manual arriba
        // — antes no se revisaba el error y un fallo de aplicar_nota_credito_
        // cta_cte quedaba invisible (la NC ya estaba emitida contra ARCA con
        // CAE real, pero el crédito nunca llegaba a la cuenta corriente).
        const { error: errAplicarArca } = await FacturasRepo.aplicarNotaCreditoCtaCteRpc({
          p_empresa_id: empresa_id,
          p_nc_id:      id,
          p_nc_numero:  String(resultado.numero ?? ''),
          p_cae:        resultado.cae        || null,
          p_cae_vto:    resultado.caeVto     || null,
          p_pdf_url:    pdfUrlNC,
        });
        if (errAplicarArca) {
          // La NC YA fue emitida contra ARCA (tiene CAE real, no se puede
          // deshacer) — lo que falló es solo la aplicación del crédito en
          // cta_cte. Se deja registrado en notas_error para que quede
          // visible en el panel y alguien lo aplique a mano, en vez de
          // devolver un 500 que sugeriría reintentar la emisión (generaría
          // una NC duplicada contra ARCA).
          console.error('[notas-credito] NC emitida en ARCA pero falló el crédito en cta_cte:', errAplicarArca.message);
          await FacturasRepo.actualizarNotaCredito(id, {
            notas_error: `CAE obtenido pero el crédito no se aplicó en cta_cte: ${errAplicarArca.message}. Aplicar manualmente.`,
          });
        }

        const ncActualizada = await FacturasRepo.obtenerNotaCreditoActualizada(id);
        return res.json({ nc: ncActualizada });

      } catch (err) {
        console.error('[notas-credito] error ARCA:', err);
        await FacturasRepo.actualizarNotaCredito(id, {
          estado: 'error_afip',
          notas_error: 'Error de conexión con ARCA. Reintentar en unos minutos.',
        });
        return res.status(500).json({ error: 'Error de conexión con ARCA' });
      }
    }

    // ── Crear NC en estado pendiente ──────────────────────────────
    const { cliente_id, factura_id, tipo, motivo, items } = req.body;

    // v200d fix: notas_credito_tipo_check solo permite A/B/C/M y el RPC
    // crear_nota_credito no lo valida (ni tiene EXCEPTION WHEN OTHERS), así
    // que un valor fuera de rango tiraba un 500 crudo de Postgres.
    const TIPOS_NC_VALIDOS = ['A', 'B', 'C', 'M'];
    if (tipo && !TIPOS_NC_VALIDOS.includes(tipo))
      return res.status(400).json({ error: 'tipo debe ser A, B, C o M' });

    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });
    if (!motivo?.trim()) return res.status(400).json({ error: 'motivo requerido' });
    if (!Array.isArray(items) || !items.some(it => it.descripcion && it.precio_unitario > 0))
      return res.status(400).json({ error: 'Se requiere al menos un ítem con descripción y precio' });

    const cli = await FacturasRepo.obtenerClientePorId(cliente_id, empresa_id);
    if (!cli) return res.status(400).json({ error: 'Cliente no encontrado' });

    const itemsFiltrados = items.filter(it => it.descripcion && it.precio_unitario > 0);

    const { data, error } = await FacturasRepo.crearNotaCreditoRpc({
      p_empresa_id: empresa_id,
      p_cliente_id: cliente_id,
      p_tipo:       tipo || 'C',
      p_motivo:     motivo.trim(),
      p_items:      itemsFiltrados,
      p_factura_id: factura_id || null,
      p_created_by: user.id,
    });

    if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

// ── GET /api/facturas?_svc=comprobantes-historicos ─────────────────────────
// Vista global de solo lectura de comprobantes importados vía migración
// (comprobantes_historicos). No hay alta/baja/edición: se cargan únicamente
// desde el wizard de migración.
async function handleComprobantesHistoricos(req, res) {
  // ── Auth ──────────────────────────────────────────────────────────
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const perfil = await FacturasRepo.obtenerPerfilFacturas(user.id);

  if (!perfil || !puede(perfil, 'acceder', 'comprobantes_historicos'))
    return res.status(403).json({ error: 'Sin permisos' });

  const empresa_id = perfil.empresa_id;

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  const { cliente_id, tipo, desde, hasta, busqueda } = req.query;
  const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;

  const { data, error } = await FacturasRepo.listarComprobantesHistoricos(empresa_id, {
    cliente_id, tipo, desde, hasta, offset, limit,
  });
  if (error) return errorSeguro(res, error, 500, 'No se pudo completar la operación.');

  let rows = data || [];
  if (busqueda) {
    const b = busqueda.toLowerCase();
    rows = rows.filter(r =>
      (r.numero_original || '').toLowerCase().includes(b) ||
      (r.clientes?.razon_social || '').toLowerCase().includes(b) ||
      (r.clientes?.nombre_fantasia || '').toLowerCase().includes(b)
    );
  }

  return res.json(rows);
}
