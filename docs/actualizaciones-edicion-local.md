# Actualizaciones conservando Equipos IA

Desde 0.14.1 esta edición usa su propio canal firmado en `Kaitach/guillecode`. El botón Actualizaciones consulta `https://github.com/Kaitach/guillecode/releases/latest/download/latest.json` y verifica la firma antes de instalar. El identificador sigue siendo `com.guillecode.desktop`, por lo que se conservan el perfil, equipos, conversaciones y cuentas existentes.

Un instalador reemplaza ejecutables y recursos; no fusiona código. Para incorporar novedades de `GuillermoPastoriniRivas/guillecode`, primero integramos su código con nuestras mejoras y después publicamos otra versión de nuestro canal. Instalar directamente el paquete del upstream puede quitar las funciones propias, aunque los datos sigan en disco. Los comandos nativos rechazan esa instalación cuando una compilación de esta edición apunta al endpoint del upstream.

## Preparar una nueva versión

1. Guardar cambios en commits y traer el código nuevo desde `publisher` (upstream). `origin` es nuestro repositorio `Kaitach/guillecode`. Resolver conflictos sin descartar cambios locales.
2. Integrar las novedades en la rama propia, conservando Equipos IA, contratos, perfiles y endpoint/clave de nuestro canal.
3. Incrementar versión con `node scripts/release.mjs version X.Y.Z`. Ejecutar JS, UI, Rust, integración nativa y recuperación. Probar la actualización real con instaladores aislados y perfiles descartables.
4. Compilar y firmar con nuestra clave privada de updater. La clave y su contraseña se guardan fuera del repositorio; en Actions se usan los secretos `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Nunca se copian claves del upstream ni se regeneran para una actualización normal.
5. Generar `latest.json`, `release-info.json` y el ZIP de skills. Preparar un borrador con esos archivos, el instalador y su firma. Verificar producto, versión, commit y SHA256 antes de promoverlo a estable.
6. Respaldar SQLite con su API de backup, más configuración y evidencias. Mantener respaldos privados y fuera de Git. Detener la app antes de reemplazarla; el updater bloquea la instalación si hay equipos o sesiones pendientes.
7. Instalar y verificar relanzamiento, motor, datos previos y skills. Solo después publicar el borrador estable. `release:publish -- X.Y.Z --tested` comprueba los artefactos antes de promoverlo.

Las instrucciones llamadas skills no otorgan permisos ni hacen una copia de seguridad. El catálogo puede actualizar plantillas compatibles, pero conserva skills personalizadas y snapshots de chats anteriores. Una plantilla nueva o modificada se aplica a chats nuevos.

## Respaldos locales de esta PC

- Antes de 0.14.0: `C:\Users\franc\AppData\Local\GuilleCode\backups\pre-0.14.0-20261017-192955`. Incluye perfil de app, bases consistentes, configuración, credenciales del motor y binarios 0.13.2.
- Antes de 0.14.1: `C:\Users\franc\AppData\Local\GuilleCode\backups\pre-0.14.1-20261017-195628`. Incluye los dos perfiles de app visibles desde Codex, configuración y evidencias presentes. El motor no recibió cambios de formato en esta actualización.

Los respaldos y claves permanecen en esta PC. No forman parte de la release ni del ZIP de skills.

## Historial

`976740f` incorpora Equipos IA; `cebdccd` integra la base upstream 0.14.0. `codex/equipos-ia-pre-0.14.0` conserva el estado previo. La 0.14.0 local bloqueaba por completo descargar/instalar desde el updater porque todavía no existía el canal propio. La 0.14.1 habilita nuestro endpoint firmado y mantiene la protección frente al endpoint original.

La 0.14.2 simplifica Equipos IA como conversación, agrega el equipo predeterminado Lead/QA/Backend/Frontend y recupera automáticamente planes vacíos o inválidos. La validación actual se registra en [validacion-0.14.2.md](validacion-0.14.2.md). Las pruebas controladas no sustituyen el QA manual del usuario.
