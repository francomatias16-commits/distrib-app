// frontend/admin/js/usuarios.js
// Etapa 14 (auditoría UX), Hallazgo 2 — alta y gestión de usuarios internos.

let sb = null, usuarioActual = null;
let usuariosData = [];

const ROL_LABEL = {
  dueno: 'Dueño', admin: 'Admin', vendedor: 'Vendedor',
  depositero: 'Depositero', chofer: 'Chofer', contador: 'Contador',
};

// Un color por rol (no por nombre) — a diferencia del hash de
// Clientes/WhatsApp, acá lo que se quiere resaltar de un vistazo es el
// nivel de acceso de cada usuario interno, así que el mismo rol siempre
// pinta igual. Reusa la paleta --ge-* ya usada en el resto del panel.
const ROL_COLOR = {
  dueno: 'var(--ge-purple)',
  admin: 'var(--ge-blue)',
  vendedor: 'var(--ge-teal)',
  depositero: 'var(--ge-orange)',
  chofer: 'var(--ge-red)',
  contador: 'var(--ge-muted)',
};

function iniciales(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  return (partes[0][0] + (partes[1]?.[0] || '')).toUpperCase();
}

let modalUsuarioId = null;

async function init() {
  sb = window.authCtx.sb;
  usuarioActual = window.authCtx.perfil;

  const inputBusqueda = document.getElementById('busqueda');
  if (inputBusqueda) {
    let debounce = null;
    inputBusqueda.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => renderTabla(), 200);
    });
  }

  await cargarUsuarios();
}

async function tokenActual() {
  return (await sb.auth.getSession()).data.session?.access_token;
}

async function cargarUsuarios() {
  try {
    const token = await tokenActual();
    const res = await fetch('/api/usuarios', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      window.mostrarToast?.('No se pudo cargar la lista de usuarios.', 'error');
      return;
    }
    usuariosData = await res.json();
    renderTabla();
  } catch (err) {
    window.mostrarToast?.(err.message || 'No se pudo cargar la lista de usuarios.', 'error');
  }
}

function renderTabla() {
  const tbody = document.getElementById('tbody-usuarios');
  const busq = (document.getElementById('busqueda')?.value || '').trim().toLowerCase();
  const filtroActivo = document.getElementById('filtro-activo')?.value ?? 'true';

  let lista = usuariosData;
  if (filtroActivo !== '') lista = lista.filter(u => String(u.activo) === filtroActivo);
  if (busq) {
    lista = lista.filter(u =>
      (u.nombre || '').toLowerCase().includes(busq) ||
      (u.email || '').toLowerCase().includes(busq)
    );
  }

  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="vacio">No hay usuarios que coincidan con el filtro.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  lista.forEach(u => {
    const tr = document.createElement('tr');
    tr.dataset.testid = 'usuario-fila';
    tr.dataset.id = u.id;
    const esUnoMismo = u.id === usuarioActual?.id;
    // Etapa 11: si quien mira la tabla no es 'dueno', no puede tocar a un
    // 'dueno' ni a otro 'admin' (el backend ahora lo rechaza también en
    // PATCH y DELETE) — no tiene sentido ofrecer botones que van a fallar.
    const esAjenoIntocable = !esUnoMismo && (u.rol === 'dueno' || u.rol === 'admin') && usuarioActual?.rol !== 'dueno';
    // Clic en la fila = "Editar" (misma convención que el resto del panel),
    // salvo cuando ni siquiera se ofrece el botón (esAjenoIntocable).
    if (!esAjenoIntocable) tr.classList.add('fila-clickeable');
    const acciones = esAjenoIntocable
      ? '<span style="font-size:12px;color:var(--color-text-muted,#5B6660);">Solo el dueño</span>'
      : ComponentesAdmin.renderFilaAcciones([
          { label: 'Editar', attrs: `data-accion="editar" data-id="${u.id}"` },
          ...(!esUnoMismo ? [{ label: u.activo ? 'Desactivar' : 'Reactivar', attrs: `data-accion="${u.activo ? 'desactivar' : 'activar'}" data-id="${u.id}"` }] : []),
        ]);
    const nombre = u.nombre || '—';
    const colorRol = ROL_COLOR[u.rol] || 'var(--ge-muted)';
    tr.innerHTML = `
      <td class="td-usuario" data-label="Usuario">
        <div class="usr-avatar" style="background:${colorRol}">${iniciales(nombre)}</div>
        <div>
          <div class="usr-nombre">${window.sanitize(nombre)}${esUnoMismo ? ' <span class="usr-pill-vos">vos</span>' : ''}</div>
          <div class="usr-email">${window.sanitize(u.email || '—')}</div>
        </div>
      </td>
      <td data-label="Rol"><span class="badge-rol" style="color:${colorRol};border-color:${colorRol}">${window.sanitize(ROL_LABEL[u.rol] || u.rol)}</span></td>
      <td data-label="Teléfono">${window.sanitize(u.telefono || '—')}</td>
      <td data-label="Estado">${u.activo ? ComponentesAdmin.renderBadgeEstado('Activo', 'ok') : ComponentesAdmin.renderBadgeEstado('Inactivo', 'inactivo')}</td>
      <td class="col-sticky-end" data-label="Acciones">${acciones}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = '';
  tbody.appendChild(frag);
}

// Delegación de eventos (mismo patrón que stock.js — evita interpolar
// texto libre de la base en atributos onclick="").
document.getElementById('tbody-usuarios')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.btn-tabla');
  if (btn) {
    const id = btn.dataset.id;
    const accion = btn.dataset.accion;
    if (accion === 'editar') abrirModalEditar(id);
    else if (accion === 'desactivar') cambiarEstado(id, false);
    else if (accion === 'activar') cambiarEstado(id, true);
    return;
  }
  // Clic en la fila fuera de cualquier control propio (botón/link/select/
  // input) = acción primaria "Editar" — mismo guard universal que el resto
  // del panel, adaptado a delegación de eventos.
  const fila = ev.target.closest('tr.fila-clickeable');
  if (fila && ev.target.closest('[onclick],a,select,input,textarea,.btn-tabla') === null) {
    abrirModalEditar(fila.dataset.id);
  }
});

function abrirModalNuevo() {
  modalUsuarioId = null;
  limpiarForm();
  document.getElementById('modal-titulo').textContent = 'Nuevo usuario';
  document.getElementById('btn-guardar').textContent = 'Crear usuario';
  document.getElementById('grupo-password').style.display = '';
  document.getElementById('grupo-reset-password').style.display = 'none';
  document.getElementById('f-email').disabled = false;
  // El rol 'dueno' no se asigna desde esta pantalla (se crea en /registro).
  // Etapa 11: la opción existe en el <select> solo para poder mostrar
  // correctamente el rol de un dueño ya existente al editarlo (ver
  // abrirModalEditar) — acá se oculta y el select queda habilitado y
  // limitado a los roles asignables normales.
  document.getElementById('opt-rol-dueno').style.display = 'none';
  document.getElementById('f-rol').disabled = false;
  document.getElementById('modal-usuario').style.display = 'flex';
}

function abrirModalEditar(id) {
  const u = usuariosData.find(x => x.id === id);
  if (!u) return;
  modalUsuarioId = id;
  const esDueno = u.rol === 'dueno';
  document.getElementById('f-nombre').value = u.nombre || '';
  document.getElementById('f-email').value = u.email || '';
  document.getElementById('f-email').disabled = true; // el email no se edita acá (es la identidad en Supabase Auth)
  // Etapa 11 (antes de este fix): el <select> de rol no tenía la opción
  // "Dueño", así que al editar a un dueño el valor no matcheaba ninguna
  // opción y quedaba sin selección — al guardar, se mandaba rol:"" y el
  // backend rechazaba TODO el cambio (incluso nombre/teléfono) con "Rol
  // inválido". Ahora la opción se agrega dinámicamente solo en este caso,
  // y el select completo se deshabilita si quien edita no es dueño (no
  // puede tocar a un dueño de todas formas — ver lib/handlers/usuarios.js).
  document.getElementById('opt-rol-dueno').style.display = esDueno ? '' : 'none';
  document.getElementById('f-rol').disabled = esDueno && usuarioActual?.rol !== 'dueno';
  document.getElementById('f-rol').value = u.rol;
  document.getElementById('f-telefono').value = u.telefono || '';
  document.getElementById('grupo-password').style.display = 'none';
  document.getElementById('grupo-reset-password').style.display = '';
  document.getElementById('campo-nueva-password').style.display = 'none';
  document.getElementById('f-nueva-password').value = '';
  document.getElementById('modal-titulo').textContent = 'Editar usuario';
  document.getElementById('btn-guardar').textContent = 'Guardar cambios';
  document.getElementById('modal-usuario').style.display = 'flex';
}

function limpiarForm() {
  document.getElementById('f-nombre').value = '';
  document.getElementById('f-email').value = '';
  document.getElementById('f-password').value = '';
  document.getElementById('f-nueva-password').value = '';
  document.getElementById('campo-nueva-password').style.display = 'none';
  document.getElementById('f-rol').value = 'vendedor';
  document.getElementById('f-telefono').value = '';
}

function mostrarCampoNuevaPassword() {
  document.getElementById('campo-nueva-password').style.display = '';
  document.getElementById('f-nueva-password').focus();
}

function cerrarModal() {
  document.getElementById('modal-usuario').style.display = 'none';
  modalUsuarioId = null;
}

function cerrarModalSiFondo(event) {
  if (event.target.id === 'modal-usuario') cerrarModal();
}

async function guardarUsuario() {
  const nombre = document.getElementById('f-nombre').value.trim();
  const email = document.getElementById('f-email').value.trim();
  const rol = document.getElementById('f-rol').value;
  const telefono = document.getElementById('f-telefono').value.trim();

  if (!nombre) { window.mostrarToast?.('El nombre es requerido.', 'error'); return; }

  const esEdicion = !!modalUsuarioId;
  let nuevaPassword = '';
  if (!esEdicion) {
    const emailChk = document.getElementById('f-email').value.trim();
    if (!emailChk) { window.mostrarToast?.('El email es requerido.', 'error'); return; }
  } else {
    const campoVisible = document.getElementById('campo-nueva-password').style.display !== 'none';
    if (campoVisible) {
      nuevaPassword = document.getElementById('f-nueva-password').value;
      if (nuevaPassword && nuevaPassword.length < 8) {
        window.mostrarToast?.('La contraseña debe tener al menos 8 caracteres.', 'error');
        return;
      }
    }
  }
  const ok = await window.confirmar(
    esEdicion ? `¿Guardar los cambios de ${nombre}?` : `¿Confirmás crear el usuario ${nombre}?`,
    { labelOk: esEdicion ? 'Guardar' : 'Crear', labelCancel: 'Revisar' }
  );
  if (!ok) return;

  try {
    const token = await tokenActual();
    let res;

    if (modalUsuarioId) {
      const body = { id: modalUsuarioId, nombre, rol, telefono };
      if (nuevaPassword) body.password = nuevaPassword;
      res = await fetch('/api/usuarios', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      const password = document.getElementById('f-password').value;
      if (!email) { window.mostrarToast?.('El email es requerido.', 'error'); return; }
      if (!password || password.length < 8) { window.mostrarToast?.('La contraseña debe tener al menos 8 caracteres.', 'error'); return; }
      res = await fetch('/api/usuarios', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre, email, password, rol, telefono }),
      });
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data.error === 'LIMITE_PLAN_ALCANZADO') {
        const info = data.detalle || {};
        window.mostrarToast?.(`Llegaste al límite de usuarios de tu plan (${info.actual}/${info.limite}). Hablá con soporte para ampliarlo.`, 'error', 6000);
      } else {
        window.mostrarToast?.(data.error || 'No se pudo guardar el usuario.', 'error');
      }
      return;
    }

    window.mostrarToast?.(modalUsuarioId ? 'Usuario actualizado.' : 'Usuario creado.', 'success');
    cerrarModal();
    await cargarUsuarios();
  } catch (err) {
    window.mostrarToast?.(err.message || 'No se pudo guardar el usuario.', 'error');
  }
}

async function cambiarEstado(id, activo) {
  const u = usuariosData.find(x => x.id === id);
  const nombre = u?.nombre || 'este usuario';
  const confirmMsg = activo
    ? `¿Reactivar a ${nombre}? Va a poder volver a iniciar sesión.`
    : `¿Desactivar a ${nombre}? No va a poder iniciar sesión hasta que lo reactives.`;
  const ok = await window.confirmar(confirmMsg, { labelOk: activo ? 'Reactivar' : 'Desactivar', labelCancel: 'Cancelar', tipo: activo ? 'default' : 'danger' });
  if (!ok) return;

  try {
    const token = await tokenActual();
    const res = await fetch('/api/usuarios', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, activo }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      window.mostrarToast?.(data.error || 'No se pudo actualizar el estado.', 'error');
      return;
    }

    window.mostrarToast?.(activo ? 'Usuario reactivado.' : 'Usuario desactivado.', 'success');
    await cargarUsuarios();
  } catch (err) {
    window.mostrarToast?.(err.message || 'No se pudo actualizar el estado.', 'error');
  }
}

window.authReady.then(() => {
  if (!window.authCtx?.perfil) { window.location.href = '/admin/login'; return; }
  init();
}).catch(err => {
  console.error('[usuarios.js] authReady falló:', err?.message);
  window.location.href = '/admin/login';
});

window.abrirModalNuevo = abrirModalNuevo;
window.cerrarModal = cerrarModal;
window.cerrarModalSiFondo = cerrarModalSiFondo;
window.guardarUsuario = guardarUsuario;
window.renderTabla = renderTabla;
