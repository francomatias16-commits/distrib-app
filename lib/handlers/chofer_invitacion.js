// lib/handlers/chofer_invitacion.js
// Repartos → "Invitar chofer": el admin ya no tiene que asignar email+password
// a mano desde /admin/usuarios.html — genera un link (WhatsApp) y el chofer
// activa su propio acceso a /chofer eligiendo su contraseña.
//
// Mismo patrón que el portal de proveedores (Innovación #10, ver
// lib/handlers/portal_proveedor.js): token de un solo uso, hash sha256
// persistido (nunca el token crudo), tabla con RLS deny-all, toda la
// autorización resuelta acá con SERVICE_ROLE_KEY.
//
// Dos superficies en este archivo, despachadas ambas desde el mismo
// handler (a diferencia de proveedores.js/portal_proveedor.js, acá no hace
// falta un módulo intermedio porque no hay un endpoint "normal" de choferes
// del que colgar el _svc=portal):
//
//  A) ADMIN (requiere sesión dueno/admin)
//     GET  ?accion=listar                                   → historial de invitaciones
//     POST ?accion=invitar-nuevo      body:{ nombre, telefono }       → alta de chofer nuevo
//                                        (crea el usuario ya activo con password provisoria,
//                                        para que aparezca de inmediato en "Armar ruta")
//     POST ?accion=invitar-existente  body:{ usuario_id }             → resetear acceso de un chofer ya cargado
//     POST ?accion=impersonar         body:{ usuario_id }             → link de un solo uso para entrar como ese chofer
//     POST ?accion=revocar            body:{ invitacion_id }
//
//  B) PÚBLICO (sin login — el chofer todavía no tiene sesión)
//     GET  ?accion=ver     &t=<token>                        → nombre/telefono para mostrar en el form
//     POST ?accion=activar &t=<token>  body:{ password }     → reemplaza la password provisoria por
//        la elegida por el chofer y devuelve { email } para que el frontend haga
//        signInWithPassword() y arranque la sesión ahí mismo. (La rama "alta nueva" de abajo
//        se conserva sólo por compatibilidad con invitaciones ya emitidas antes de este cambio,
//        cuyo usuario_id quedó en null.)
//
// Igual que el portal de proveedores: escrituras públicas SIEMPRE resuelven
// empresa_id/usuario_id desde el token validado acá, nunca desde el body.
//
// Migrado a capa de repos (lib/repos/chofer-invitacion.js): todo el I/O
// contra Supabase (tabla `usuarios`, `chofer_invitaciones`, `audit_log` y
// la Admin API de Auth) vive ahora ahí. Acá queda la orquestación: las
// funciones de negocio (crearInvitacion, listarInvitacionesChofer,
// invitarChoferNuevo, invitarChoferExistente, revocarInvitacionChofer) se
// mantienen en este archivo porque lib/asistente-tools.js ya las importa
// directamente con su contrato { ok, status, error } — moverlas al repo
// hubiera roto esa integración sin necesidad.

import crypto from 'crypto';
import { rateLimit } from '../rate-limit.js';
import { verificarToken } from '../auth-helpers.js';
import { db } from '../repos/_db.js';
import { errorSeguro } from '../error-response.js';
import {
  obtenerUsuarioChofer,
  insertarUsuarioChofer,
  marcarUsuarioActivo,
  crearUsuarioAuth,
  eliminarUsuarioAuth,
  actualizarPasswordUsuarioAuth,
  generarMagicLink,
  insertarInvitacion,
  listarInvitacionesPorEmpresa,
  revocarInvitacion,
  intentarConsumirInvitacion,
  liberarInvitacion,
  validarTokenInvitacion,
  registrarAuditoriaImpersonacion,
} from '../repos/chofer-invitacion.js';
import * as AuditRepo from '../repos/audit.js';

const limiterAdmin  = rateLimit({ max: 30, windowMs: 60_000 });
const limiterPublic = rateLimit({ max: 20, windowMs: 60_000 }); // por IP — frena fuerza bruta de tokens
const limiterImpersonar = rateLimit({ max: 10, windowMs: 60_000 }); // más estricto: acceso a cuenta real de un tercero

export const ROLES_GESTION = ['dueno', 'admin'];
const DIAS_VALIDEZ = 7; // más corto que el de proveedores (30d): es un alta de acceso, no un link recurrente

// Mismo fallback que registro.js — se usa cuando estas funciones se llaman
// fuera de un request HTTP real (ej. desde lib/asistente-tools.js, que no
// tiene req.headers.host para armar la URL con baseUrl(req) de abajo).
export const APP_URL_FALLBACK = process.env.APP_URL || 'https://distrib.vercel.app';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generarTokenCrudo() {
  return crypto.randomBytes(32).toString('base64url');
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// ── Mismo esquema de teléfono→email ficticio que clientes.js, pero con
//    dominio propio (@chofer.distrib) para no pisar el espacio de emails
//    ficticios de clientes (@portal.distrib) si algún día coincide un número.
function normalizarTelefono(tel) {
  let digits = String(tel || '').replace(/\D/g, '');
  if (digits.startsWith('54')) return digits;
  if (digits.startsWith('0')) digits = digits.slice(1);
  return '54' + digits;
}

function telefonoAEmailChofer(telNormalizado) {
  return `${telNormalizado}@chofer.distrib`;
}

export default async function handler(req, res) {
  const accion = req.query.accion || '';
  const esPublico = ['ver', 'activar'].includes(accion);

  if (esPublico) {
    if (await limiterPublic(req, res)) return;
    return handlePublico(req, res, accion);
  }

  if (await limiterAdmin(req, res)) return;

  const perfil = await verificarToken(req, db);
  if (!perfil || !ROLES_GESTION.includes(perfil.rol)) {
    return res.status(perfil ? 403 : 401).json({
      error: perfil ? 'Acceso solo para dueño/admin.' : 'No autorizado.',
    });
  }

  return handleAdmin(req, res, perfil, accion);
}

// ════════════════════════════════════════════════════════════════════════
// A) ADMIN
// ════════════════════════════════════════════════════════════════════════
async function handleAdmin(req, res, perfil, accion) {
  const { empresa_id, id: usuario_id } = perfil;

  // ── Listar invitaciones emitidas ────────────────────────────────────
  if (req.method === 'GET' && accion === 'listar') {
    const resultado = await listarInvitacionesChofer({ empresa_id });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.json({ invitaciones: resultado.invitaciones });
  }

  // ── Invitar chofer nuevo — se crea YA como usuario activo (rol chofer),
  // con una contraseña aleatoria que nadie conoce todavía; el link de
  // WhatsApp deja que el propio chofer la reemplace por la suya. Antes esto
  // sólo guardaba un "borrador" en chofer_invitaciones y el usuario recién
  // se creaba cuando el chofer aceptaba el link — hasta ese momento no
  // existía en `usuarios`, así que no aparecía en el selector de "Armar
  // ruta" (cargarChoferes filtra rol=chofer AND activo=true) y el dueño no
  // podía planificar el reparto de hoy con un chofer recién sumado.
  if (req.method === 'POST' && accion === 'invitar-nuevo') {
    const { nombre, telefono } = req.body || {};
    const resultado = await invitarChoferNuevo({
      empresa_id, creado_por: usuario_id, nombre, telefono,
      baseUrl: baseUrl(req),
    });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.status(201).json(resultado);
  }

  // ── Invitar/reinvitar a un chofer que ya existe en `usuarios` ──────────
  if (req.method === 'POST' && accion === 'invitar-existente') {
    const { usuario_id: choferId } = req.body || {};
    const resultado = await invitarChoferExistente({
      empresa_id, creado_por: usuario_id, usuario_id: choferId,
      baseUrl: baseUrl(req),
    });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.status(201).json(resultado);
  }

  // ── Impersonar: el dueño/admin entra al panel de un chofer real sin
  // conocer su contraseña — pensado para demos comerciales o para dar
  // soporte, sin tener que pedirle al chofer que comparta su clave.
  // Genera un magic link de un solo uso vía la Admin API de Supabase: el
  // token lo consume el navegador de quien abre el link (nunca se manda
  // ningún email real). Requiere que cada portal tenga su propio
  // storageKey (ver auth.js/login.html de admin/cliente/chofer) para que
  // iniciar sesión acá, en otra pestaña, no pise la sesión de admin.
  if (req.method === 'POST' && accion === 'impersonar') {
    if (await limiterImpersonar(req, res)) return;

    const { usuario_id: choferId } = req.body || {};
    if (!choferId) return res.status(400).json({ error: 'usuario_id requerido' });

    const chofer = await obtenerUsuarioChofer(empresa_id, choferId);
    if (!chofer) return res.status(404).json({ error: 'Chofer no encontrado' });
    if (chofer.rol !== 'chofer') return res.status(400).json({ error: 'Ese usuario no tiene rol chofer' });
    if (!chofer.activo) return res.status(400).json({ error: 'Ese chofer está dado de baja.' });
    if (!chofer.email) return res.status(400).json({ error: 'El chofer no tiene email registrado.' });

    const { data: link, error: linkErr } = await generarMagicLink({
      email: chofer.email,
      // FIX v479: la ruta real del panel del chofer es "/chofer" (ver
      // vercel.json: { "source": "/chofer", "destination":
      // "/frontend/chofer/index.html" }). No existe "/chofer/index" — ese
      // rewrite nunca se agregó, y por eso el link de "Ingresar como" tiraba
      // 404: NOT_FOUND apenas Supabase completaba el magic link y redirigía.
      redirectTo: `${baseUrl(req)}/chofer`,
    });
    if (linkErr) return errorSeguro(res, linkErr, 500, 'No se pudo generar el acceso.');

    // Auditoría: esto es acceso real a la cuenta de un tercero (el chofer),
    // no una acción sobre el propio perfil del admin — queda registrado
    // quién entró, a qué chofer, y cuándo.
    // FIX v477: acá estaba `.insert({...}).catch(() => {})`. El objeto que
    // devuelve `.from().insert()` de supabase-js es "thenable" (solo
    // implementa `.then`), no una Promise completa — no tiene `.catch()`
    // propio. Eso tiraba un TypeError SÍNCRONO ("...catch is not a
    // function") apenas se ejecutaba la línea, antes de llegar siquiera a
    // guardar el registro de auditoría, y tapaba el 500 genérico ("Error
    // interno del servidor") en CADA click de "Ingresar como" — confirmado
    // en los logs de Vercel (correlation_id=442cd50e...). Mismo bug de raíz
    // que CHANGELOG_v367 (rpc().catch en pedidos/facturación/cta-cte);
    // acá se había reintroducido con .insert(). Fix: await + try/catch.
    try {
      await registrarAuditoriaImpersonacion({
        empresa_id, usuario_id, chofer_id: chofer.id, chofer_nombre: chofer.nombre,
      });
    } catch (_) { /* auditoría best-effort: no debe bloquear el acceso del admin */ }

    return res.status(201).json({ ok: true, url: link.properties.action_link });
  }

  // ── Revocar invitación ──────────────────────────────────────────────
  if (req.method === 'POST' && accion === 'revocar') {
    const { invitacion_id } = req.body || {};
    const resultado = await revocarInvitacionChofer({ empresa_id, invitacion_id, revocado_por: usuario_id });
    if (!resultado.ok) return res.status(resultado.status || 500).json({ error: resultado.error });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Acción desconocida' });
}

// ════════════════════════════════════════════════════════════════════════
// Funciones de negocio reusables — llamadas tanto por handleAdmin (HTTP)
// como por lib/asistente-tools.js (tool calling). Convención: devuelven
// { ok:true, ... } o { ok:false, status, error } con `error` YA sanitizado
// para mostrar al cliente/usuario (el detalle crudo se loguea acá adentro
// con console.error) — mismo contrato que crearPedidoParaCliente en
// lib/handlers/pedidos.js. Nunca tiran excepción por un error esperado
// (validación, no encontrado, etc.); solo por bugs de programación.
// ════════════════════════════════════════════════════════════════════════

async function crearInvitacion({ empresa_id, creado_por, usuario_id, nombre, telefono, baseUrl: baseUrlStr }) {
  const tokenCrudo = generarTokenCrudo();
  const expiraAt = new Date(Date.now() + DIAS_VALIDEZ * 24 * 60 * 60 * 1000).toISOString();

  let row;
  try {
    row = await insertarInvitacion({
      empresa_id, usuario_id, nombre, telefono,
      token_hash: hashToken(tokenCrudo), creado_por, expira_at: expiraAt,
    });
  } catch (error) {
    console.error('[CHOFER_INVITACION] Error insertando invitación:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }

  await AuditRepo.registrarAuditoriaSilenciosa(
    empresa_id, creado_por, 'chofer_invitaciones', 'INSERT', row.id, null,
    { usuario_id: usuario_id || null, nombre, telefono }
  );

  const url = `${baseUrlStr}/chofer/invitacion?t=${tokenCrudo}`;
  const primerNombre = nombre.split(/[\s,]+/)[0];
  const mensajeWA = `Hola ${primerNombre}!\n\nTe invitamos a activar tu acceso a la app de reparto.\n\n${url}\n\nEste link vence en ${DIAS_VALIDEZ} días.`;
  const waLink = `https://wa.me/${normalizarTelefono(telefono)}?text=${encodeURIComponent(mensajeWA)}`;

  return {
    ok: true,
    invitacion_id: row.id,
    url,
    waLink,
    expira_at: row.expira_at,
    dias_validez: DIAS_VALIDEZ,
  };
}

// Listar invitaciones emitidas (historial + estado derivado).
export async function listarInvitacionesChofer({ empresa_id }) {
  let data;
  try {
    data = await listarInvitacionesPorEmpresa(empresa_id);
  } catch (error) {
    console.error('[CHOFER_INVITACION] Error listando invitaciones:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }

  const ahora = Date.now();
  const invitaciones = (data || []).map(i => ({
    ...i,
    estado: i.usado_at ? 'aceptada'
          : i.revocado_at ? 'revocado'
          : new Date(i.expira_at).getTime() < ahora ? 'expirado'
          : 'activo',
  }));

  return { ok: true, invitaciones };
}

// Alta de chofer nuevo: crea el usuario YA activo (ver comentario original
// más abajo, se conserva) y devuelve el link de invitación para que elija
// su password. Si falla el insert en `usuarios`, revierte el alta en auth
// (mismo cleanup que ya hacía el handler original).
export async function invitarChoferNuevo({ empresa_id, creado_por, nombre, telefono, baseUrl: baseUrlStr }) {
  if (!nombre?.trim()) return { ok: false, status: 400, error: 'El nombre es requerido.' };
  if (!telefono?.trim()) return { ok: false, status: 400, error: 'El teléfono es requerido.' };

  const telNorm = normalizarTelefono(telefono.trim());
  const email = telefonoAEmailChofer(telNorm);
  const passwordProvisoria = crypto.randomBytes(24).toString('base64url');

  const { data: newUser, error: createErr } = await crearUsuarioAuth({
    email, password: passwordProvisoria, email_confirm: true,
  });
  if (createErr) {
    const msg = createErr.message || '';
    if (msg.toLowerCase().includes('already registered') || msg.includes('already exists')) {
      return { ok: false, status: 409, error: 'Ya existe una cuenta con ese teléfono. Buscalo en el selector de choferes existentes.' };
    }
    console.error('[CHOFER_INVITACION] Error creando usuario:', createErr);
    return { ok: false, status: 500, error: 'No se pudo crear el usuario del chofer.' };
  }

  try {
    await insertarUsuarioChofer({
      id: newUser.user.id, empresa_id, nombre: nombre.trim(), email, telefono: telefono.trim(),
    });
  } catch (insertErr) {
    await eliminarUsuarioAuth(newUser.user.id);
    console.error('[CHOFER_INVITACION] Error registrando perfil:', insertErr);
    return { ok: false, status: 500, error: 'No se pudo registrar el perfil del chofer.' };
  }

  await AuditRepo.registrarAuditoriaSilenciosa(
    empresa_id, creado_por, 'usuarios', 'INSERT', newUser.user.id, null,
    { rol: 'chofer', nombre: nombre.trim(), telefono: telefono.trim() }
  );

  return await crearInvitacion({
    empresa_id, creado_por,
    usuario_id: newUser.user.id,
    nombre: nombre.trim(),
    telefono: telefono.trim(),
    baseUrl: baseUrlStr,
  });
}

// Reinvitar/reenviar acceso a un chofer que ya existe en `usuarios`.
export async function invitarChoferExistente({ empresa_id, creado_por, usuario_id: choferId, baseUrl: baseUrlStr }) {
  if (!choferId) return { ok: false, status: 400, error: 'usuario_id requerido' };

  const chofer = await obtenerUsuarioChofer(empresa_id, choferId, 'id, nombre, telefono, rol');

  if (!chofer) return { ok: false, status: 404, error: 'Chofer no encontrado' };
  if (chofer.rol !== 'chofer') return { ok: false, status: 400, error: 'Ese usuario no tiene rol chofer' };
  if (!chofer.telefono) return { ok: false, status: 400, error: 'El chofer no tiene teléfono registrado. Agregalo primero en Usuarios.' };

  return await crearInvitacion({
    empresa_id, creado_por,
    usuario_id: chofer.id,
    nombre: chofer.nombre,
    telefono: chofer.telefono,
    baseUrl: baseUrlStr,
  });
}

// Revocar una invitación pendiente (no afecta accesos ya activados).
export async function revocarInvitacionChofer({ empresa_id, invitacion_id, revocado_por = null }) {
  if (!invitacion_id) return { ok: false, status: 400, error: 'invitacion_id requerido' };

  let data;
  try {
    data = await revocarInvitacion(empresa_id, invitacion_id);
  } catch (error) {
    console.error('[CHOFER_INVITACION] Error revocando invitación:', error);
    return { ok: false, status: 500, error: 'No se pudo completar la operación.' };
  }
  if (!data) return { ok: false, status: 404, error: 'Invitación no encontrada' };

  await AuditRepo.registrarAuditoriaSilenciosa(
    empresa_id, revocado_por, 'chofer_invitaciones', 'UPDATE', invitacion_id, null, { estado: 'revocada' }
  );

  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════
// B) PÚBLICO — sin login
// ════════════════════════════════════════════════════════════════════════
async function validarTokenPublico(tokenCrudo) {
  if (!tokenCrudo || typeof tokenCrudo !== 'string')
    return { ok: false, status: 400, error: 'Link inválido' };

  let v;
  try {
    v = await validarTokenInvitacion(hashToken(tokenCrudo));
  } catch (error) {
    return { ok: false, status: 500, error: 'Error validando el link' };
  }

  if (!v?.valido) {
    const mensajes = {
      no_encontrado: 'Este link no es válido. Pedile a tu contacto habitual que te genere uno nuevo.',
      revocado:      'Este link fue desactivado. Pedile a tu contacto habitual que te genere uno nuevo.',
      expirado:      `Este link venció. Pedile a tu contacto habitual que te genere uno nuevo.`,
      usado:         'Este link ya fue usado. Si no pudiste entrar, pedile a tu contacto habitual que te genere uno nuevo.',
    };
    return { ok: false, status: 410, error: mensajes[v?.motivo] || 'Link inválido' };
  }

  return { ok: true, invitacion: v };
}

async function handlePublico(req, res, accion) {
  const tokenCrudo = req.method === 'GET' ? req.query.t : (req.body?.t || req.query.t);
  const validacion = await validarTokenPublico(tokenCrudo);
  if (!validacion.ok) return res.status(validacion.status).json({ error: validacion.error });

  const inv = validacion.invitacion;

  // ── Ver datos de la invitación (para prellenar el form) ─────────────
  if (req.method === 'GET' && accion === 'ver') {
    return res.json({
      nombre: inv.nombre,
      telefono: inv.telefono,
      es_alta_nueva: !inv.usuario_id,
    });
  }

  // ── Activar: crea o resetea el password y devuelve el email para login ──
  if (req.method === 'POST' && accion === 'activar') {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    }

    // SYNC-08: reclamar el token ANTES de tocar Auth/perfil, no después.
    // validarTokenPublico() de arriba ya chequeó que no estuviera usado,
    // pero esa lectura no alcanza sola contra dos activaciones concurrentes
    // con el mismo link — las dos pueden pasarla antes de que cualquiera
    // marque nada. El UPDATE condicional de intentarConsumirInvitacion es
    // la única que decide quién "gana"; el resto del flujo (creación/reset
    // de Auth, alta de perfil) solo corre para la request que ganó.
    const claim = await intentarConsumirInvitacion(inv.invitacion_id);
    if (!claim) {
      return res.status(410).json({ error: 'Este link ya fue usado. Si no pudiste entrar, pedile a tu contacto habitual que te genere uno nuevo.' });
    }

    try {
      let email;

      if (inv.usuario_id) {
        // Chofer ya existente: solo reseteamos su password y garantizamos
        // que no quede baneado (mismo trato que revocarAccesoPortal/crearAccesoPortal
        // de clientes.js, invertido).
        const existente = await obtenerUsuarioChofer(inv.empresa_id, inv.usuario_id, 'id, email');
        if (!existente) throw new Error('El usuario de este chofer ya no existe.');

        const { error: updErr } = await actualizarPasswordUsuarioAuth(inv.usuario_id, {
          password, ban_duration: 'none',
        });
        if (updErr) throw new Error(`No se pudo activar el acceso: ${updErr.message}`);

        await marcarUsuarioActivo(inv.usuario_id, true);
        email = existente.email;

        // Auditoría: usuario_id = el propio chofer — es su acceso el que se
        // está reactivando, con el token de invitación como única prueba de
        // identidad (todavía no tiene sesión).
        await AuditRepo.registrarAuditoriaSilenciosa(
          inv.empresa_id, inv.usuario_id, 'usuarios', 'UPDATE', inv.usuario_id, null, { activo: true, evento: 'reset_password_invitacion' }
        );
      } else {
        // Alta nueva: recién acá se crea el usuario, con los datos que
        // quedaron en borrador en la invitación (nunca los del body).
        const telNorm = normalizarTelefono(inv.telefono);
        email = telefonoAEmailChofer(telNorm);

        const { data: newUser, error: createErr } = await crearUsuarioAuth({
          email, password, email_confirm: true,
        });
        if (createErr) {
          const msg = createErr.message || '';
          if (msg.toLowerCase().includes('already registered') || msg.includes('already exists')) {
            throw new Error('Ya existe una cuenta con ese teléfono. Pedile a tu contacto habitual que te genere un link de reseteo en vez de uno de alta.');
          }
          throw new Error(`No se pudo crear el usuario: ${msg}`);
        }

        try {
          await insertarUsuarioChofer({
            id: newUser.user.id, empresa_id: inv.empresa_id, nombre: inv.nombre, email, telefono: inv.telefono,
          });
        } catch (insertErr) {
          await eliminarUsuarioAuth(newUser.user.id);
          throw new Error(`No se pudo registrar el perfil: ${insertErr.message}`);
        }

        await AuditRepo.registrarAuditoriaSilenciosa(
          inv.empresa_id, newUser.user.id, 'usuarios', 'INSERT', newUser.user.id, null,
          { rol: 'chofer', nombre: inv.nombre, evento: 'alta_via_invitacion' }
        );
      }

      // El token ya quedó consumido arriba (intentarConsumirInvitacion),
      // antes de estos efectos — no hace falta marcarlo de nuevo acá.
      return res.json({ ok: true, email });
    } catch (err) {
      // Falló algo después de haber ganado la carrera de consumo: se
      // libera la invitación para que el mismo link se pueda reintentar
      // (falla transitoria, contraseña rechazada por Auth, etc.) en vez de
      // dejarla inservible. Las ramas de arriba que ya tenían su propio
      // rollback (ej. borrar el usuario Auth si insertarUsuarioChofer
      // falla) no se tocan — esto solo libera el token en sí.
      await liberarInvitacion(inv.invitacion_id).catch(() => {});
      return errorSeguro(res, err, 400, 'No se pudo completar la activación.');
    }
  }

  return res.status(400).json({ error: 'Acción desconocida' });
}
