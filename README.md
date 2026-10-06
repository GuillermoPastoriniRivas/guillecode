# GuilleCode

Agente de IA, editor, Git y terminal en una aplicación para Windows x64.

## Cuentas de IA

Cada usuario conecta sus propias cuentas. Se puede usar **solo ChatGPT**, **solo OpenCode Go** o **ambos**. Alcanza con un proveedor conectado con modelos disponibles.

- **ChatGPT:** iniciar sesión desde el navegador o mediante un código de dispositivo. Se usan los modelos y los límites habilitados por la cuenta. No requiere cuenta ni API key de OpenCode.
- **OpenCode Go:** pegar la API key del plan Go desde la consola de OpenCode. GuilleCode consulta la cuota para verificar la clave antes de guardarla; no genera mensajes para validarla.
- **OpenCode Zen (opcional):** usa la misma clave y se activa con el interruptor «Incluir OpenCode Zen» en Cuentas de IA. Suma modelos que se cobran por token, aparte del plan Go; con «Solo modelos gratuitos de Zen» (por defecto) la lista se limita a los que no consumen saldo, y el interruptor se puede apagar para ver todos.
- **Ambos:** elegir el proveedor y modelo desde el selector del chat o desde Cuentas de IA.

OpenCode está incluido como **motor interno**, independientemente del proveedor elegido. El motor y la cuenta de OpenCode Go son cosas distintas.

En el primer inicio sin cuentas se muestra la bienvenida. Al conectar un proveedor se selecciona un modelo disponible y se habilita Continuar. Se puede agregar el otro proveedor después desde **Cuentas de IA**. Al quitar el proveedor activo, el chat pasa a un modelo de la cuenta restante. Si se quita la última cuenta, se vuelve a la bienvenida.

Las cuentas se guardan en el perfil de OpenCode del usuario de Windows (`XDG_DATA_HOME/opencode` o `~/.local/share/opencode`) y se comparten con OpenCode en la terminal. Las cuentas existentes se detectan automáticamente. El instalador no incluye ese perfil ni las credenciales del desarrollador. Las claves no se guardan en el navegador.

La app del celular actualiza los modelos y verifica disponibilidad antes de enviar. Las rutinas verifican su modelo antes de crear una conversación; si se quitó su cuenta, se informa el error para que el usuario elija otro modelo.

## Instalar

Ejecutar el instalador NSIS de Windows x64. Incluye el motor y los recursos de la app del celular. Si falta WebView2, el instalador descarga su bootstrapper; requiere conexión a Internet.

Funciones adicionales:

- Git requiere Git para Windows.
- Pull requests requieren GitHub CLI (`gh`) autenticado.
- Control de Chrome requiere Chrome 144+ y Node.js/npm (Node 20.19+, 22.12+ o posterior compatible). Usa Chrome DevTools MCP con `autoConnect`, sin extensión ni token; el puente instala una versión fija localmente.
- Acceso desde celular requiere Tailscale configurado.
- Transcripción de audio requiere configurar un servicio y su API key; el login de ChatGPT no incluye la API de transcripción.

### Conectar tu Chrome

1. Abrí **Control de la PC** en GuilleCode y activá el control.
2. Pulsá **Abrir configuración de Chrome**, o abrí `chrome://inspect/#remote-debugging` en Chrome, y habilitá la depuración remota.
3. Pulsá **Probar / reconectar** y aceptá **Permitir** en Chrome. Se verifica la conexión leyendo las pestañas; «Chrome DevTools listo» solo indica que el servidor MCP arrancó.

Chrome pide permiso en cada nueva conexión de depuración. La conexión reutiliza las ventanas y sesiones del perfil elegido por Chrome; con varios perfiles, verificá que sea el deseado. El agente usa `browser_*` para el contenido web y `desktop_*` como respaldo para la barra, los menús y los diálogos nativos.

## Desarrollo y distribución

Requisitos de build: Node.js 22.18+ (para ejecutar los tests TypeScript), npm, Rust y las herramientas de compilación de C++ de Windows necesarias para Tauri.

```powershell
npm ci
npm run dev
```

El script `run.ps1` abre la aplicación en modo desarrollo.

Para generar el instalador:

```powershell
npx tauri build
```

Salida: `src-tauri/target/release/bundle/nsis/guillecode_0.2.0_x64-setup.exe`.

Las variables `VITE_OPENCODE_USER`, `VITE_OPENCODE_PASSWORD`, `VITE_PROJECT` y `VITE_OPENCODE_MODEL` solo se usan en desarrollo. El build incluye un control que falla si una credencial `VITE_*PASSWORD`, `*TOKEN`, `*SECRET` o `*API_KEY` termina en el JavaScript de distribución.

## Verificación

```powershell
npm test
npm run test:e2e
npm run test:engine
cargo test --manifest-path src-tauri/Cargo.toml --release --lib accounts::tests
npm run lint
```

Los tests E2E usan Microsoft Edge con cuentas y llamadas IPC simuladas, sin modificar cuentas reales. El smoke test ejecuta el OpenCode incluido con un perfil temporal vacío y comprueba que el login de ChatGPT está disponible sin cuenta OpenCode. No consume tokens.

Para comprobar el MCP del navegador instalado por GuilleCode, ejecutá `node tests/browser-smoke.mjs`. Con Chrome abierto y la depuración habilitada, `node tests/browser-smoke.mjs --live` también comprueba snapshot, formulario, clic y lectura en una pestaña local de prueba, que cierra al terminar. Puede pedir permiso en Chrome.

El build del instalador no reemplaza la prueba de instalación, actualización y desinstalación en una máquina Windows limpia. Firma y actualizaciones automáticas requieren su configuración de distribución.
