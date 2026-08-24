(()=>{(()=>{"use strict";function i(){const t=document.querySelector("#automatizacion"),o=document.querySelector("#automatizacion .feature-image");if(!t||!o)return;const e=t.querySelector(".feature-copy");if(e&&e.dataset.copyVersion!=="adaptacion-v1"){const a=e.querySelector(".eyebrow"),r=e.querySelector("h2"),s=e.querySelector("p"),l=[...e.querySelectorAll("li")],u=e.querySelector(".text-link");if(a&&(a.textContent="ADAPTACI\xD3N A TU MEDIDA"),r&&(r.innerHTML="Tu negocio no se adapta al sistema.<br><em>El sistema se adapta a vos.</em>"),s&&(s.textContent="Si tu comercio o empresa necesita una forma distinta de trabajar, adaptamos Fluxo a tu operaci\xF3n sin cargo adicional."),["Configuraci\xF3n a medida para tu negocio","Implementaci\xF3n sin costo extra","Acompa\xF1amiento para empezar"].forEach((c,p)=>{if(l[p]){const m=l[p].querySelector("svg");l[p].replaceChildren(...m?[m,document.createTextNode(` ${c}`)]:[document.createTextNode(c)])}}),u){const c=u.querySelector("svg");u.replaceChildren(document.createTextNode("Adaptamos Fluxo a tu operaci\xF3n "),...c?[c]:[])}e.dataset.copyVersion="adaptacion-v1"}o.dataset.visualVersion!=="v2"&&(o.dataset.visualVersion="v2",o.classList.add("feature-process-visual"),o.innerHTML=`
      <div class="process-caption">
        <span>De tu operaci\xF3n a tu sistema</span>
        <span>Adaptaci\xF3n incluida</span>
      </div>
      <div class="process-lane" aria-label="Proceso de adaptaci\xF3n de tu negocio">
        <div class="process-step">
          <small>01 \xB7 CONOCEMOS</small>
          <strong>Entendemos tu forma de trabajar</strong>
          <div class="process-file">tu operaci\xF3n real</div>
        </div>
        <i class="process-arrow" aria-hidden="true"></i>
        <div class="process-step">
          <small>02 \xB7 ADAPTAMOS</small>
          <strong>Configuraci\xF3n a medida</strong>
          <p>Fluxo se ajusta a tu circuito y a tu equipo.</p>
        </div>
        <i class="process-arrow" aria-hidden="true"></i>
        <div class="process-step">
          <small>03 \xB7 ACOMPA\xD1AMOS</small>
          <strong>Listo para operar</strong>
          <p>Adaptaci\xF3n sin cargo adicional para tu negocio.</p>
        </div>
      </div>
      <div class="process-status">Tu operaci\xF3n, tu forma de trabajar, un sistema que acompa\xF1a.</div>
    `)}function d(){const t=document.querySelector("#colaboracion .feature-image");!t||t.dataset.visualVersion==="v2"||(t.dataset.visualVersion="v2",t.classList.add("feature-live-visual"),t.innerHTML=`
      <div class="live-caption">
        <span>Una misma operaci\xF3n</span>
        <span>\u25CF Sincronizado ahora</span>
      </div>
      <div class="live-track" aria-label="Estados del pedido">
        <div class="live-row">
          <span aria-hidden="true"></span>
          <div><strong>Pedido #1842</strong><small>Listo para preparar</small></div>
          <b>Dep\xF3sito</b>
        </div>
        <div class="live-row">
          <span aria-hidden="true"></span>
          <div><strong>Ruta Norte</strong><small>En reparto \xB7 8 paradas</small></div>
          <b>En vivo</b>
        </div>
        <div class="live-row">
          <span aria-hidden="true"></span>
          <div><strong>Cobranza</strong><small>Pago confirmado</small></div>
          <b>Cerrado</b>
        </div>
      </div>
      <div class="live-footer"><span>El estado viaja con el pedido</span><strong>\u25CF Todo conectado</strong></div>
    `)}function n(){i(),d()}n(),window.setTimeout(n,80),new MutationObserver(n).observe(document.documentElement,{childList:!0,subtree:!0})})();(function(){"use strict";var i=[{source:"Tienda online con Mercado Pago",replacement:"Tu vidriera digital"},{source:"Vend\xE9 online y cobr\xE1 con Mercado Pago, con stock actualizado.",replacement:"Public\xE1 y cobr\xE1 con Mercado Pago mientras el inventario se mantiene al d\xEDa."},{source:"WhatsApp Business integrado",replacement:"WhatsApp bidireccional"},{source:"Tus clientes piden por WhatsApp y el sistema carga cada pedido autom\xE1ticamente.",replacement:"Fluxo responde solo, sin que nadie del equipo escriba: recibe, contesta y carga el pedido."},{source:"Punto de venta y medios de pago",replacement:"Cobros en mostrador"},{source:"Acept\xE1 efectivo, tarjetas, QR y c\xF3digos de barra con lector f\xEDsico o c\xE1mara.",replacement:"Acept\xE1 efectivo, tarjetas, QR y c\xF3digos de barra desde un \xFAnico punto."},{source:"Facturaci\xF3n ARCA homologada",replacement:"Facturaci\xF3n ARCA lista"},{source:"Integr\xE1 ARCA en un clic y emit\xED facturas homologadas desde el pedido.",replacement:"Emit\xED comprobantes homologados desde el pedido, sin volver a escribir datos."},{source:"Sistema de reparto en vivo",replacement:"Rutas y entregas en marcha"},{source:"Segu\xED rutas, choferes y entregas en vivo, todo sincronizado con Fluxo.",replacement:"Coordin\xE1 recorridos, choferes y entregas con una vista compartida."},{source:"Asistente IA incluido",replacement:"Un asistente que conoce tu negocio"},{source:"Adjunt\xE1 un archivo y la IA lo procesa y lo convierte en acciones.",replacement:"Preguntale por stock, ventas o cobros pendientes; en Platinum, tambi\xE9n los resuelve por vos."},{source:"Importaci\xF3n y migraci\xF3n en un clic",replacement:"Datos listos en un clic"},{source:"Arrastr\xE1 un archivo para importar productos, clientes y stock.",context:".hero-offer",replacement:"Sub\xED productos, clientes y existencias sin atravesar una migraci\xF3n manual."},{source:"Automatizaci\xF3n del pedido al cobro",replacement:"Circuito operativo conectado"},{source:"Conect\xE1 pedido, stock, factura, reparto y cobro sin carga manual.",context:".hero-offer",replacement:"Un\xED cada etapa, desde la solicitud hasta el cobro, con menos tareas repetidas."},{source:"Cat\xE1logo, stock y Mercado Pago en un mismo circuito.",replacement:"Cat\xE1logo, precios y cobros en un mismo lugar."},{source:"Pedidos autom\xE1ticos desde el canal donde ya te escriben.",replacement:"Conversaci\xF3n bidireccional: el sistema responde solo, sin intervenci\xF3n humana."},{source:"Caja, QR, tarjetas y c\xF3digos de barra conectados.",replacement:"Caja, QR, tarjetas y c\xF3digos conectados."},{source:"Comprobantes homologados sin volver a cargar datos.",replacement:"Emit\xED comprobantes sin volver a escribir datos."},{source:"Reparto en vivo",replacement:"Seguimiento de entregas"},{source:"Rutas, choferes y entregas visibles en tiempo real.",replacement:"Rutas y choferes visibles en tiempo real."},{source:"Proces\xE1 archivos y convert\xED informaci\xF3n en acciones.",replacement:"Consultas por voz o texto sobre tu negocio; en Platinum, tambi\xE9n act\xFAa."},{source:"Importaci\xF3n y migraci\xF3n",replacement:"Carga de datos"},{source:"Arrastr\xE1 un archivo para importar productos, clientes y stock.",context:".product-card",replacement:"Tra\xE9 productos, clientes y existencias en un paso."},{source:"Automatizaci\xF3n del cobro",replacement:"Flujo conectado"},{source:"Conect\xE1 pedido, stock, factura, reparto y cobro sin carga manual.",context:".product-card",replacement:"Del pedido al cobro, con reglas de automatizaci\xF3n que configur\xE1s vos."},{source:"\xBFQu\xE9 puedo gestionar con Fluxo?",replacement:"\xBFQu\xE9 puedo ordenar con Fluxo?"},{source:"Pedidos, clientes, productos, stock, ventas, rutas, entregas, cobranzas y facturaci\xF3n en un solo circuito.",replacement:"Pedidos, clientes, productos, stock, ventas, rutas, entregas, cobranzas y facturaci\xF3n quedan reunidos en una sola operaci\xF3n."},{source:"\xBFC\xF3mo funciona la integraci\xF3n con WhatsApp Business?",replacement:"\xBFC\xF3mo funciona la respuesta autom\xE1tica por WhatsApp?"},{source:"Los pedidos entran desde WhatsApp, se registran en el sistema y quedan disponibles para preparar, cobrar y entregar.",replacement:"Es bidireccional: Fluxo recibe el mensaje y responde autom\xE1ticamente, sin que alguien del equipo tenga que escribir. El pedido se registra solo y queda listo para preparar, cobrar y entregar."},{source:"\xBFPuedo usar lectores de c\xF3digos?",replacement:"\xBFSe pueden usar lectores de c\xF3digos?"},{source:"\xBFLa facturaci\xF3n ARCA queda homologada?",replacement:"\xBFLa facturaci\xF3n con ARCA queda homologada?"},{source:"La integraci\xF3n permite emitir comprobantes homologados desde el flujo del pedido, sin duplicar la carga.",replacement:"S\xED. Emit\xEDs comprobantes v\xE1lidos desde el flujo del pedido, sin duplicar la carga."},{source:"\xBFPuedo migrar datos desde otro sistema?",replacement:"\xBFPuedo traer datos de otro sistema?"},{source:"S\xED. Arrastr\xE1 un archivo para importar productos, clientes y stock en un solo paso.",replacement:"S\xED. Sub\xED productos, clientes y existencias en un solo paso."}];function d(o,e){var a=o.nodeType===Node.TEXT_NODE?o.parentElement:o;return!!(a&&a.closest&&a.closest(e))}function n(o){for(var e=document.createTreeWalker(o,NodeFilter.SHOW_TEXT),a;a=e.nextNode();){var r=a.nodeValue;i.forEach(function(s){r.indexOf(s.source)!==-1&&(s.context&&!d(a,s.context)||(r=r.split(s.source).join(s.replacement)))}),r!==a.nodeValue&&(a.nodeValue=r)}}function t(){n(document.body);var o=new MutationObserver(function(e){e.forEach(function(a){a.addedNodes.forEach(function(r){(r.nodeType===Node.ELEMENT_NODE||r.nodeType===Node.TEXT_NODE)&&n(r)})})});o.observe(document.getElementById("root")||document.body,{childList:!0,subtree:!0})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",t):t()})();})();
