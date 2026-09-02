// frontend/admin/js/etiquetas-print.js
// Motor de impresión de etiquetas de precio/código de barras.
// Ver PLAN_ETIQUETAS_PRECIO_CODIGO_BARRAS.md.
//
// ETAPA 1 (esta entrega): armado de la grilla imprimible con datos
// ESTÁTICOS de prueba y el ajuste de página por navegador. La Etapa 2
// conecta la selección real de productos (listado de Productos → botón
// "Generar etiquetas"); la Etapa 3, la precarga desde Recepción de
// mercadería. Ninguna de las dos toca este archivo en su forma — solo
// reemplazan el array estático de `datosDePrueba()` por productos reales.
//
// Mismo principio que pos-printer.js (v758): no pelea con drivers de
// impresora — inyecta un <style> con @page en las medidas configuradas
// (mm, no rollo) y deja que window.print() + el diálogo del navegador
// resuelvan la salida física (hoja troquelada tipo Avery, rollo continuo
// de etiquetas térmicas, lo que tenga el cliente).
//
// Requiere JsBarcode cargado antes que este archivo (CDN, ver pos.html).
//
// API pública (window.EtiquetasPrint):
//   armarGrilla(productos, config)   — arma el HTML de la grilla imprimible
//   imprimir(productos, config)      — arma la grilla, la monta y dispara window.print()
//   datosDePrueba()                  — 6 productos ficticios para la vista previa de Etapa 1

'use strict';

(function () {

  const fmt$ = (v) => '$ ' + Number(v || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  // ── Regla de generación del código a imprimir (sección 4 del plan) ───────
  // Devuelve { valor, formato } — formato ∈ 'ean13' | 'code128' | null (sin
  // código válido para imprimir, ej. producto sin `codigo` cargado).
  function resolverCodigo(producto, config) {
    const forzado = config?.formato_simbologia;

    if (producto.vendido_por_peso) {
      // Código de balanza variable: prefijo 20-29 + código interno (5
      // dígitos, padded) + placeholder de importe/peso (00000) + dígito
      // verificador se recalcula al pesar en la balanza real — acá se deja
      // en 0 relleno porque la etiqueta pegada en góndola es previa al
      // pesaje real (el cliente pesa en el momento, en caja o en el mostrador
      // con balanza conectada). El propósito de esta etiqueta es mostrar
      // precio por kg/unidad, no un código escaneable de venta puntual.
      const interno = String(producto.codigo || '').replace(/\D/g, '').padStart(5, '0').slice(-5);
      return { valor: '20' + interno + '000000', formato: 'code128' };
    }

    const codigo = String(producto.codigo || '').trim();
    if (!codigo) return { valor: null, formato: null };

    if (forzado === 'ean13') return { valor: codigo, formato: 'ean13' };
    if (forzado === 'code128') return { valor: codigo, formato: 'code128' };

    // 'auto' (default): EAN-13 si el flag está seteado y son 13 dígitos
    // numéricos válidos; CODE128 para cualquier otro caso.
    if (producto.codigo_es_barras && /^\d{13}$/.test(codigo)) {
      return { valor: codigo, formato: 'ean13' };
    }
    return { valor: codigo, formato: 'code128' };
  }

  // `base` es el precio SIN IVA sobre el que calcular — regular o
  // promocional, según lo llame renderEtiqueta() (Etapa 4, 543).
  function precioConIva(base, producto, config) {
    const b = Number(base || 0);
    if (!config?.incluir_iva) return b;
    const ivaPct = Number(producto.iva || 0);
    return b * (1 + ivaPct / 100);
  }

  // ── Render de una etiqueta individual ─────────────────────────────────────
  // Etapa 4 (543): si el producto trae `precio_promocional` (resuelto en
  // el backend por resolver_precios_etiquetas — ver
  // lib/repos/productos.js) y `config.mostrar_promociones` no está
  // apagado, se imprime el precio regular tachado + el promocional
  // destacado, igual que un cartel de oferta de góndola. Si no hay
  // promoción vigente para ese producto, se imprime un único precio
  // como hasta la Etapa 3 — sin cambio visual.
  function renderEtiqueta(producto, config) {
    const { valor, formato } = resolverCodigo(producto, config);
    // precio_regular es el que resuelve el backend (lista_precio_default_id
    // o precio_base); fallback a precio_base a secas para compatibilidad
    // con datosDePrueba() y cualquier caller viejo que no lo mande.
    const base = producto.precio_regular ?? producto.precio_base;
    const precioRegular = precioConIva(base, producto, config);

    const hayPromo = config?.mostrar_promociones !== false && producto.precio_promocional != null;
    const precioPromo = hayPromo ? precioConIva(producto.precio_promocional, producto, config) : null;

    const unidad = producto.vendido_por_peso ? ' /' + (producto.unidad || 'kg') : '';
    const svgId = 'etq-svg-' + Math.random().toString(36).slice(2, 10);

    const bloquePrecio = hayPromo
      ? `<div class="etq-precio-regular">${escaparHtml(fmt$(precioRegular))}${escaparHtml(unidad)}</div>
         <div class="etq-precio etq-precio-promo">${escaparHtml(fmt$(precioPromo))}${escaparHtml(unidad)}</div>`
      : `<div class="etq-precio">${escaparHtml(fmt$(precioRegular))}${escaparHtml(unidad)}</div>`;

    return `
      <div class="etq-item">
        <div class="etq-nombre">${escaparHtml(producto.nombre || '')}</div>
        ${bloquePrecio}
        ${valor
          ? `<svg class="etq-barcode" id="${svgId}" data-valor="${escaparAtributo(valor)}" data-formato="${formato}"></svg>`
          : `<div class="etq-sin-codigo">Sin código de barras</div>`}
        ${config?.mostrar_codigo_interno && valor ? `<div class="etq-codigo-texto">${escaparHtml(valor)}</div>` : ''}
      </div>`;
  }

  function escaparHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function escaparAtributo(s) { return escaparHtml(s); }

  // ── Hoja de estilos de impresión (@page en mm reales de la etiqueta) ─────
  // Mismo principio que prepararPaginaNavegador() de pos-printer.js, pero acá
  // el ancho/alto sale de config_etiquetas (mm reales de la etiqueta), no de
  // un rollo térmico de ancho fijo (58/80).
  function prepararPaginaEtiquetas(config) {
    const anchoMm  = Number(config?.ancho_mm)  || 50;
    const altoMm   = Number(config?.alto_mm)   || 25;
    const columnas = Math.max(1, parseInt(config?.columnas, 10) || 3);
    const margenMm = Number(config?.margen_mm) ?? 2;
    const anchoHojaMm = anchoMm * columnas + margenMm * (columnas + 1);

    let style = document.getElementById('etiquetas-print-page-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'etiquetas-print-page-style';
      document.head.appendChild(style);
    }
    style.textContent = `
      /* FIX v981: #etiquetas-print-root se agrega como último hijo de
         <body> (ver montarGrilla) y ANTES tenía "display: grid" sin
         escopar a @media print — en pantalla quedaba visible como una
         grilla suelta flotando sobre el resto de la interfaz (rompía
         Etiquetas de precio después de "Vista previa de prueba", y
         Productos después de cerrar el modal "Generar etiquetas", que
         reusa este mismo motor vía etiquetas-preview.js). El "visibility:
         hidden" de acá abajo solo tapa el CONTENIDO del resto de la
         página durante la impresión — nunca ocultaba la grilla en sí en
         pantalla normal, porque su display:grid vivía fuera del
         @media print. Ahora #etiquetas-print-root arranca oculto
         (display:none) y solo se muestra como grilla dentro de
         @media print. */
      #etiquetas-print-root {
        display: none;
      }
      @media print {
        body * { visibility: hidden; }
        #etiquetas-print-root, #etiquetas-print-root * { visibility: visible; }
        #etiquetas-print-root {
          display: grid;
          position: absolute; left: 0; top: 0;
          grid-template-columns: repeat(${columnas}, ${anchoMm}mm);
          gap: ${margenMm}mm;
          padding: ${margenMm}mm;
        }
      }
      @page { size: ${anchoHojaMm}mm auto; margin: 0; }
      #etiquetas-print-root .etq-item {
        width: ${anchoMm}mm;
        height: ${altoMm}mm;
        box-sizing: border-box;
        border: 1px dashed #ccc;
        padding: 1.5mm;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        font-family: Arial, Helvetica, sans-serif;
        text-align: center;
        break-inside: avoid;
      }
      #etiquetas-print-root .etq-nombre {
        font-size: 8.5px;
        font-weight: 600;
        line-height: 1.1;
        max-height: 2.2em;
        overflow: hidden;
        width: 100%;
      }
      #etiquetas-print-root .etq-precio {
        font-size: 13px;
        font-weight: 700;
        margin: 0.5mm 0;
      }
      #etiquetas-print-root .etq-precio-regular {
        font-size: 9px;
        font-weight: 500;
        color: #666;
        text-decoration: line-through;
        margin-top: 0.5mm;
      }
      #etiquetas-print-root .etq-precio-promo {
        color: #b00020;
        font-size: 14px;
      }
      #etiquetas-print-root .etq-barcode {
        width: 90%;
        max-height: ${Math.max(6, altoMm * 0.35)}mm;
      }
      #etiquetas-print-root .etq-codigo-texto {
        font-size: 7px;
        letter-spacing: 0.5px;
      }
      #etiquetas-print-root .etq-sin-codigo {
        font-size: 7px;
        color: #b00;
      }
      @media print {
        #etiquetas-print-root .etq-item { border: none; }
      }
    `;
  }

  // ── Armado + montaje de la grilla ─────────────────────────────────────────
  // `productos` puede traer `_copias` (cantidad de etiquetas a repetir por
  // producto, ej. = cantidad recibida en la Etapa 3) — default 1.
  function armarGrilla(productos, config) {
    const items = [];
    for (const p of productos) {
      const copias = Math.max(1, parseInt(p._copias, 10) || 1);
      for (let i = 0; i < copias; i++) items.push(p);
    }
    return items.map((p) => renderEtiqueta(p, config)).join('');
  }

  function montarGrilla(productos, config) {
    let root = document.getElementById('etiquetas-print-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'etiquetas-print-root';
      document.body.appendChild(root);
    }
    prepararPaginaEtiquetas(config);
    root.innerHTML = armarGrilla(productos, config);

    // Renderizar cada código de barras con JsBarcode (requiere el <svg> ya
    // en el DOM — por eso va después del innerHTML, no en renderEtiqueta).
    root.querySelectorAll('.etq-barcode').forEach((svg) => {
      const valor   = svg.dataset.valor;
      const formato = svg.dataset.formato === 'ean13' ? 'EAN13' : 'CODE128';
      try {
        window.JsBarcode(svg, valor, {
          format: formato,
          displayValue: false,
          margin: 0,
          height: 40,
        });
      } catch (e) {
        // Valor inválido para el formato (ej. EAN-13 con dígito verificador
        // incorrecto) — no cortar toda la grilla por una etiqueta, se deja
        // vacía y queda visible en la vista previa para que el usuario lo note.
        console.warn('[EtiquetasPrint] No se pudo generar código de barras:', valor, e.message);
      }
    });

    return root;
  }

  async function imprimir(productos, config) {
    montarGrilla(productos, config);
    window.print();
  }

  // ── Datos de prueba (Etapa 1) ─────────────────────────────────────────────
  // 6 productos ficticios cubriendo los 3 casos de la sección 4 del plan:
  // EAN-13 real, CODE128 (código interno alfanumérico) y vendido_por_peso.
  function datosDePrueba() {
    return [
      // Con promoción — para probar visualmente el precio tachado
      // (Etapa 4, 543) sin tener que cargar una regla real todavía.
      // FIX v980: los 3 códigos EAN-13 de prueba tenían el dígito
      // verificador mal calculado (dato inventado a mano) — JsBarcode
      // valida el checksum real y tiraba "No se pudo generar código de
      // barras" para los 3, siempre, en toda vista previa de prueba.
      // Recalculados con el algoritmo estándar GTIN-13 (suma ponderada
      // 1-3 alternada sobre los primeros 12 dígitos).
      { nombre: 'Yerba Mate 1kg',        codigo: '7790070410122', codigo_es_barras: true,  precio_regular: 3200, precio_promocional: 2690, iva: 21, vendido_por_peso: false },
      { nombre: 'Fideos Tallarín 500g',  codigo: '7790040012226', codigo_es_barras: true,  precio_regular: 1150, iva: 21, vendido_por_peso: false },
      { nombre: 'Jabón en Polvo 3kg',    codigo: '7791234567898', codigo_es_barras: true,  precio_base: 5400, iva: 21, vendido_por_peso: false },
      { nombre: 'Producto interno PROD-0042', codigo: 'PROD-0042', codigo_es_barras: false, precio_base: 890,  iva: 21, vendido_por_peso: false },
      { nombre: 'Queso Cremoso',         codigo: '00042',          codigo_es_barras: false, precio_base: 4200, iva: 21, vendido_por_peso: true, unidad: 'kg' },
      { nombre: 'Fiambre Jamón Cocido',  codigo: '00051',          codigo_es_barras: false, precio_base: 6800, iva: 21, vendido_por_peso: true, unidad: 'kg' },
    ];
  }

  window.EtiquetasPrint = {
    armarGrilla,
    montarGrilla,
    imprimir,
    datosDePrueba,
    prepararPaginaEtiquetas,
  };

})();
