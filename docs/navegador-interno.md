# Navegador del chat (Flufy, Windows)

Cada chat de equipo tiene una pestaña Navegador. Las páginas se dibujan dentro del panel del chat; no crean ventanas de escritorio. Desde la conversación, el botón Navegador abre esa vista ampliada. La barra de dirección y los controles están arriba de la página; el compositor de mensajes se retira mientras se usa el navegador. Se puede escribir una dirección, retroceder, recargar o elegir la página de un agente.

Cada sesión de agente recibe sus propias páginas al usar browser_list_pages. browser_new_page crea otra página del mismo agente. El puente autentica su pertenencia mediante una URL temporal aleatoria antes de navegar; las llamadas posteriores no pueden leer, navegar ni cerrar páginas de otros agentes. El perfil WebView2 se comparte entre los integrantes del chat para sus cuentas web, y está separado de los otros chats y del navegador personal. Los equipos automáticos nuevos permiten hasta diez especialistas.

Se usa Tauri 2 con su función unstable para alojar WebView2 hijos. Las vistas de segundo plano permanecen operativas fuera del área visible del cliente: ocultar nativamente WebView2 impedía interactuar con los elementos. Mostrar una página modifica solo su posición y tamaño; las demás siguen trabajando sin entrada de mouse o teclado del sistema. Una generación de presentación impide que una respuesta tardía vuelva a mostrar el chat anterior. Los diálogos de la app retiran temporalmente la vista web.

Las páginas remotas no reciben capacidades IPC de Tauri. Se conserva el control de navegador habilitado/pausa, los puertos DevTools locales y dinámicos, la validación http/https y la asignación de sesiones nativa. Los perfiles, cuentas e historial existentes se conservan.

Prueba nativa real: diez vistas WebView2 hijas de una sola ventana, diez sesiones del puente MCP, clic y lectura de resultados por página, rechazo de navegación cruzada, cambio de vista, retirada de la vista y reconexión. Pruebas UI con estado controlado: conversación breve con respuesta completa plegada; navegador dentro del chat y retirada al volver a conversar. Los flujos externos de autenticación que requieren window.opener necesitan verificación por sitio.

Repositorio principal y próximos PR: https://github.com/fluws-labs/flufy (main). La versión 0.15.2 y el origen de actualizaciones proceden de esa base. El remoto anterior se conserva únicamente como referencia histórica.

Los comandos IPC y la administración de ventanas usan Window para mantener terminales, observadores de archivos, enfoque y bandeja operativos después de agregar vistas hijas; WebviewWindow deja de representar al host cuando contiene varias vistas.
