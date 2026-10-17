# Actualizaciones conservando Equipos IA

Esta rama, `codex/equipos-ia`, contiene la edición local de GuilleCode. El código de Equipos IA está guardado en el commit `976740f`; el merge `cebdccd` incorpora la base 0.14.0 publicada por `GuillermoPastoriniRivas/guillecode`.

El instalador público reemplaza ejecutables y recursos. No combina código ni conserva funcionalidades que solo existen en esta rama. Los datos del usuario son un asunto distinto: equipos/chats se guardan en `teams.sqlite` bajo el perfil de Tauri, y las cuentas/sesiones del motor en su perfil OpenCode. Conservar esos archivos no hace que una versión pública incluya Equipos IA.

## Protección de esta edición

La ventana Actualizaciones sigue consultando versiones y notas de la publicación original. La edición de escritorio `com.guillecode.desktop` muestra **Edición local · Equipos IA** y no ofrece descargar/instalar directamente ese paquete. Los comandos nativos también lo rechazan, incluso si se invocan fuera de la interfaz. Los instaladores de pruebas usan identificadores y perfiles separados y conservan su flujo de actualización para probar NSIS/firma.

Para actualizar esta edición se integra el código nuevo, se verifican ambas funcionalidades y se genera un instalador combinado. El nombre, identificador y perfil de la app se mantienen; no se reemplazan `teams.sqlite`, cuentas ni conversaciones con datos vacíos. El instalador local no se publica ni se firma como una release oficial.

## Próximas actualizaciones

1. Guardar los cambios locales en commits antes de integrar otra versión. No usar reset/clean para resolver conflictos ni instalar encima el binario público.
2. Consultar la versión publicada y traer su tag/commit desde el mismo repositorio que usa el updater. `origin` apunta a `Kaitach/guillecode`; la publicación configurada apunta a `GuillermoPastoriniRivas/guillecode` y puede adelantarse a ese espejo.
3. Integrar la release en `codex/equipos-ia` mediante Git y resolver conflictos conservando los contratos de equipos y las mejoras entrantes.
4. Ejecutar las suites JS, UI y Rust, la integración de equipos y los checks afectados. No confundir un merge sin conflictos con una prueba de funcionamiento.
5. Con la app y el motor detenidos, generar el instalador combinado. Tauri copia el sidecar durante el build; el motor abierto desde `target/release` puede bloquear esa copia en Windows.
6. Respaldar perfiles con la API de backup de SQLite, no copiando una base activa sin su journal. Guardar también configuración, credenciales locales y evidencias; mantener el backup privado y fuera del repositorio.
7. Instalar el paquete combinado por usuario y verificar versión, motor, Equipos IA, plantilla/chat existentes y protección del updater.

No hay un servicio automático de Git/compilación dentro de la app. El botón no promete fusionar cambios locales. Para recuperar la actualización normal de un clic haría falta un canal propio de releases que publique esta edición combinada, con su firma y pruebas; no se creó ni publicó ese canal como parte de este cambio.

## Respaldo de esta actualización

Antes de pasar de 0.13.2 a 0.14.0 se respaldaron el perfil de la aplicación y OpenCode en:

`C:\Users\franc\AppData\Local\GuilleCode\backups\pre-0.14.0-20261017-192955`

Incluye bases SQLite consistentes, configuración, credenciales locales y un manifest con conteos. Se verificó la presencia de un equipo, un chat y los tres flujos de captura de la plantilla. No se subió ese backup a Git ni a servicios externos.
