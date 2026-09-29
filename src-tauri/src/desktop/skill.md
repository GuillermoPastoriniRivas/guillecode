---
name: escritorio
description: Manejar la PC del usuario desde GuilleCode — apps de Windows (herramientas desktop_*) y su Chrome con las sesiones iniciadas (herramientas browser_*). Usala cuando la tarea necesita una app con interfaz gráfica, una web donde el usuario ya inició sesión, o ver la pantalla.
---

# Manejar la PC del usuario

Tenés dos juegos de herramientas:

- `desktop_*`: apps de Windows (Bloc de notas, Explorador de archivos, Excel, instaladores, apps de escritorio).
- `browser_*`: el Chrome real del usuario, con sus sesiones iniciadas (Gmail, Meta Business, consolas web, etc.). Para cualquier cosa web usá estas, no `desktop_*`.

Para archivos, código y comandos seguí usando read, edit y bash: son más rápidos y seguros que manejar la interfaz.

## Antes de empezar

1. `desktop_status`. Si el control está apagado o pausado, decíselo al usuario y pará.
2. Si la sesión está **bloqueada**, solo funcionan las acciones por accesibilidad: `desktop_snapshot`, `desktop_click`, `desktop_type`, `desktop_select`, `desktop_read`, `desktop_scroll`, `desktop_close_window` y `desktop_launch`. No uses `press_key`, `click_xy`, `screenshot` ni `focus_window`.
3. `desktop_windows` para ver qué hay abierto, o `desktop_launch` para abrir la app.

## El ciclo

1. `desktop_snapshot` de la ventana: te da el árbol con refs `[eN]`.
2. Actuá por ref con `desktop_click`, `desktop_type` o `desktop_select`. Pasá `element` con una descripción corta: el usuario ve ese texto en el celular.
3. Cada acción devuelve el snapshot actualizado: leelo antes de seguir. Si se abrió un diálogo, aparece como «ventana nueva».
4. Las refs cambian en cada snapshot: usá siempre las del último.
5. Para leer un documento largo, `desktop_read` con la ref del documento.
6. Para cerrar una ventana usá `desktop_close_window` (no Alt+F4): si pregunta si guardar, el diálogo aparece en el resultado.

## Cuándo usar la imagen

- `desktop_screenshot` para verificar cómo quedó algo o cuando el árbol no muestra lo que necesitás (canvas, juegos, escritorio remoto, imágenes).
- `desktop_click_xy` solo si el elemento no aparece en el snapshot: capturá esa ventana y usá coordenadas de esa imagen.

## Reglas

- No manejes GuilleCode, consolas, administradores de contraseñas ni apps bloqueadas. Si una herramienta dice que algo está bloqueado o pausado, no busques otro camino.
- Antes de algo irreversible (enviar, pagar, borrar, publicar, comprar), confirmá con el usuario usando la herramienta de preguntas, salvo que te lo haya pedido explícitamente.
- No escribas contraseñas ni datos de tarjetas. Si una web o app pide iniciar sesión, pedile al usuario que lo haga.
- Si algo falla dos veces de la misma forma, pará y contale al usuario qué ves.
