// lib/handlers/clientes.js
// GET    /api/clientes               → lista de clientes (admin)
// GET    /api/clientes?id=uuid       → detalle de un cliente
// POST   /api/clientes               → crear cliente
// POST   /api/clientes/acceso        → crear/revocar acceso portal cliente
// PATCH  /api/clientes               → actualizar cliente
// DELETE /api/clientes?id=uuid       → desactivar cliente
//
// D4: migrado a lib/repos/ — sin instanciación directa de Supabase.

import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import {
  listarClientes,
  obtenerCliente,
  crearCliente,
  actualizarCliente,
  desactivarCliente,
  listarPreciosClientesGlobal,
  upsertPrecioCliente,
  eliminarPrecioCliente,
  listarClientesSinCoordenadas,
} from '../repos/clientes.js';
import { geocodificarDireccion } from '../geocoding.js';
import { puede } from '../permisos-service.js';
import {
  listarDireccionesGlobal,
  crearDireccion,
  actualizarDireccion,
  eliminarDireccion,
} from '../repos/cliente-direcciones.js';
import { obtenerEmpresa } from '../repos/empresas.js';
import { errorSeguro } from '../error-response.js';

// ── Helpers de acceso portal ──────────────────────────────────────────────────

function generarPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const especiales = '!@#$';
  let pass = especiales[Math.floor(Math.random() * especiales.length)];
  for (let i = 0; i < 7; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass.split('').sort(() => Math.random() - 0.5).join('');
}

/**
 * Normaliza un número de teléfono argentino a formato internacional sin +
 * Ej: "3462 123456" → "5493462123456"
 *     "+54 9 3462 123456" → "5493462123456"
 */
function normalizarTelefono(tel) {
  // Quitar todo lo que no sea dígito
  let digits = tel.replace(/\D/g, '');
  // Si ya empieza con 54, ok
  if (digits.startsWith('54')) return digits;
  // Si empieza con 0 (ej: 03462...), quitar el 0
  if (digits.startsWith('0')) digits = digits.slice(1);
  // Prefijo Argentina
  return '54' + digits;
}

function telefonoAEmail(telNormalizado) {
  return `${telNormalizado}@portal.distrib`;
}

async function crearAccesoPortal(empresa_id, cliente_id) {
  // 1. Obtener cliente
  const cliente = await obtenerCliente(empresa_id, cliente_id);
  if (!cliente) throw new Error('Cliente no encontrado');
  if (!cliente.telefono) throw new Error('El cliente no tiene teléfono registrado. Agregalo primero en Ver / Editar.');

  // 2. Nombre de empresa para el mensaje
  const empresa = await obtenerEmpresa(empresa_id);
  const nombreEmpresa = empresa?.nombre || 'tu distribuidora';

  // 3. Derivar email ficticio del número
  const telNorm    = normalizarTelefono(cliente.telefono);
  const emailFicto = telefonoAEmail(telNorm);
  const password   = generarPassword();

  // 4. Verificar si ya existe usuario en auth con ese email ficticio
  const { data: { users }, error: listErr } = await db.auth.admin.listUsers();
  if (listErr) throw new Error(`Error al verificar usuarios existentes: ${listErr.message}`);

  const existente = users.find(u => u.email === emailFicto);
  let authUserId;

  if (existente) {
    // Ya existe → resetear password y asegurar que no esté baneado
    // (si antes se le revocó el acceso, queda con ban_duration de 10 años;
    //  sin esto el reset de password no alcanza para que pueda loguearse)
    const { error: updErr } = await db.auth.admin.updateUserById(existente.id, {
      password,
      ban_duration: 'none',
    });
    if (updErr) throw new Error(`Error actualizando password: ${updErr.message}`);
    authUserId = existente.id;
  } else {
    // Crear usuario nuevo con email ficticio
    const { data: newUser, error: createErr } = await db.auth.admin.createUser({
      email: emailFicto,
      password,
      email_confirm: true,
    });
    if (createErr) throw new Error(`Error creando usuario: ${createErr.message}`);
    authUserId = newUser.user.id;
  }

  // 5. Vincular usuario_id en clientes
  const { error: patchErr } = await db
    .from('clientes')
    .update({ usuario_id: authUserId })
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id);
  if (patchErr) throw new Error(`Error vinculando usuario: ${patchErr.message}`);

  // 5b. Crear/actualizar fila en tabla usuarios (necesaria para que el portal
  //     pueda resolver empresa_id y cliente_id desde la sesión)
  const nombre = cliente.nombre_fantasia || cliente.razon_social;
  const { error: upsertErr } = await db
    .from('usuarios')
    .upsert({
      id:         authUserId,
      email:      emailFicto,
      nombre:     nombre,
      rol:        'cliente',
      empresa_id: empresa_id,
      cliente_id: cliente_id,
    }, { onConflict: 'id' });
  if (upsertErr) throw new Error(`Error registrando perfil de usuario: ${upsertErr.message}`);

  // 6. URL del portal
  const portalUrl = process.env.APP_URL
    ? `${process.env.APP_URL}/cliente/login`
    : `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/cliente/login`;

  // 7. Mensaje WhatsApp
  const mensajeWA = `Hola ${nombre}!\n\nTe creamos tu acceso al portal de pedidos de *${nombreEmpresa}*.\n\n${portalUrl}\nUsuario: ${telNorm}\nContraseña: ${password}\n\n¡Desde ahí podés hacer tus pedidos cuando quieras! Cualquier duda avisanos.`;

  // 8. Link directo wa.me
  const mensajeEncoded = encodeURIComponent(mensajeWA);
  const waLink = `https://wa.me/${telNorm}?text=${mensajeEncoded}`;

  return { mensajeWA, waLink, telefono: telNorm, password };
}

async function revocarAccesoPortal(empresa_id, cliente_id) {
  const cliente = await obtenerCliente(empresa_id, cliente_id);
  if (!cliente) throw new Error('Cliente no encontrado');
  if (!cliente.usuario_id) throw new Error('Este cliente no tiene acceso portal activo');

  // Deshabilitar usuario en auth (ban 10 años)
  await db.auth.admin.updateUserById(cliente.usuario_id, { ban_duration: '87600h' });

  // Desvincular
  const { error } = await db
    .from('clientes')
    .update({ usuario_id: null })
    .eq('id', cliente_id)
    .eq('empresa_id', empresa_id);
  if (error) throw new Error(`Error revocando acceso: ${error.message}`);

  return { ok: true };
}

const limiter = rateLimit({ max: 60, windowMs: 60_000 });

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !puede(perfil, 'acceder', 'clientes')) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Acceso solo para administradores' : 'No autorizado',
    });
  }

  const { empresa_id } = perfil;

  // ── POST /api/clientes/acceso ─────────────────────────────────────
  const esAcceso = req.url?.includes('/acceso') || req.query?._svc === 'acceso';
  if (esAcceso && req.method === 'POST') {
    if (!['dueno', 'admin'].includes(perfil.rol)) {
      return res.status(403).json({ error: 'Solo admin puede gestionar accesos' });
    }
    const { cliente_id, accion } = req.body || {};
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido' });
    if (!['crear', 'revocar'].includes(accion)) return res.status(400).json({ error: 'accion debe ser crear o revocar' });

    try {
      if (accion === 'crear') {
        const result = await crearAccesoPortal(empresa_id, cliente_id);
        return res.json(result);
      } else {
        const result = await revocarAccesoPortal(empresa_id, cliente_id);
        return res.json(result);
      }
    } catch (err) {
      return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
    }
  }


  // ── /api/clientes/direcciones — CRUD global de direcciones de entrega ──
  const esDirecciones = req.url?.includes('/direcciones') || req.query?._svc === 'direcciones';
  if (esDirecciones) {
    if (req.method === 'GET') {
      const { cliente_id, busqueda } = req.query;
      try {
        const data = await listarDireccionesGlobal(empresa_id, { cliente_id, busqueda });
        return res.json(data);
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }
    if (req.method === 'POST') {
      try {
        const data = await crearDireccion(empresa_id, req.body || {});
        return res.status(201).json(data);
      } catch (err) {
        return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
      }
    }
    if (req.method === 'PATCH') {
      const { id, ...cambios } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id requerido' });
      try {
        const data = await actualizarDireccion(empresa_id, id, cambios);
        return res.json(data);
      } catch (err) {
        return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
      }
    }
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id requerido' });
      try {
        await eliminarDireccion(empresa_id, id);
        return res.json({ ok: true });
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // ── /api/clientes/precios — vista global de precios especiales ─────
  const esPrecios = req.url?.includes('/precios') || req.query?._svc === 'precios';
  if (esPrecios) {
    if (req.method === 'GET') {
      const { cliente_id, producto_id, busqueda } = req.query;
      try {
        const data = await listarPreciosClientesGlobal(empresa_id, { cliente_id, producto_id, busqueda });
        return res.json(data);
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }
    if (req.method === 'POST') {
      try {
        const data = await upsertPrecioCliente(empresa_id, req.body || {});
        return res.status(201).json(data);
      } catch (err) {
        return errorSeguro(res, err, 400, 'No se pudo completar la operación.');
      }
    }
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id requerido' });
      try {
        await eliminarPrecioCliente(empresa_id, id);
        return res.json({ ok: true });
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // ── /api/clientes/geocodificar — geocodificación automática desde domicilio ──
  const esGeocodificar = req.url?.includes('/geocodificar') || req.query?._svc === 'geocodificar';
  if (esGeocodificar) {
    // GET → lista de clientes con domicilio pero sin lat/lng (para el botón
    // "Geocodificar direcciones pendientes" del panel de clientes)
    if (req.method === 'GET') {
      try {
        const data = await listarClientesSinCoordenadas(empresa_id, { limit: 100 });
        return res.json(data);
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }

    // POST { cliente_id } → geocodifica un cliente ya guardado y persiste el resultado.
    // POST { domicilio, localidad } (sin cliente_id) → geocodificación "al vuelo" para
    // el formulario de alta, antes de guardar el cliente (no persiste nada acá).
    if (req.method === 'POST') {
      const { cliente_id, domicilio: domicilioBody, localidad: localidadBody } = req.body || {};

      try {
        let domicilio = domicilioBody;
        let localidad = localidadBody;

        if (cliente_id) {
          const cliente = await obtenerCliente(empresa_id, cliente_id);
          if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
          domicilio = cliente.domicilio;
          localidad = cliente.localidad;
        }

        if (!domicilio) {
          return res.status(400).json({ error: 'Falta el domicilio. Cargalo primero para poder geocodificar.' });
        }

        const resultado = await geocodificarDireccion({ domicilio, localidad });

        if (!resultado) {
          return res.status(422).json({
            error: 'No se encontró esa dirección en el mapa. Revisá que esté bien escrita o cargá las coordenadas a mano.',
          });
        }

        // Solo persiste si hay un cliente_id concreto; el uso "al vuelo" del
        // formulario de alta se limita a devolver las coordenadas.
        if (cliente_id) {
          await actualizarCliente(empresa_id, cliente_id, { lat: resultado.lat, lng: resultado.lng });
        }

        return res.json({
          lat: resultado.lat,
          lng: resultado.lng,
          direccion_usada: resultado.direccion_usada,
        });
      } catch (err) {
        return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
      }
    }

    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (req.method === 'GET') {
    const { id, busqueda, zona_id, activo } = req.query;

    if (id) {
      const cliente = await obtenerCliente(empresa_id, id);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      return res.json(cliente);
    }

    try {
      const data = await listarClientes(empresa_id, {
        busqueda,
        zona_id,
        activo: activo !== undefined ? activo === 'true' : undefined,
      });
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── POST: crear ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (!req.body?.razon_social) {
      return res.status(400).json({ error: 'razon_social requerido' });
    }
    try {
      const data = await crearCliente(empresa_id, req.body);
      return res.status(201).json(data);
    } catch (err) {
      if (err.code === 'LIMITE_PLAN_ALCANZADO') {
        return errorSeguro(res, err, 403, 'No se pudo completar la operación.', { code: err.code, info: err.info });
      }
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── PATCH: actualizar ─────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const { id, ...updates } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido' });
    delete updates.empresa_id; // nunca cambiar tenant

    try {
      const data = await actualizarCliente(empresa_id, id, updates);
      return res.json(data);
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  // ── DELETE: desactivar ────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!['dueno', 'admin'].includes(perfil.rol)) {
      return res.status(403).json({ error: 'Solo admin puede eliminar clientes' });
    }
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });

    try {
      await desactivarCliente(empresa_id, id);
      return res.json({ ok: true });
    } catch (err) {
      return errorSeguro(res, err, 500, 'No se pudo completar la operación.');
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
