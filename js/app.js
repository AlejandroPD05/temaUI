/**
 * Capa de pegamento: lista "A continuación", búsqueda, atajos de teclado,
 * diálogo de ayuda y arranque.
 *
 * Es el ÚNICO fichero que conoce los tres módulos a la vez, así que es donde
 * se decide el orden de arranque y quién se suscribe a qué. No reimplementa
 * nada que ya haga themes.js o player.js: sólo compone.
 *
 * IIFE clásica publicando en `window.TemaUI` (sin módulos ES: la demo se abre
 * con doble clic y `file://` bloquearía los imports).
 * Orden de carga: data.js → themes.js → player.js → app.js.
 */
(function (global) {
  'use strict';

  var TemaUI = (global.TemaUI = global.TemaUI || {});

  /* --- Estado local ------------------------------------------------------ */

  /** @type {HTMLElement[]} */
  var el = {};

  var ui = {
    query: '',
    dialogOpen: false,
    /** Foco a devolver al cerrar el diálogo de atajos. */
    returnFocus: null,
    /** Última fila marcada, para no rehacer el marcador en cada tick. */
    markedId: null,
  };

  /**
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  function $(id) {
    return document.getElementById(id);
  }

  /** Cachea referencias. Cada una se comprueba: nada debe lanzar si falta. */
  function cacheDom() {
    el.list = $('upNextList');
    el.empty = $('upEmpty');
    el.count = $('upNextCount');
    el.status = $('searchStatus');
    el.search = $('searchInput');
    el.form = $('searchForm');

    el.shortcutsBtn = $('shortcutsBtn');
    el.shortcutsOverlay = $('shortcutsOverlay');
    el.shortcutsClose = $('shortcutsClose');
  }

  /* ======================================================================
     Lista "A continuación"
     ====================================================================== */

  /**
   * Construye una fila sin `innerHTML`: así el catálogo es la única fuente de
   * verdad y no hay una copia del HTML que pueda desincronizarse.
   *
   * La fila lleva `data-id` en el `<li>` Y en el botón porque player.js lo
   * busca en ambos sitios para marcar la fila en reproducción.
   *
   * @param {Object} ep
   * @returns {HTMLLIElement}
   */
  function buildRow(ep) {
    var li = document.createElement('li');
    li.className = 'up-item';
    li.setAttribute('data-id', ep.id);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'up-item__btn';
    btn.setAttribute('data-id', ep.id);

    var thumb = document.createElement('span');
    thumb.className = 'up-item__thumb';
    // El matiz llega como variable: css/player.css arma el degradado con
    // --art-sat/--art-light del tema activo, así la miniatura se recolorea
    // al cambiar de tema sin que nadie tenga que reescribirla.
    thumb.style.setProperty('--hue', String(ep.hue));

    var duration = document.createElement('span');
    duration.className = 'up-item__duration';
    duration.textContent = TemaUI.data.formatTime(ep.duration);
    thumb.appendChild(duration);

    var info = document.createElement('span');
    info.className = 'up-item__info';

    var title = document.createElement('span');
    title.className = 'up-item__title';
    title.textContent = ep.series;

    var sub = document.createElement('span');
    sub.className = 'up-item__sub';
    sub.textContent = ep.title;

    info.appendChild(title);
    info.appendChild(sub);
    btn.appendChild(thumb);
    btn.appendChild(info);
    li.appendChild(btn);

    btn.addEventListener('click', function () {
      selectEpisode(ep.id);
    });

    return li;
  }

  /**
   * @param {string} id
   */
  function selectEpisode(id) {
    var player = TemaUI.player;
    if (!player) return;
    // Mismo episodio: no reiniciamos el tiempo a cero. Haber hecho clic en lo
    // que ya se está viendo no debe castigar al usuario.
    var current = player.getState();
    if (current && current.id === id) return;
    player.load(id);
    player.play();
  }

  /** Dibuja la lista completa desde el catálogo. */
  function renderList() {
    if (!el.list) return;
    var fragment = document.createDocumentFragment();
    var episodes = TemaUI.data.EPISODES;
    for (var i = 0; i < episodes.length; i += 1) {
      fragment.appendChild(buildRow(episodes[i]));
    }
    el.list.textContent = '';
    el.list.appendChild(fragment);
    ui.markedId = null;
  }

  /**
   * Filtra por el texto escrito y actualiza contador, estado vacío y región
   * viva. Se ejecuta en cada pulsación: el catálogo son 9 filas, el coste es
   * ridículo y retrasar el filtro sólo haría que la interfaz mintiera.
   */
  function applyFilter() {
    if (!el.list) return;

    var results = TemaUI.data.search(ui.query);
    var visible = {};
    for (var i = 0; i < results.length; i += 1) {
      visible[results[i].id] = true;
    }

    var rows = el.list.querySelectorAll('.up-item');
    var shown = 0;
    for (var j = 0; j < rows.length; j += 1) {
      var match = visible[rows[j].getAttribute('data-id')] === true;
      rows[j].hidden = !match;
      if (match) shown += 1;
    }

    var total = TemaUI.data.EPISODES.length;
    var filtering = ui.query.length > 0;

    if (el.count) {
      el.count.textContent = filtering ? shown + ' de ' + total : total + ' episodios';
    }

    if (el.empty) el.empty.hidden = shown !== 0;
    if (el.list) el.list.hidden = shown === 0;

    if (el.status) {
      if (!filtering) {
        el.status.textContent = total + ' episodios en el catálogo.';
      } else if (shown === 0) {
        el.status.textContent = 'Sin resultados para ' + ui.query + '.';
      } else {
        el.status.textContent = shown + (shown === 1 ? ' resultado' : ' resultados') + ' para ' + ui.query + '.';
      }
    }

    // Al reordenar/filtrar puede salir a la luz la fila activa: hay que
    // volver a poner el marcador accesible.
    markCurrentRow();
  }

  /**
   * `is-current` pinta la fila con color, pero el color solo no basta
   * (WCAG 1.4.1). Este marcador, invisible a la vista, dice por voz qué fila
   * se está reproduciendo.
   *
   * @param {string|null} id
   */
  function markCurrentRow(id) {
    if (!el.list) return;
    var rows = el.list.querySelectorAll('.up-item');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var rowId = row.getAttribute('data-id');
      var info = row.querySelector('.up-item__info');
      var title = row.querySelector('.up-item__title');
      if (!info || !title) continue;

      var marker = row.querySelector('.up-item__now');

      if (rowId === id) {
        if (title.querySelector('.up-item__now')) continue;
        marker = document.createElement('span');
        marker.className = 'up-item__now visually-hidden';
        marker.textContent = 'Reproduciendo: ';
        // Antes del texto visible: el lector lo anuncia y luego el título.
        title.insertBefore(marker, title.firstChild);
      } else if (marker) {
        marker.parentNode.removeChild(marker);
      }
    }
  }

  function bindList() {
    if (!el.search) return;

    el.search.addEventListener('input', function () {
      ui.query = TemaUI.data.normalize(el.search.value);
      applyFilter();
    });

    // Sin esto, pulsar Intro recargaría la página y perdería el tema y el
    // estado del reproductor.
    if (el.form) {
      el.form.addEventListener('submit', function (event) {
        event.preventDefault();
      });
    }
  }

  /* ======================================================================
     Diálogo de atajos
     ====================================================================== */

  function shortcutsOpen() {
    return !!el.shortcutsOverlay && !el.shortcutsOverlay.hidden;
  }

  function openShortcuts() {
    if (!el.shortcutsOverlay) return;
    dispatchCloseMenus();
    ui.returnFocus = document.activeElement;
    el.shortcutsOverlay.hidden = false;
    document.body.classList.add('is-locked');
    ui.dialogOpen = true;
    if (el.shortcutsBtn) el.shortcutsBtn.setAttribute('aria-expanded', 'true');
    if (el.shortcutsClose && typeof el.shortcutsClose.focus === 'function') {
      el.shortcutsClose.focus();
    }
  }

  function closeShortcuts() {
    if (!el.shortcutsOverlay || el.shortcutsOverlay.hidden) return;
    el.shortcutsOverlay.hidden = true;
    document.body.classList.remove('is-locked');
    ui.dialogOpen = false;
    if (el.shortcutsBtn) el.shortcutsBtn.setAttribute('aria-expanded', 'false');

    var target = ui.returnFocus;
    ui.returnFocus = null;

    // Si al abrir no había foco real (activeElement es <body>), devolvérselo a
    // <body> no lleva a ninguna parte: <body> no es enfocable y el cursor
    // queda perdido. Se comprueba que el foco haya APLICADO antes de darlo
    // por bueno, y si no, se salta al botón que abrió el diálogo.
    var moved = false;
    if (target && target !== document.body && typeof target.focus === 'function') {
      target.focus();
      moved = document.activeElement === target;
    }
    if (!moved && el.shortcutsBtn) el.shortcutsBtn.focus();
  }

  /**
   * Cierra los menús flotantes de los otros módulos antes de abrir nosotros.
   * Reutiliza el mismo evento que player.js: es el protocolo de coordinación.
   */
  function dispatchCloseMenus() {
    var event;
    if (typeof global.CustomEvent === 'function') {
      event = new global.CustomEvent('tema-ui:close-menus');
    } else {
      event = document.createEvent('CustomEvent');
      event.initCustomEvent('tema-ui:close-menus', false, false, undefined);
    }
    document.dispatchEvent(event);
  }

  /** Modal de verdad: Tab no se escapa del diálogo. */
  function trapTab(event) {
    if (event.key !== 'Tab' || !ui.dialogOpen || !el.shortcutsOverlay) return;
    var focusables = el.shortcutsOverlay.querySelectorAll(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;

    var first = focusables[0];
    var last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function bindShortcuts() {
    if (el.shortcutsBtn) {
      el.shortcutsBtn.addEventListener('click', function () {
        if (shortcutsOpen()) closeShortcuts();
        else openShortcuts();
      });
    }
    if (el.shortcutsClose) el.shortcutsClose.addEventListener('click', closeShortcuts);

    if (el.shortcutsOverlay) {
      el.shortcutsOverlay.addEventListener('click', function (event) {
        // Sólo el fondo: dentro del panel los clics deben seguir funcionando.
        if (event.target === el.shortcutsOverlay) closeShortcuts();
      });
    }
  }

  /* ======================================================================
     Atajos de teclado
     ====================================================================== */

  /** @returns {boolean} true si el foco está en un campo donde escribir. */
  function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    var tag = target.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  /**
   * @returns {boolean} true si el elemento ya reacciona a Espacio/Intro por
   * su cuenta (botón, enlace…). Si no lo comprobáramos, Espacio dispararía el
   * atajo Y la activación nativa, y se cancelarían entre los dos.
   */
  function isActivator(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"]');
  }

  function onKeyDown(event) {
    // Escape tiene prioridad absoluta: cierra lo que esté abierto, en orden
    // de profundidad, sin importar dónde esté el foco.
    if (event.key === 'Escape') {
      if (ui.dialogOpen) {
        event.preventDefault();
        closeShortcuts();
      }
      return; // los menús ya se cierran solos en sus propios módulos
    }

    // Diálogo abierto: el resto de atajos queda suspendido para que no
    // disparen mientras se lee la ayuda.
    if (ui.dialogOpen) return;

    if (isTyping(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    var key = event.key;
    var player = TemaUI.player;
    var themes = TemaUI.themes;

    switch (key) {
      case ' ':
      case 'Spacebar':
        if (isActivator(event.target)) return; // la activación nativa manda
        event.preventDefault();
        if (player) player.toggle();
        break;

      case 'ArrowLeft':
        event.preventDefault();
        if (player) player.seekBy(-5);
        break;

      case 'ArrowRight':
        event.preventDefault();
        if (player) player.seekBy(5);
        break;

      case 'ArrowUp':
        event.preventDefault();
        if (player) player.setVolume(Math.min(100, player.getState().volume + 5));
        break;

      case 'ArrowDown':
        event.preventDefault();
        if (player) player.setVolume(Math.max(0, player.getState().volume - 5));
        break;

      case 'm':
      case 'M':
        event.preventDefault();
        if (player) player.toggleMute();
        break;

      case 'f':
      case 'F':
        event.preventDefault();
        if (player) player.toggleFullscreen();
        break;

      case 'c':
      case 'C':
        event.preventDefault();
        if (player) player.toggleCaptions();
        break;

      case 't':
      case 'T':
        event.preventDefault();
        if (themes) themes.next();
        break;

      case '/':
        event.preventDefault();
        if (el.search) {
          el.search.focus();
          el.search.select();
        }
        break;

      case '?':
        event.preventDefault();
        if (shortcutsOpen()) closeShortcuts();
        else openShortcuts();
        break;

      default:
        break;
    }
  }

  function bindKeyboard() {
    document.addEventListener('keydown', onKeyDown, false);
    // Va en la fase de captura: el trampa de Tab debe ejecutarse ANTES de que
    // el navegador mueva el foco, no después.
    document.addEventListener('keydown', trapTab, true);
  }

  /* ======================================================================
     Arranque
     ====================================================================== */

  function bindPlayer() {
    var player = TemaUI.player;
    if (!player || typeof player.onChange !== 'function') return;

    player.onChange(function (snapshot) {
      // onChange puede saltar en cada fotograma: sólo actuamos si cambió el
      // episodio, que es lo único que altera las marcas de la lista.
      if (snapshot.id !== ui.markedId) {
        ui.markedId = snapshot.id;
        markCurrentRow(snapshot.id);
      }
    });
  }

  /**
   * Arranca todo. Idempotente: poder llamarla dos veces desde las pruebas sin
   * duplicar listeners.
   */
  function init() {
    cacheDom();

    renderList();
    bindList();
    bindShortcuts();
    bindKeyboard();

    if (TemaUI.themes) TemaUI.themes.init();
    if (TemaUI.player) TemaUI.player.init();

    applyFilter();
    bindPlayer();

    // player.init() no dispara onChange al arrancar, así que el marcador de
    // la fila actual hay que colocarlo a mano una vez.
    if (TemaUI.player) {
      var snapshot = TemaUI.player.getState();
      ui.markedId = snapshot.id;
      markCurrentRow(snapshot.id);
    }
  }

  /**
   * Los scripts van al final del `<body>`, pero por si alguien los sube al
   * `<head>` el arranque sigue siendo correcto en los dos casos.
   */
  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  TemaUI.app = {
    init: init,
    renderList: renderList,
    applyFilter: applyFilter,
    openShortcuts: openShortcuts,
    closeShortcuts: closeShortcuts,
  };

  boot();
})(window);
