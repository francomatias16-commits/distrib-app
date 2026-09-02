// frontend/admin/js/productos/modal-producto.js
// Parte del split de frontend/admin/js/productos.js (25/08/2026) — Modal Nuevo/Editar producto: apertura/cierre, notas internas, limpiar formulario, foto de producto, autocompletado por código escaneado, categoría rápida.
// Se carga como <script> clásico (no ES module) en productos.html, en el
// mismo orden que ocupaba en el archivo original, para preservar el scope
// global compartido entre secciones (variables de estado, funciones
// window.*). Repite 'use strict' porque el pragma es por-script (el
// original lo tenía una sola vez porque era un solo script). Ver
// docs/tecnico/ARQUITECTURA_ACTUAL.md.

'use strict';

/* ── Agregar producto ── */
function agregarProducto() {
  abrirModalProducto(null);
}

/* ── Modal Nuevo/Editar producto ─────────────────────────────────────────
   Reutiliza el mismo componente .modal-backdrop/.modal que Clientes, para
   que Productos quede sincronizado con el resto de las secciones en vez
   de depender de confirm()/alert() nativos sin conexión a la base. ──── */
async function abrirModalProducto(id) {
  if (!sb) {
    toast('No hay conexión con la base de datos (modo demo). Iniciá sesión para editar productos.', 'warning');
    return;
  }

  modalProductoId = id;
  await cargarCategorias();
  poblarSelectCategoriasModal();

  const titulo    = document.getElementById('modal-prod-titulo');
  const subtitulo = document.getElementById('modal-prod-subtitulo');

  const linkReceta    = document.getElementById('fp-link-receta');
  const secDepositos  = document.getElementById('fp-sec-depositos');
  const btnEliminar   = document.getElementById('btn-eliminar-producto');

  // El borrado físico solo tiene sentido en edición (un producto nuevo,
  // todavía no guardado, no existe en la base para poder borrarlo).
  if (btnEliminar) btnEliminar.style.display = id ? '' : 'none';

  if (id) {
    const p = productosPage.find(x => x.id === id);
    if (!p) { toast('No se encontró el producto', 'error'); return; }

    titulo.textContent    = p.nombre;
    subtitulo.textContent = p.codigo ? `Código: ${p.codigo}` : 'Sin código cargado';

    document.getElementById('fp-codigo').value       = p.codigo || '';
    document.getElementById('fp-nombre').value        = p.nombre || '';
    document.getElementById('fp-categoria_id').value = p.categoriaId || '';
    document.getElementById('fp-precio_base').value  = p.precio ?? 0;
    document.getElementById('fp-costo').value        = p.costo ?? 0;
    document.getElementById('fp-stock_minimo').value = p.stockMinimo ?? 0;
    document.getElementById('fp-stock_objetivo').value = p.stockObjetivo ?? 0;
    document.getElementById('fp-activo').value       = String(p.activo !== false);
    document.getElementById('fp-destacado').checked  = p.destacado === true;
    if (linkReceta) linkReceta.style.display = 'inline';
    // v351: el selector de depósitos solo tiene sentido en el alta —
    // en edición el producto ya existe y el stock se gestiona desde Stock.
    if (secDepositos) secDepositos.style.display = 'none';

    // v353: precarga la foto actual del producto (si tiene).
    fotoProductoFile      = null;
    fotoProductoQuitar    = false;
    fotoProductoUrlActual = p.fotoUrl || null;
    fotoProductoAutoCompletada  = false;
    nombreProductoAutoCompletado = false;
    const fotoInput = document.getElementById('fp-foto-input');
    if (fotoInput) fotoInput.value = '';
    const fotoNombreEl = document.getElementById('fp-foto-nombre');
    if (fotoNombreEl) fotoNombreEl.textContent = 'Ningún archivo seleccionado';
    mostrarPreviewFoto(fotoProductoUrlActual);
  } else {
    titulo.textContent    = 'Nuevo producto';
    subtitulo.textContent = 'Completá los datos del producto';

    document.getElementById('fp-codigo').value       = '';
    document.getElementById('fp-nombre').value        = '';
    document.getElementById('fp-categoria_id').value = '';
    document.getElementById('fp-precio_base').value  = 0;
    document.getElementById('fp-costo').value        = 0;
    document.getElementById('fp-stock_minimo').value = 0;
    document.getElementById('fp-stock_objetivo').value = 0;
    document.getElementById('fp-activo').value       = 'true';
    document.getElementById('fp-destacado').checked  = false;
    nombreProductoAutoCompletado = false;
    if (linkReceta) linkReceta.style.display = 'none';

    if (secDepositos) secDepositos.style.display = '';
    await cargarDepositosModal();
    poblarChecklistDepositosModal();

    // v353: limpio cualquier foto que haya quedado de una apertura anterior.
    resetFotoProductoModal();
  }

  document.getElementById('modal-backdrop-producto').style.display = 'block';
  document.getElementById('modal-producto').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Etiquetas (v473): chips de agregar/quitar. En alta (id=null) igual se
  // muestra el campo, pero Etiquetas.renderChips() avisa que hay que
  // guardar primero si se intenta agregar una sin id todavía.
  if (window.Etiquetas) {
    Etiquetas.renderChips('fp-etiquetas-chips', 'productos', id, {
      onCambio: () => cargarContadores().catch(() => {}),
    }).catch(err => console.warn('[productos] No se pudieron cargar las etiquetas:', err?.message || err));
  }

  // Notas internas (widget compartido con Clientes/Pedidos): solo tiene
  // sentido en edición, porque necesita un id de producto ya guardado.
  const secNotas = document.getElementById('fp-sec-notas');
  if (secNotas) {
    if (id && window.NotasInternas) {
      secNotas.style.display = '';
      cargarNotasProducto(id);
    } else {
      secNotas.style.display = 'none';
    }
  }
}

/* ── Notas internas del producto (widget compartido notas-internas.js) ── */
async function cargarNotasProducto(productoId) {
  const lista = document.getElementById('fp-notas-lista');
  if (!lista || !window.NotasInternas) return;

  lista.innerHTML = '<div class="loading-row">Cargando notas...</div>';
  try {
    const notas = await NotasInternas.cargar('productos', productoId);
    NotasInternas.renderLista(notas, 'fp-notas-lista', {
      onArchivar: () => cargarNotasProducto(productoId),
    });
  } catch (e) {
    console.error('[productos] Error cargando notas:', e);
    lista.innerHTML = '<div class="loading-row">No se pudo cargar el historial.</div>';
  }

  NotasInternas.renderForm('fp-notas-form', 'productos', productoId, {
    onGuardada: () => cargarNotasProducto(productoId),
  });
}

function cerrarModalProducto() {
  document.getElementById('modal-backdrop-producto').style.display = 'none';
  document.getElementById('modal-producto').classList.remove('open');
  document.body.style.overflow = '';
}

/* ── Limpiar formulario (v628) ────────────────────────────────────────────
   Pedido explícito: cuando el autocompletado por código escaneado trae
   datos equivocados (nombre o foto de otro producto), poder vaciar todo
   el formulario de una sola vez en lugar de borrar campo por campo a mano.
   No toca el modo del modal (alta/edición) ni lo cierra — solo limpia los
   valores cargados en pantalla. */
async function limpiarFormularioProducto() {
  const esEdicion = !!modalProductoId;
  const ok = await window.confirmar(
    esEdicion
      ? 'Se van a borrar todos los cambios cargados en este formulario (no afecta lo ya guardado del producto). ¿Continuar?'
      : '¿Borrar todos los campos cargados hasta ahora?',
    { tipo: 'default' }
  );
  if (!ok) return;

  document.getElementById('fp-codigo').value       = '';
  document.getElementById('fp-nombre').value        = '';
  document.getElementById('fp-categoria_id').value = '';
  document.getElementById('fp-precio_base').value  = 0;
  document.getElementById('fp-costo').value        = 0;
  document.getElementById('fp-stock_minimo').value = 0;
  document.getElementById('fp-stock_objetivo').value = 0;
  document.getElementById('fp-activo').value       = 'true';
  document.getElementById('fp-destacado').checked  = false;
  nombreProductoAutoCompletado = false;

  resetFotoProductoModal();

  // El checklist de depósitos solo existe en el alta (en edición está
  // oculto); si está visible, se vuelve al estado default (solo el
  // depósito principal tildado), igual que al abrir el modal de alta.
  if (document.getElementById('fp-sec-depositos')?.style.display !== 'none') {
    poblarChecklistDepositosModal();
  }

  document.getElementById('fp-nombre')?.focus();
  toast('Formulario limpio.', 'ok');
}

/* ── Foto de producto (v353) ─────────────────────────────────────────────
   Bucket público 'productos-fotos' con policies de insert/update/delete
   para 'authenticated' (ya configurado en Storage). Se sube client-side
   con el cliente Supabase logueado, evitando el round-trip por backend que
   usa devoluciones.js (ese flujo es para el chofer, que no tiene sesión
   Supabase con RLS). La separación multi-tenant a nivel de archivo se
   maneja por convención de path: ${empresa_id}/${uuid-random}.ext ─────── */
function mostrarPreviewFoto(url) {
  const img    = document.getElementById('fp-foto-preview');
  const icono  = document.getElementById('fp-foto-preview-icono');
  const btnQuitar = document.getElementById('fp-foto-quitar');
  if (!img) return;
  if (url) {
    img.src = url;
    img.style.display = 'block';
    if (icono) icono.style.display = 'none';
    if (btnQuitar) btnQuitar.style.display = 'inline-block';
  } else {
    img.src = '';
    img.style.display = 'none';
    if (icono) icono.style.display = '';
    if (btnQuitar) btnQuitar.style.display = 'none';
  }
}

function resetFotoProductoModal() {
  fotoProductoFile      = null;
  fotoProductoUrlActual = null;
  fotoProductoQuitar    = false;
  fotoProductoAutoCompletada = false;
  const input = document.getElementById('fp-foto-input');
  if (input) input.value = '';
  const nombreEl = document.getElementById('fp-foto-nombre');
  if (nombreEl) nombreEl.textContent = 'Ningún archivo seleccionado';
  mostrarPreviewFoto(null);
}

function onFotoProductoSeleccionada(ev) {
  const file = ev.target.files && ev.target.files[0];
  const nombreEl = document.getElementById('fp-foto-nombre');
  if (!file) {
    if (nombreEl) nombreEl.textContent = 'Ningún archivo seleccionado';
    return;
  }

  if (!FOTO_PRODUCTO_MIME_OK.includes(file.type)) {
    toast('Formato no admitido. Usá JPG, PNG, WEBP o GIF.', 'warning');
    ev.target.value = '';
    if (nombreEl) nombreEl.textContent = 'Ningún archivo seleccionado';
    return;
  }
  if (file.size > FOTO_PRODUCTO_MAX_BYTES) {
    toast('La imagen supera los 5 MB permitidos.', 'warning');
    ev.target.value = '';
    if (nombreEl) nombreEl.textContent = 'Ningún archivo seleccionado';
    return;
  }

  fotoProductoFile   = file;
  fotoProductoQuitar = false;
  fotoProductoAutoCompletada = false; // el usuario eligió el archivo a mano
  if (nombreEl) nombreEl.textContent = file.name;
  mostrarPreviewFoto(URL.createObjectURL(file));
}

function quitarFotoProducto() {
  fotoProductoFile      = null;
  fotoProductoUrlActual = null;
  fotoProductoQuitar    = true;
  fotoProductoAutoCompletada = false;
  const input = document.getElementById('fp-foto-input');
  if (input) input.value = '';
  const nombreEl = document.getElementById('fp-foto-nombre');
  if (nombreEl) nombreEl.textContent = 'Ningún archivo seleccionado';
  mostrarPreviewFoto(null);
}

// Sube fotoProductoFile al bucket y devuelve la URL pública, o null si no
// había ningún archivo pendiente de subir.
async function subirFotoProductoSiCorresponde() {
  if (!fotoProductoFile || !sb || !empresaData?.id) return null;

  const ext = (fotoProductoFile.name.split('.').pop() || 'jpg').toLowerCase();
  const nombreArchivo = `${empresaData.id}/${crypto.randomUUID()}.${ext}`;

  const { error: errorSubida } = await sb.storage
    .from('productos-fotos')
    .upload(nombreArchivo, fotoProductoFile, {
      cacheControl: '3600',
      upsert: false,
      contentType: fotoProductoFile.type,
    });
  if (errorSubida) throw errorSubida;

  const { data } = sb.storage.from('productos-fotos').getPublicUrl(nombreArchivo);
  return data?.publicUrl || null;
}

/* ── Autocompletar por código escaneado (v618) ────────────────────────────
   Llamado desde productos-scanner-remoto.js cuando el código escaneado
   matchea contra el banco de códigos / Open Food Facts / Serper, etc.
   Nunca pisa datos que el usuario haya cargado A MANO (nombre tipeado,
   foto ya elegida o ya guardada en edición) — si algo de eso existe, se
   ignora en silencio y el usuario sigue completando manualmente.

   v629 — FIX ("el escaneo mezcla el título/foto con un producto anterior"):
   antes el guard era "solo completo si el campo está vacío", pero eso
   confundía dos cosas distintas: "el usuario tipeó esto" y "esto quedó de
   un escaneo ANTERIOR, en la misma sesión del formulario, que nunca se
   guardó ni se limpió" (típico al escanear varios productos seguidos con
   el celular vinculado, o al corregir un código mal leído sin haber
   guardado el anterior todavía). En ese segundo caso el campo NO está
   vacío pero tampoco es del usuario — así que el nombre/foto del código
   nuevo se descartaban en silencio y quedaba pegado el dato del producto
   anterior. Ahora se distingue con nombreProductoAutoCompletado/
   fotoProductoAutoCompletada: solo protegen lo tipeado/elegido a mano. */
function setNombreProductoSiVacio(nombre) {
  const input = document.getElementById('fp-nombre');
  if (!input || !nombre) return;
  if (input.value.trim() && !nombreProductoAutoCompletado) return; // lo tipeó el usuario
  input.value = nombre;
  nombreProductoAutoCompletado = true;
}

async function setFotoProductoDesdeUrl(url) {
  if (!url || fotoProductoUrlActual) return;
  if (fotoProductoFile && !fotoProductoAutoCompletada) return; // el usuario ya eligió una a mano
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const blob = await r.blob();
    if (!FOTO_PRODUCTO_MIME_OK.includes(blob.type)) return;
    if (blob.size > FOTO_PRODUCTO_MAX_BYTES) return;

    const ext  = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([blob], `escaneo.${ext}`, { type: blob.type });

    // Puede haber tardado un momento en llegar (fetch + descarga) — si en
    // el ínterin el usuario ya eligió/quitó una foto a mano, no pisarla.
    // (Si lo que hay puesto es de un escaneo anterior, sí se puede pisar.)
    if (fotoProductoQuitar) return;
    if (fotoProductoFile && !fotoProductoAutoCompletada) return;

    fotoProductoFile          = file;
    fotoProductoQuitar        = false;
    fotoProductoAutoCompletada = true;
    mostrarPreviewFoto(URL.createObjectURL(file));
  } catch (err) {
    // CORS, timeout, red caída, etc. — la foto es un "extra", nunca debe
    // romper el autocompletado del nombre ni el alta del producto.
    console.warn('[productos] no se pudo traer la foto del código escaneado:', err?.message);
  }
}

window.setNombreProductoSiVacio = setNombreProductoSiVacio;
window.setFotoProductoDesdeUrl  = setFotoProductoDesdeUrl;

// v629 — Se llama apenas se detecta un código NUEVO (onCodigoEscaneado en
// productos-scanner-remoto.js), ANTES de salir a buscar sus datos. Si el
// nombre/foto que hay en pantalla vinieron de un escaneo anterior (nunca
// de que el usuario los haya tipeado/elegido a mano), los limpia — así:
//   1. Nunca queda a la vista, ni por un instante, el nombre/foto de OTRO
//      producto mientras se busca el del código recién leído.
//   2. El nuevo resultado no queda bloqueado por el guard de "no pisar lo
//      que ya hay", porque el campo vuelve a estar realmente vacío.
// Si el usuario sí tipeó/eligió algo a mano, esto no lo toca.
function limpiarAutoCompletadoSiCorresponde() {
  const inputNombre = document.getElementById('fp-nombre');
  if (inputNombre && nombreProductoAutoCompletado) {
    inputNombre.value = '';
    nombreProductoAutoCompletado = false;
  }
  if (fotoProductoAutoCompletada) {
    fotoProductoFile           = null;
    fotoProductoAutoCompletada = false;
    if (!fotoProductoUrlActual) mostrarPreviewFoto(null);
  }
}
window.limpiarAutoCompletadoSiCorresponde = limpiarAutoCompletadoSiCorresponde;

// v626 — forzarFotoProductoDesdeUrl: descarga y aplica una imagen al formulario
// SIN los guards de setFotoProductoDesdeUrl. Usada por refrescarImagen()
// (productos-scanner-remoto.js) cuando ya hay una imagen auto-completada y se
// quiere pisar con la nueva foto devuelta por /api/banco-codigos?accion=refrescar.
//
// A diferencia de setFotoProductoDesdeUrl, esta función:
//   - No verifica si fotoProductoFile ya está seteado (guard de "no pisar al usuario")
//   - No verifica fotoProductoUrlActual
//   - Sí resetea limpiamente el estado antes de aplicar la nueva imagen
//   - No pisa si el usuario actuó MIENTRAS se descargaba (mismo chequeo final)
async function forzarFotoProductoDesdeUrl(url) {
  if (!url) return;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    const blob = await r.blob();
    if (!FOTO_PRODUCTO_MIME_OK.includes(blob.type)) return;
    if (blob.size > FOTO_PRODUCTO_MAX_BYTES) return;

    const ext  = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const file = new File([blob], `escaneo.${ext}`, { type: blob.type });

    // Chequeo de concurrencia: si el usuario tocó el input de archivo manualmente
    // mientras se descargaba, no pisarle su elección. Sí se puede pisar fotoProductoFile
    // porque eso lo setea el scanner, no el usuario.
    if (fotoProductoQuitar) return;

    fotoProductoFile      = file;
    fotoProductoUrlActual = null;
    fotoProductoQuitar    = false;
    fotoProductoAutoCompletada = true;
    mostrarPreviewFoto(URL.createObjectURL(file));
  } catch (err) {
    console.warn('[productos] forzarFotoProductoDesdeUrl:', err?.message);
  }
}

window.forzarFotoProductoDesdeUrl = forzarFotoProductoDesdeUrl;

function poblarSelectCategoriasModal() {
  const sel = document.getElementById('fp-categoria_id');
  if (!sel) return;
  const actual = sel.value;
  sel.innerHTML = '<option value="">Sin categoría</option>' +
    categoriasAll.map(c => `<option value="${c.id}">${escHtml(c.nombre)}</option>`).join('') +
    '<option value="__nueva__">+ Nueva categoría...</option>';
  sel.value = actual;
}

// Detecta "+ Nueva categoría..." en el select del modal de producto y abre
// el alta rápida sin perder lo que ya se cargó del producto.
function onCambioCategoriaFP(select) {
  if (select.value === '__nueva__') {
    select.value = '';
    abrirModalCategoriaRapida();
  }
}

function abrirModalCategoriaRapida() {
  document.getElementById('cat-nombre').value = '';
  document.getElementById('modal-backdrop-cat-rapida').style.display = 'block';
  document.getElementById('modal-categoria-rapida').style.display = 'block';
  setTimeout(() => document.getElementById('cat-nombre')?.focus(), 50);
}

function cerrarModalCategoriaRapida() {
  document.getElementById('modal-backdrop-cat-rapida').style.display = 'none';
  document.getElementById('modal-categoria-rapida').style.display = 'none';
}

function cerrarModalCategoriaRapidaSiFondo(event) {
  cerrarModalCategoriaRapida();
}

async function guardarCategoriaRapida() {
  const nombre = document.getElementById('cat-nombre').value.trim();
  if (!nombre) { toast('El nombre es obligatorio', 'warning'); return; }

  const token = await getToken();
  const res = await fetch('/api/maestros?recurso=categorias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nombre }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'No se pudo crear la categoría', 'error');
    return;
  }

  const nueva = await res.json();
  toast('Categoría creada', 'success');
  cerrarModalCategoriaRapida();

  await cargarCategorias();
  poblarSelectCategoriasModal();
  const sel = document.getElementById('fp-categoria_id');
  if (sel) sel.value = nueva.id;
}
