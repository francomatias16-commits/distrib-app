// frontend/admin/js/stock-scanner-remoto.js
//
// v617 — "Vincular celular" en la pantalla de Stock. Usa el widget genérico
// (frontend/shared/vincular-celular.js) con contexto `ajuste_stock`: el
// vínculo queda atado al depósito que esté elegido en #filtro-deposito al
// momento de generarlo (mismo depósito para el que el backend valida el
// token — ver CONTEXTOS.ajuste_stock en lib/handlers/pos-scanner.js), así
// que requiere tener un depósito puntual seleccionado, no "Todos".
//
// Por cada código que llega del celular: busca el producto por código
// dentro de ESE depósito (vía RPC fn_stock_lista, mismo filtro que usa la
// tabla) y, si lo encuentra, abre directo su modal de ajuste — el mismo
// abrirModal(...) que usa el botón "Ajustar stock" de la fila. Si no lo
// encuentra en ese depósito (existe en otro, o no existe), avisa con un
// toast en vez de fallar en silencio.
//
// Script plano (no ES module) — stock.js es un módulo y no expone `sb` a
// window, así que acá se usa window.authCtx.sb directamente, igual que
// hace stock.js internamente.
//
// v619: el vínculo (token + canal) queda vivo mientras se sigue
// escaneando producto tras producto — igual que el POS (ver comentario
// en pos-scanner-remoto.js): solo se corta por inactividad real o porque
// el usuario elige "Cerrar vínculo" a mano, nunca automáticamente al
// procesar un código. Lo único que se hace acá al recibir un código es
// ocultar() el modal del escáner (no desvincular()) — el modal "Ajustar
// stock" que se abre a continuación tiene menor z-index, así que si no se
// esconde el cartel de "Celular conectado" queda tapándolo.

(function () {
  'use strict';

  let primerCodigoDeEstaSesion = true;

  function depositoSeleccionado() {
    return document.getElementById('filtro-deposito')?.value || '';
  }

  function nombreDeposito(depId) {
    const sel = document.getElementById('filtro-deposito');
    const opt = sel?.querySelector(`option[value="${CSS.escape(depId)}"]`);
    return opt ? opt.textContent.trim() : '';
  }

  // Lleva al usuario directo al select de depósito cuando falta elegir uno
  // puntual (en vez de solo avisarle con el toast): en mobile el bloque de
  // filtros avanzados está colapsado por defecto (ver toggleFiltrosAvanzados
  // en stock.js), así que primero hay que desplegarlo. Después scrollea,
  // resalta brevemente y enfoca/abre el combo — showPicker() despliega la
  // lista de opciones de una si el navegador lo soporta (Chrome/Edge); si
  // no, el foco + resalte igual deja clarísimo dónde hay que tocar.
  function irAlFiltroDeposito() {
    const wrap = document.getElementById('filtros-avanzados-stock');
    if (wrap && !wrap.classList.contains('abierto')) {
      wrap.classList.add('abierto');
      document.getElementById('btn-toggle-filtros-der')?.classList.add('abierto');
      document.getElementById('btn-toggle-filtros-der')?.setAttribute('aria-expanded', 'true');
    }
    const sel = document.getElementById('filtro-deposito');
    if (!sel) return;
    sel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    sel.classList.add('campo-resaltado-atencion');
    const quitarResalte = () => sel.classList.remove('campo-resaltado-atencion');
    sel.addEventListener('change', quitarResalte, { once: true });
    sel.addEventListener('blur', quitarResalte, { once: true });
    setTimeout(quitarResalte, 3000);
    sel.focus({ preventScroll: true });
    try { sel.showPicker?.(); } catch (_) { /* no soportado — el foco alcanza */ }
  }

  async function buscarYAbrir(codigo, depId) {
    const sb = window.authCtx?.sb;
    if (!sb) return;

    // Se esconde el modal del escáner (no se corta el vínculo) apenas
    // llega el código: el "Ajustar stock" que puede abrirse a
    // continuación necesita quedar visible, y el celular sigue
    // disponible para el próximo escaneo aunque el cartel esté oculto.
    window.VincularCelular.ocultar();
    if (primerCodigoDeEstaSesion) {
      primerCodigoDeEstaSesion = false;
      window.mostrarToast?.('El celular sigue vinculado: podés seguir escaneando productos de este depósito.', 'default', 4000);
    }

    try {
      const { data, error } = await sb
        .from('stock')
        .select(`
          producto_id,
          deposito_id,
          cantidad,
          cantidad_reservada,
          cantidad_disponible,
          costo_promedio,
          productos!inner(id, nombre, unidad, activo, codigo)
        `)
        .eq('deposito_id', depId)
        .eq('productos.codigo', codigo)
        .eq('productos.activo', true)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        window.mostrarToast
          ? window.mostrarToast(`No se encontró "${codigo}" en este depósito.`, 'error', 3500)
          : console.warn(`[stock-scanner-remoto] no se encontró "${codigo}" en el depósito ${depId}`);
        return;
      }

      const p = data.productos;
      await window.abrirModal(
        data.producto_id,
        data.deposito_id,
        Number(data.cantidad_disponible) || 0,
        p.nombre,
        p.unidad || 'un',
        Number(data.costo_promedio) || 0,
        Number(data.cantidad) || 0,
        Number(data.cantidad_reservada) || 0
      );
    } catch (err) {
      console.error('[stock-scanner-remoto] error al buscar el producto escaneado:', err);
      window.mostrarToast?.('No se pudo buscar el producto escaneado.', 'error', 3500);
    }
  }

  function abrirVincularCelularStock() {
    const depId = depositoSeleccionado();
    if (!depId) {
      window.mostrarToast
        ? window.mostrarToast('Elegí un depósito puntual en el filtro antes de vincular el celular.', 'error', 4000)
        : alert('Elegí un depósito puntual en el filtro antes de vincular el celular.');
      irAlFiltroDeposito();
      return;
    }
    if (!window.authCtx?.sb) return;

    primerCodigoDeEstaSesion = true;
    window.VincularCelular.abrir({
      contexto: 'ajuste_stock',
      entidad_id: depId,
      sb: window.authCtx.sb,
      titulo: `Ajuste de stock — ${nombreDeposito(depId) || 'depósito'}`,
      onCodigo: (codigo) => buscarYAbrir(codigo, depId),
    });
  }

  // v628 — Escanear con la cámara de ESTE dispositivo (compu o celular),
  // sin vincular un segundo aparato. Mismo destino final (buscarYAbrir) que
  // el flujo de celular vinculado: requiere depósito puntual seleccionado
  // por la misma razón (el ajuste de stock es siempre por depósito).
  function abrirEscanerCamaraStock() {
    const depId = depositoSeleccionado();
    if (!depId) {
      window.mostrarToast
        ? window.mostrarToast('Elegí un depósito puntual en el filtro antes de escanear.', 'error', 4000)
        : alert('Elegí un depósito puntual en el filtro antes de escanear.');
      irAlFiltroDeposito();
      return;
    }
    if (!window.CameraScanner) return;

    window.CameraScanner.abrir({
      titulo: `Ajuste de stock — ${nombreDeposito(depId) || 'depósito'}`,
      instrucciones: 'Apuntá la cámara al código de barras del producto.',
      onCodigo: (codigo) => buscarYAbrir(codigo, depId),
    });
  }

  window.abrirVincularCelularStock = abrirVincularCelularStock;
  window.abrirEscanerCamaraStock   = abrirEscanerCamaraStock;
})();
