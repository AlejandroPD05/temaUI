/**
 * Motor de temas — el módulo que da nombre al proyecto (tema-ui).
 *
 * Principio rector: `data-theme` en `<html>` es la ÚNICA fuente de verdad.
 * Aquí no se inyecta ni un `<style>` ni un color en línea: sólo se cambia ese
 * atributo (los tokens viven en `css/themes.css`), se persiste la elección,
 * se anima el cambio y se mantiene sincronizada la UI del selector.
 *
 * IIFE clásica que publica en `window.TemaUI`, sin `import`/`export`: la demo
 * se abre con doble clic (file://) y los módulos ES quedarían bloqueados por
 * la política CORS. Orden de carga: data.js → themes.js → player.js → app.js.
 */
(function (global) {
  'use strict';

  var TemaUI = (global.TemaUI = global.TemaUI || {});

  /* --- Constantes -------------------------------------------------------- */

  /**
   * Clave de persistencia. DEBE coincidir con la que lee el script en línea
   * del `<head>`: si difiriera, quien llega con un tema guardado vería primero
   * el claro (parpadeo) hasta que este script lo corrigiera.
   */
  var STORAGE_KEY = 'tema-ui:theme';

  /**
   * Marca de elección manual (valor `'1'`). Es lo que separa "respeta el
   * sistema" de "sobrescribe la elección del usuario": sin la marca, cualquier
   * cambio de `prefers-color-scheme` se aplica solo; con ella, el sistema ya
   * no manda.
   */
  var MANUAL_KEY = 'tema-ui:manual';

  /**
   * Evento de coordinación entre menús. Sin él, abrir el selector de temas
   * dejaba el menú de ajustes del reproductor encima, y viceversa: dos menús
   * flotantes abiertos a la vez rompen el patrón menú-botón (el `Escape`
   * ya no sabe cuál cerrar). Es el mismo nombre que usa player.js.
   */
  var CLOSE_MENUS_EVENT = 'tema-ui:close-menus';

  /** Mismos fallbacks que el script del `<head>`, para que cuadren siempre. */
  var DEFAULT_LIGHT = 'claro';
  var DEFAULT_DARK = 'medianoche';

  /**
   * Los cinco temas, en el orden exacto del menú (y el mismo orden en que los
   * lista el script del `<head>`).
   *
   * - `mode`: claro/oscuro del tema; equivale al `color-scheme` de themes.css
   *   y es lo que nos deja comparar tema actual y preferencia del sistema.
   * - `short`: etiqueta para cuando el layout no deja sitio al nombre completo
   *   (botón estrecho, aviso del atajo T…). El botón usa `name`.
   */
  var THEMES = [
    { id: 'claro', name: 'Claro', mode: 'light', short: 'Claro' },
    { id: 'verde-oscuro', name: 'Verde oscuro', mode: 'dark', short: 'Verde' },
    { id: 'medianoche', name: 'Medianoche', mode: 'dark', short: 'Medianoche' },
    { id: 'arena', name: 'Arena', mode: 'light', short: 'Arena' },
    { id: 'alto-contraste', name: 'Alto contraste', mode: 'dark', short: 'Contraste' },
  ];

  /* --- Estado ------------------------------------------------------------ */

  /** Suscriptores de `onChange`. */
  var listeners = [];
  /** `init()` enlaza una sola vez, por si app.js lo llama dos veces. */
  var initialized = false;
  /** El listener de `prefers-color-scheme` también es de una sola pieza. */
  var systemBound = false;

  /* --- Utilidades -------------------------------------------------------- */

  /** `localStorage` lanza en modo privado: jamás debe caerse la app. */
  function storageGet(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      global.localStorage.setItem(key, value);
    } catch (err) {
      /* Sin almacenamiento sólo perdemos la recordatoriedad, no la app. */
    }
  }

  /**
   * @param {string} id
   * @returns {number} índice en THEMES o -1.
   */
  function indexOfId(id) {
    for (var i = 0; i < THEMES.length; i += 1) {
      if (THEMES[i].id === id) return i;
    }
    return -1;
  }

  /**
   * @param {string} id
   * @returns {Object|null}
   */
  function findTheme(id) {
    var index = indexOfId(id);
    return index === -1 ? null : THEMES[index];
  }

  /** ¿El usuario ha elegido tema a mano alguna vez? */
  function isManual() {
    return storageGet(MANUAL_KEY) === '1';
  }

  /* --- Congelado de la paleta durante la captura ------------------------- */

  /**
   * Clase que apaga los `transition` de color de la paleta en `layout.css`.
   *
   * Hace falta porque View Transitions captura el estado nuevo AL SIGUIENTE
   * FOTOGRAMA de la callback. Si en ese instante la paleta está todavía
   * interpolando (260 ms), el snapshot "nuevo" se pinta con los colores
   * VIEJOS: el fundido compara un snapshot con otro idéntico, no se ve nada
   * durante 260 ms y, cuando el snapshot desaparece, el color nuevo aparece
   * de golpe. Medido en el navegador original: `body` seguía en
   * `rgb(245,246,248)` —el blanco viejo— a los 25 ms de aplicar el tema.
   *
   * Con la clase puesta, la paleta salta dentro de la callback, el snapshot
   * nuevo ya lleva los colores finales y el fundido viejo→nuevo sí se ve.
   *
   * `vtDepth` es un contador, no un booleano: lanzar una segunda View
   * Transition aborta a la primera, que entonces rechaza. Si al rechazar
   * soltáramos la clase, la segunda capturaría con los colores a medio
   * camino. Sólo al llegar a 0 se restaura.
   */
  var VT_PALETTE_CLASS = 'theme-vt';
  var vtDepth = 0;

  function lockPalette() {
    vtDepth += 1;
    document.documentElement.classList.add(VT_PALETTE_CLASS);
  }

  function unlockPalette() {
    vtDepth = Math.max(0, vtDepth - 1);
    if (vtDepth === 0) document.documentElement.classList.remove(VT_PALETTE_CLASS);
  }

  /**
   * Transición de cambio sin parpadeo.
   *
   * `startViewTransition` captura la interfaz antes/después y funde la paleta
   * con la duración que `base.css` ya declara para `::view-transition-old/new`
   * (`--t-med`). Si el navegador no lo tiene, si el usuario pide movimiento
   * reducido o si la transición lanza, se aplica el cambio directamente y el
   * fundido lo hacen los `transition` de `layout.css`: el tema TIENE que
   * cambiarse pase lo que pase, pero nunca dejando la paleta congelada.
   *
   * El guard `applied` evita una doble mutación por si una implementación
   * rota lanzara DESPUÉS de invocarnos (setAttribute es idempotente, pero
   * notificar a los suscriptores dos veces no lo es).
   *
   * @param {Function} mutate
   */
  function withTransition(mutate) {
    var applied = false;
    function apply() {
      if (applied) return;
      applied = true;
      mutate();
    }

    var reduce =
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!document.startViewTransition || reduce) {
      apply();
      return;
    }

    lockPalette();

    var released = false;
    function unlock() {
      if (released) return;
      released = true;
      unlockPalette();
    }

    try {
      var transition = document.startViewTransition(apply);

      // Un rechazo (p. ej. otra transición en curso) no debe dejar un error
      // sin capturar en consola, NI la paleta bloqueada: la mutación ya se
      // habrá ejecutado y hay que soltarla también cuando se aborta.
      if (transition && transition.finished && typeof transition.finished.then === 'function') {
        transition.finished.then(unlock, unlock);
      } else if (transition && typeof transition.catch === 'function') {
        transition.catch(unlock);
      }

      // Red de seguridad: si `finished` nunca se resuelve, la paleta no puede
      // quedarse bloqueada —el siguiente cambio se vería instantáneo incluso
      // donde tocaría animar—. Diez veces la duración declarada en CSS.
      global.setTimeout(unlock, 2600);
    } catch (err) {
      unlock();
      apply();
    }
  }

  /* --- Sincronía de la UI ------------------------------------------------ */

  /**
   * Lee el `--bg` YA computado del tema recién aplicado. Se llama dentro de la
   * mutación de la transición a propósito: con `startViewTransition` el
   * callback va diferido a fotogramas, y si leyéramos fuera nos quedaríamos
   * con el color del tema anterior en `#metaThemeColor`.
   */
  function updateMetaThemeColor() {
    var meta = document.getElementById('metaThemeColor');
    if (!meta || !global.getComputedStyle) return;
    try {
      var bg = global.getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    } catch (err) {
      /* Estilo no calculable aún: se deja el content anterior. */
    }
  }

  /**
   * Pinta el estado del tema activo en el selector. Todos los elementos se
   * comprueban: el menú puede no existir en una variante de la maqueta.
   *
   * @param {Object|null} theme
   */
  function syncUI(theme) {
    if (!theme) return;

    var label = document.getElementById('themeBtnLabel');
    if (label) label.textContent = theme.name;

    var swatch = document.getElementById('themeBtnSwatch');
    if (swatch) swatch.setAttribute('data-swatch', theme.id);

    var options = document.querySelectorAll('.theme-option');
    for (var i = 0; i < options.length; i += 1) {
      var isActive = options[i].getAttribute('data-theme-id') === theme.id;
      options[i].setAttribute('aria-checked', isActive ? 'true' : 'false');
    }

    updateMetaThemeColor();
  }

  /**
   * Avisa a los suscriptores con `{ id, theme }`. Un suscriptor defectuoso
   * no debe tumbar el cambio de los demás.
   *
   * @param {Object} theme
   */
  function notify(theme) {
    var payload = { id: theme.id, theme: theme };
    // Copia: alguien puede darse de baja dentro de su propio callback.
    var current = listeners.slice();
    for (var i = 0; i < current.length; i += 1) {
      try {
        current[i](payload);
      } catch (err) {
        if (global.console && global.console.warn) {
          global.console.warn('[tema-ui] Falló un suscriptor de onChange:', err);
        }
      }
    }
  }

  /* --- API --------------------------------------------------------------- */

  /**
   * Id del tema activo, leído de la fuente de verdad (`data-theme`).
   * Si falta o apunta a un tema inexistente, `claro`.
   *
   * @returns {string}
   */
  function get() {
    var id = document.documentElement.getAttribute('data-theme');
    return findTheme(id) ? id : DEFAULT_LIGHT;
  }

  /**
   * Aplica un tema: valida, transiciona, persiste y notifica.
   *
   * @param {string} id
   * @param {Object} [opts]
   * @param {boolean} [opts.silent] No notifica a `onChange` (el tema sí cambia).
   * @param {boolean} [opts.system] Viene del cambio de preferencia del SO:
   *                                no marca la elección como manual.
   * @returns {boolean} true si el tema existía y algo cambió.
   */
  function set(id, opts) {
    opts = opts || {};

    var theme = findTheme(id);
    if (!theme) return false; // id desconocido: se ignora en silencio.

    var root = document.documentElement;
    if (root.getAttribute('data-theme') === theme.id) return false; // ya activo: nada de transición inútil.

    withTransition(function () {
      root.setAttribute('data-theme', theme.id); // única fuente de verdad
      syncUI(theme);
      if (!opts.silent) notify(theme);
    });

    // Se persiste ya, aunque la transición vaya diferida: si la pestaña se
    // cierra en el fotograma intermedio no perdemos la elección.
    storageSet(STORAGE_KEY, theme.id);

    // Marca de elección manual: a partir de aquí el sistema deja de mandar.
    // `{ system: true }` la omite a propósito (la aplica el propio motor).
    if (!opts.system) storageSet(MANUAL_KEY, '1');

    return true;
  }

  /**
   * Cicla al siguiente tema de la lista, en bucle. Lo usa el atajo `T` de
   * app.js: como es una acción del usuario, cuenta como elección manual.
   *
   * @returns {string} id aplicado.
   */
  function next() {
    var index = indexOfId(get());
    var target = THEMES[(index + 1) % THEMES.length];
    set(target.id);
    return target.id;
  }

  /**
   * Registra un callback y devuelve la función de baja.
   *
   * @param {Function} callback recibe `{ id, theme }`.
   * @returns {Function} unsubscribe
   */
  function onChange(callback) {
    if (typeof callback !== 'function') return function () {};
    listeners.push(callback);
    return function unsubscribe() {
      var index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    };
  }

  /**
   * Sigue `prefers-color-scheme` SIN pisar al usuario.
   *
   * Esta es la distinción que separa "respeta el sistema" de "sobrescribe la
   * elección del usuario": sólo actuamos si nunca se ha pulsado una opción
   * (no existe la marca `tema-ui:manual`). Si el usuario ya eligió a mano,
   * su elección gana aunque cambie el sistema.
   */
  function bindSystemPreference() {
    if (systemBound || !global.matchMedia) return;

    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    if (!mq) return;

    function onSchemeChange() {
      if (isManual()) return; // elección manual → el sistema no manda.

      var target = findTheme(mq.matches ? DEFAULT_DARK : DEFAULT_LIGHT);
      var current = findTheme(get());
      if (!target || !current) return;

      // Si el modo ya coincide no damos un salto inútil (p. ej. el SO pasa a
      // oscuro y el usuario está en verde-oscuro, que ya es oscuro).
      if (current.mode === target.mode) return;

      set(target.id, { system: true });
    }

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onSchemeChange);
      systemBound = true;
    } else if (typeof mq.addListener === 'function') {
      // Safari antiguo.
      mq.addListener(onSchemeChange);
      systemBound = true;
    }
  }

  /**
   * Enlaza el selector. Es idempotente y defensivo: si falta `#themeToggle`
   * o `#themeMenu`, sincroniza la UI y sale limpio sin lanzar.
   */
  function init() {
    // El tema ya lo aplicó el `<head>`; aquí sólo ponemos la UI al día
    // (init puede llegar DESPUÉS de que la página se haya pintado).
    syncUI(findTheme(get()));

    bindSystemPreference();

    if (initialized) return;
    initialized = true;

    var toggle = document.getElementById('themeToggle');
    var menu = document.getElementById('themeMenu');
    var picker = document.querySelector('.theme-picker');

    // Maqueta incompleta: no enlazamos nada (initialized queda false para que
    // un init posterior, con el DOM ya montado, pueda reintentarlo).
    if (!toggle || !menu) {
      initialized = false;
      return;
    }

    // Estado inicial coherente con el HTML (el menú arranca oculto).
    toggle.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');

    var options = menu.querySelectorAll('.theme-option');

    /* -- Menú ---------------------------------------------------------- */

    function isOpen() {
      return !menu.hidden;
    }

    function focusOption(index) {
      var list = Array.prototype.slice.call(options);
      if (!list.length) return;
      var target = list[((index % list.length) + list.length) % list.length]; // da la vuelta
      if (target) target.focus();
    }

    function moveFocus(delta) {
      var list = Array.prototype.slice.call(options);
      if (!list.length) return;
      var index = list.indexOf(document.activeElement);
      // Si el foco está fuera del menú se entra por el extremo lógico.
      if (index === -1) index = delta > 0 ? -1 : list.length;
      focusOption(index + delta);
    }

    /**
     * Avisa a los demás menús (el de ajustes, en player.js) de que nos abrimos.
     *
     * El orden importa: se despacha mientras seguimos OCULTOS, porque nuestro
     * propio listener corre en este mismo tick y cerraría el menú que acabamos
     * de abrir. Es el mismo truco que openSettings() en player.js.
     */
    function notifyCloseMenus() {
      var event;
      if (typeof global.CustomEvent === 'function') {
        event = new global.CustomEvent(CLOSE_MENUS_EVENT);
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent(CLOSE_MENUS_EVENT, false, false, undefined);
      }
      document.dispatchEvent(event);
    }

    function openMenu() {
      notifyCloseMenus();
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      // El foco entra en el menú (patrón menú-button): primero el tema activo.
      var active = menu.querySelector('.theme-option[aria-checked="true"]');
      var list = Array.prototype.slice.call(options);
      var target = active || list[0];
      if (target && typeof target.focus === 'function') target.focus();
    }

    function closeMenu(restoreFocus) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus && typeof toggle.focus === 'function') toggle.focus();
    }

    /* -- Enlaces -------------------------------------------------------- */

    toggle.addEventListener('click', function () {
      if (isOpen()) closeMenu(false); // el foco ya está en el botón al pulsarlo
      else openMenu();
    });

    function onOptionClick(event) {
      // Sin opts: un clic del usuario cuenta como elección manual.
      set(event.currentTarget.getAttribute('data-theme-id'));
      closeMenu(true); // el menú se cierra devolviendo el foco al botón
    }

    for (var i = 0; i < options.length; i += 1) {
      options[i].addEventListener('click', onOptionClick);
    }

    // Clic fuera: se comprueba contra el picker, no contra el menú, para que
    // pulsar el propio botón no cuente como "fuera".
    if (picker) {
      document.addEventListener('click', function (event) {
        if (!isOpen()) return;
        if (picker.contains(event.target)) return;
        // Sólo devolvemos el foco si seguía dentro del menú; si el usuario ha
        // pulsado otro control, ese control es el que debe quedárselo.
        closeMenu(menu.contains(document.activeElement));
      });
    }

    // Escape cierra y devuelve el foco. Va en `document` para cubrir también
    // el caso de quien sale del menú con Tab. Sin stopPropagation: estaríamos
    // en el propio `document` y no impediría los demás listeners de app.js.
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !isOpen()) return;
      closeMenu(true);
    });

    // Otro menú (el de ajustes) se abre: nos cerramos sin devolver el foco,
    // porque el foco acaba de pasar a ese otro control y arrancarlo de nuevo
    // dejaría el cursor parpadeando en el botón de temas.
    document.addEventListener(CLOSE_MENUS_EVENT, function () {
      if (isOpen()) closeMenu(false);
    });

    // Recorrido con flechas. Se PARA la propagación aquí sí: en `document`,
    // app.js usa ↑/↓ para el volumen y Home/End no deberían mover la página.
    // Tab no se toca, para que salga del menú con el foco normal.
    menu.addEventListener('keydown', function (event) {
      var key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        moveFocus(key === 'ArrowDown' ? 1 : -1);
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        event.stopPropagation();
        focusOption(key === 'Home' ? 0 : options.length - 1);
      }
    });
  }

  TemaUI.themes = {
    THEMES: THEMES,
    init: init,
    get: get,
    set: set,
    next: next,
    onChange: onChange,
  };
})(window);
