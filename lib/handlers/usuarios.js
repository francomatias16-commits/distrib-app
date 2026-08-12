// lib/handlers/usuarios.js
// Etapa 14 (auditoría UX), Hallazgo 2 — pantalla de alta de usuarios internos.
// Antes no existía ninguna forma de sumar un vendedor/depositero/chofer/
// contador/otro admin desde el panel: solo el dueño creado en /registro
// existía, y agregar gente al equipo requería tocar la base a mano.
//
// GET    /api/usuarios              → lista del equipo interno (sin rol 'cliente')
// POST   /api/usuarios              → alta de usuario (crea en Supabase Auth + tabla usuarios)
// PATCH  /api/usuarios              → editar rol/nombre/telefono/activo (activar o desactivar) y/o restablecer contraseña
// DELETE /api/usuarios?id=uuid      → alias de desactivar (activo=false) — nunca borra de verdad
//
// Reglas de negocio:
//  - Solo 'dueno'/'admin' pueden gestionar usuarios.
//  - Solo 'dueno' puede crear/editar a otro 'dueno' o 'admin' (un admin no
//    puede fabricarse pares ni tocar al dueño).
//  - No se puede dar de baja al propio usuario logueado, ni al último
//    'dueno' activo de la empresa (evita que la empresa quede sin dueño).
//  - El rol 'cliente' está fuera de alcance de esta pantalla — se gestiona
//    desde /admin/clientes.html (acceso portal), que tiene su propio flujo.
//  - Sujeto al límite de plan (`chequear_limite_plan('usuarios')`, ya no
//    cuenta usuarios rol='cliente' — ver migración 293).

import { rateLimit }        from '../rate-limit.js';
import { verificarToken }   from '../auth-helpers.js';
import { db }                from '../repos/_db.js';
import { exigirLimitePlan, LimitePlanError } from '../plan-limits.js';
import { errorSeguro }      from '../error-response.js';
import {
  listarEquipo,
  obtenerUsuarioParaEdicion,
  obtenerRolYActivo,
  contarDuenosActivos,
  insertarUsuario,
  actualizarUsuario,
  desactivarUsuario,
  crearUsuarioAuth,
  eliminarUsuarioAuth,
  banearUsuarioAuth,
  desbanearUsuarioAuth,
  actualizarPasswordAuth,
} from '../repos/usuarios.js';

const limiter = rateLimit({ max: 60, windowMs: 60_000 });
export const ROLES_GESTION = ['dueno', 'admin'];
const ROLES_ASIGNABLES = ['admin', 'vendedor', 'depositero', 'chofer', 'contador'];
const ROLES_PRIVILEGIADOS = ['dueno', 'admin']; // requieren que quien gestiona sea 'dueno'

function validarEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Reusable — lib/asistente-tools.js. Solo esto: alta (con contraseña),
// cambio de rol y activar/desactivar quedan afuera del asistente a
// propósito (ver comentario en asistente-tools.js) — no hay forma de
// separar una acción "inocente" del resto de la superficie de escritura
// de este archivo, a diferencia de chofer_invitacion/portal_proveedor.
export async function listarUsuariosEquipo({ empresa_id }) {
  try {
    const usuarios = await listarEquipo(empresa_id);
    return { ok: true, usuarios };
  } catch (error) {
    console.error('[USUARIOS] Error listando equipo:', error);
    return { ok: false, status: 500, error: 'No se pudo obtener la lista de usuarios.' };
  }
}

export default async function handler(req, res) {
  if (await limiter(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !ROLES_GESTION.includes(perfil.rol)) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Acceso solo para dueño/admin.' : 'No autorizado.',
    });
  }
  const { empresa_id } = perfil;

  // ── GET /api/usuarios — listado del equipo interno ──────────────────────
  if (req.method === 'GET') {
    const resultado = await listarUsuariosEquipo({ empresa_id });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.json(resultado.usuarios);
  }

  // ── POST /api/usuarios — alta ────────────────────────────────────────────
  if (req.method === 'POST') {
    const { nombre, email, password, rol, telefono } = req.body || {};

    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido.' });
    if (!validarEmail(email)) return res.status(400).json({ error: 'Email inválido.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (!ROLES_ASIGNABLES.includes(rol)) {
      return res.status(400).json({ error: `Rol inválido. Debe ser uno de: ${ROLES_ASIGNABLES.join(', ')}.` });
    }
    if (ROLES_PRIVILEGIADOS.includes(rol) && perfil.rol !== 'dueno') {
      return res.status(403).json({ error: 'Solo el dueño puede crear otro admin.' });
    }

    try {
      await exigirLimitePlan(db, empresa_id, 'usuarios');
    } catch (err) {
      if (err instanceof LimitePlanError) {
        return res.status(403).json({ error: 'LIMITE_PLAN_ALCANZADO', detalle: err.info });
      }
      throw err;
    }

    const emailNorm = email.trim().toLowerCase();

    const { data: authData, error: authError } = await crearUsuarioAuth({
      email: emailNorm,
      password,
      email_confirm: true,
    });
    if (authError) {
      const msg = authError.message || '';
      if (msg.toLowerCase().includes('already registered') || msg.includes('already exists')) {
        return res.status(409).json({ error: 'Ese email ya tiene una cuenta.' });
      }
      console.error('[USUARIOS] Error auth.admin.createUser:', msg);
      return res.status(500).json({ error: 'No se pudo crear el usuario.' });
    }

    const usuarioId = authData.user.id;

    let nuevoUsuario;
    try {
      nuevoUsuario = await insertarUsuario({
        id: usuarioId,
        empresa_id,
        nombre: nombre.trim(),
        email: emailNorm,
        rol,
        telefono: telefono?.trim() || null,
        activo: true,
      });
    } catch (insertError) {
      // Rollback: no dejar un usuario huérfano en Auth sin fila en `usuarios`
      await eliminarUsuarioAuth(usuarioId);
      console.error('[USUARIOS] Error insert tabla usuarios:', insertError.message);
      return res.status(500).json({ error: 'No se pudo registrar el perfil del usuario.' });
    }

    return res.status(201).json(nuevoUsuario);
  }

  // ── PATCH /api/usuarios — editar rol/nombre/telefono/activo/password ────
  if (req.method === 'PATCH') {
    const { id, nombre, rol, telefono, activo, password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requerido.' });

    const objetivo = await obtenerUsuarioParaEdicion(empresa_id, id);
    if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (objetivo.rol === 'cliente') return res.status(400).json({ error: 'Ese usuario es un cliente del portal — se gestiona desde Clientes.' });

    // Nadie puede tocar a un 'dueno' o 'admin' salvo el propio dueño —
    // un admin sí puede editarse a sí mismo, pero no a otro admin (evita
    // que un par se desactive/degrade a otro sin pasar por el dueño).
    // Etapa 11: antes solo se chequeaba objetivo.rol === 'dueno', dejando
    // sin protección a los 'admin' entre sí, al revés de lo que dice el
    // comentario de reglas de negocio al principio de este archivo.
    // Esta misma regla cubre el restablecimiento de contraseña: un admin
    // no puede resetear la clave de otro admin/dueño, solo el dueño puede.
    if (objetivo.id !== perfil.id && ROLES_PRIVILEGIADOS.includes(objetivo.rol) && perfil.rol !== 'dueno') {
      return res.status(403).json({ error: 'Solo el dueño puede editar a otro dueño o admin.' });
    }
    if (rol !== undefined && ROLES_PRIVILEGIADOS.includes(rol) && perfil.rol !== 'dueno') {
      return res.status(403).json({ error: 'Solo el dueño puede asignar el rol admin.' });
    }
    if (id === perfil.id && activo === false) {
      return res.status(400).json({ error: 'No podés desactivar tu propio usuario.' });
    }
    if (password !== undefined && password !== '' && password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    // No dejar a la empresa sin ningún 'dueno' activo
    if ((objetivo.rol === 'dueno' && activo === false) || (objetivo.rol === 'dueno' && rol !== undefined && rol !== 'dueno')) {
      const count = await contarDuenosActivos(empresa_id);
      if (count <= 1) {
        return res.status(400).json({ error: 'No podés dejar a la empresa sin ningún dueño activo.' });
      }
    }

    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre.trim();
    if (telefono !== undefined) cambios.telefono = telefono?.trim() || null;
    if (activo !== undefined) cambios.activo = !!activo;
    if (rol !== undefined) {
      if (!ROLES_ASIGNABLES.includes(rol) && rol !== 'dueno') {
        return res.status(400).json({ error: 'Rol inválido.' });
      }
      cambios.rol = rol;
    }
    const hayPassword = !!password;
    if (!Object.keys(cambios).length && !hayPassword) {
      return res.status(400).json({ error: 'Nada para actualizar.' });
    }

    let actualizado = null;
    if (Object.keys(cambios).length) {
      try {
        actualizado = await actualizarUsuario(empresa_id, id, cambios);
      } catch (updError) {
        return errorSeguro(res, updError, 500, 'No se pudo actualizar el usuario.');
      }
    }

    // Si se desactiva, banear también en Supabase Auth para cortar sesiones/logins
    if (activo === false) {
      await banearUsuarioAuth(id);
    } else if (activo === true) {
      await desbanearUsuarioAuth(id);
    }

    // Restablecimiento de contraseña (no hay email de reset propio para
    // usuarios internos — el dueño/admin la escribe a mano y se la pasa
    // al empleado por fuera del sistema, ver login.html).
    if (hayPassword) {
      const { error: passError } = await actualizarPasswordAuth(id, password);
      if (passError) {
        console.error('[USUARIOS] Error auth.admin.updateUserById (password):', passError.message);
        return res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
      }
    }

    return res.json(actualizado || { ok: true });
  }

  // ── DELETE /api/usuarios?id=uuid — alias de desactivar ───────────────────
  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido.' });
    if (id === perfil.id) return res.status(400).json({ error: 'No podés desactivar tu propio usuario.' });

    const objetivo = await obtenerRolYActivo(empresa_id, id);
    if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado.' });

    // Etapa 11: este chequeo existía en PATCH pero faltaba acá — un admin
    // podía desactivar directamente a un dueño (o a otro admin) llamando a
    // este endpoint, sin pasar por la restricción que sí se aplicaba si lo
    // hacía vía PATCH con activo:false.
    if (ROLES_PRIVILEGIADOS.includes(objetivo.rol) && perfil.rol !== 'dueno') {
      return res.status(403).json({ error: 'Solo el dueño puede desactivar a otro dueño o admin.' });
    }

    if (objetivo.rol === 'dueno') {
      const count = await contarDuenosActivos(empresa_id);
      if (count <= 1) return res.status(400).json({ error: 'No podés dejar a la empresa sin ningún dueño activo.' });
    }

    try {
      await desactivarUsuario(empresa_id, id);
    } catch (error) {
      return errorSeguro(res, error, 500, 'No se pudo desactivar el usuario.');
    }
    await banearUsuarioAuth(id);
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Método no permitido.' });
}
