# Navegador interno del equipo (Windows)

En Modo equipo, abrir el botón del navegador, ingresar la página y pulsar **Abrir navegador interno**. Se abre una ventana WebView2 propia de GuilleCode, que puede acomodarse junto al chat. El Lead y sus especialistas usan browser_* sobre esas mismas páginas, sin entrada de teclado o mouse del sistema.

Cada chat conserva su perfil WebView2 y su conexión MCP separados del Chrome personal y de otros equipos. Las cuentas de sitios web se inician dentro de este perfil. Mostrar, atrás, adelante y recargar se ofrecen en el chat. browser_new_page abre otra ventana del mismo equipo. Los enlaces que piden otra ventana se mantienen en GuilleCode; flujos que requieren window.opener pueden necesitar adaptación posterior.

Las herramientas respetan los controles de navegador habilitado y pausa. Las páginas remotas no reciben capacidades de Tauri. El puerto de DevTools es dinámico y local; no se cambian preferencias ni perfiles de Chrome. El navegador normal conserva su puente existente.

Validación nativa: WebView2 real con una página local, listado mediante Chrome DevTools MCP fijado, snapshot, clic por UID, lectura del saludo, segunda página, aislamiento entre dos perfiles de equipo y reconexión del puente. Prueba de regresión del adaptador de Chrome y compilación de producción. Esto no acredita autenticación en sitios externos ni todos sus flujos de ventanas emergentes.
