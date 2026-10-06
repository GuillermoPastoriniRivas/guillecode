---
name: escritorio
description: Manejar la PC del usuario desde GuilleCode — apps de Windows (herramientas desktop_*) y su Chrome con las sesiones iniciadas (herramientas browser_*). Usala cuando la tarea necesita una app con interfaz gráfica, una web donde el usuario ya inició sesión, o ver la pantalla.
---

# Manejar la PC del usuario

Tenés dos juegos de herramientas:

- `desktop_*`: apps de Windows (Bloc de notas, Explorador de archivos, Excel, instaladores, apps de escritorio).
- `browser_*`: el Chrome real del usuario, con sus sesiones iniciadas (Gmail, Meta Business, consolas web, etc.), conectado mediante Chrome DevTools sin extensión. Preferilas para el contenido web; `desktop_*` es el respaldo para barra, menús y diálogos nativos.

Para archivos, código y comandos seguí usando read, edit y bash: son más rápidos y seguros que manejar la interfaz.

## Antes de empezar

1. `desktop_status`. Si el control está apagado o pausado, decíselo al usuario y pará.
2. Si la sesión está **bloqueada**, solo funcionan las acciones por accesibilidad: `desktop_snapshot`, `desktop_find`, `desktop_wait`, `desktop_click` y `desktop_type` con ref `[eN]`, `desktop_select`, `desktop_read`, `desktop_scroll`, `desktop_close_window` y `desktop_launch`. No uses `press_key`, `click_xy`, `screenshot`, `screen_text` ni `focus_window`.
3. `desktop_windows` para ver qué hay abierto, o `desktop_launch` para abrir la app.

## El ciclo

1. `desktop_snapshot` de la ventana: te da el árbol con refs `[eN]`. En ventanas grandes, o si el snapshot sale recortado, ubicá lo que buscás con `desktop_find` (por texto y/o rol).
2. Actuá por ref con `desktop_click`, `desktop_type` o `desktop_select`. Pasá `element` con una descripción corta: el usuario ve ese texto en el celular.
3. Cada acción devuelve **solo lo que cambió** en la ventana (`+` nuevo, `~` cambió, `-` ya no está), o «sin cambios» si no pasó nada visible. Leelo antes de seguir. Si se abrió un diálogo, aparece como «ventana nueva» con su árbol completo.
4. Una ref sigue valiendo mientras su elemento exista, aunque pidas otros snapshots. Si una acción dice que no conoce la ref, pedí un snapshot nuevo.
5. Si algo tarda (una carga, un instalador, una exportación, un diálogo que no aparece enseguida), usá `desktop_wait` con el texto o la ventana que esperás en vez de pedir snapshots una y otra vez.
6. Para varias acciones seguidas que ya sabés (completar un formulario, elegir opciones y aceptar), usá `desktop_steps`: va todo en una sola llamada.
7. Para leer un documento largo, `desktop_read` con la ref del documento.
8. Para cerrar una ventana usá `desktop_close_window` (no Alt+F4): si pregunta si guardar, el diálogo aparece en el resultado.

## Escribir

- Apps como el Bloc de notas o Word pueden abrirse restaurando documentos del usuario. Antes de escribir, fijate en el título de la ventana que estés en el documento correcto; para uno nuevo, `ctrl+n` o `desktop_launch` con la ruta del archivo.
- `desktop_type` con ref reemplaza el contenido del campo. En un documento que ya tiene texto usá `mode: "append"` para agregar al final, o `mode: "insert"` para escribir donde está el cursor: así no borrás lo que había. Sin mode, la herramienta se niega a pisar un documento con texto.
- Sin ref, `desktop_type` teclea donde está el foco de la ventana. Sirve en apps sin árbol de accesibilidad, después de hacer click en el campo.
- Para pegar un texto largo: `desktop_clipboard` con `write` y después `desktop_press_key` con `ctrl+v`. Para sacar texto que la app no expone: seleccionalo, `ctrl+c` y `desktop_clipboard` con `read`.

## Apps sin árbol de accesibilidad

Canvas, juegos, escritorio remoto, PDFs escaneados o apps que en el snapshot aparecen casi vacías:

1. `desktop_screen_text` de la ventana (con `find` si buscás algo puntual): lee el texto con OCR y da refs `[tN]`.
2. `desktop_click` con esa ref hace clic en el centro de ese texto. Es mucho más preciso que adivinar coordenadas.
3. `desktop_screenshot` para ver cómo quedó o para entender algo visual. Si necesitás ver un detalle chico, pedí otra captura con `region` (zoom sobre la última imagen).
4. `desktop_click_xy` solo como último recurso, con coordenadas de la última captura de esa ventana.

## En el navegador, rápido

Cada vuelta del modelo tarda más que cualquier acción del navegador, y el snapshot completo de una página grande puede pasar los 100.000 tokens. Por eso:

1. Primero `browser_list_pages` para comprobar la conexión y elegir la pestaña por su URL. Todas las acciones de página llevan `pageId`; no asumas que la pestaña seleccionada en otra conversación es la tuya. Para abrir otra usá `browser_new_page`; para navegar, `browser_navigate_page`.
2. `browser_take_snapshot` devuelve los elementos con `uid`. Usá los uid del snapshot más reciente de esa página en `browser_click`, `browser_fill` o `browser_fill_form`. Preferí `verbose: false`.
3. Las acciones no necesitan devolver un snapshot completo: dejá `includeSnapshot: false` salvo que haga falta verificar un cambio. En páginas grandes leé una sección específica con JavaScript.
4. Para leer el texto de una página: `browser_evaluate_script` con `pageId` y `function: "() => (document.querySelector('main') ?? document.body).innerText"`. Devolvé solo lo necesario.
5. Encadená campos con `browser_fill_form` (pageId y elements con uid/value). Para operaciones DOM simples podés usar `browser_evaluate_script`; su función se ejecuta dentro de la página y no recibe un objeto Playwright ni Puppeteer.
6. `browser_take_screenshot` solo si necesitás ver algo visual: una imagen pesa más que el texto.
7. Para barra de direcciones, menús de Chrome y diálogos de Windows usá `desktop_*`. Para una página sin accesibilidad, podés usar OCR del escritorio como respaldo. No cambies al escritorio para eludir un permiso denegado ni una pausa.
8. La conexión necesita Chrome 144+, abierto, con la depuración remota habilitada en `chrome://inspect/#remote-debugging`. Chrome puede pedir permiso en cada nueva conexión: lo acepta el usuario. Si no conecta, explicá qué falta; no inventes que «servidor listo» significa «Chrome conectado».

## Reglas

- No manejes GuilleCode, consolas, administradores de contraseñas ni apps bloqueadas. Si una herramienta dice que algo está bloqueado o pausado, no busques otro camino.
- Antes de algo irreversible (enviar, pagar, borrar, publicar, comprar), confirmá con el usuario usando la herramienta de preguntas, salvo que te lo haya pedido explícitamente.
- No escribas contraseñas ni datos de tarjetas. Si una web o app pide iniciar sesión, pedile al usuario que lo haga.
- Si algo falla dos veces de la misma forma, pará y contale al usuario qué ves.
