# Compatibilidad del motor y preservación de chats

Flufy 0.17.1 fija OpenCode 1.19.5. Se conserva la línea 1.x porque Flufy aún consume su API y SDK; OpenCode 2.x tiene una API de servidor distinta.

## Base creada por OpenCode 2.x

OpenCode 2.x usa `workspace` con las columnas `provider` y `binding`, y quita columnas y tablas que consulta el motor 1.x. Antes de iniciar el motor incluido, Flufy comprueba la forma de esa tabla. Solo cuando detecta ese esquema 2.x, restaura dentro de una única transacción las columnas 1.x faltantes de `workspace` (`type`, `name`, `branch`, `directory`, `extra`, `project_id`, `time_used`), las tablas auxiliares ausentes (`data_migration`, `session_context_epoch`, `session_input`) y los tres índices requeridos en `session_input`.

1. Crea junto a `opencode.db` una copia consistente con la Online Backup API de SQLite. Esa copia incorpora transacciones que sigan en WAL y se conserva con nombre `opencode.db.flufy-pre-migration-<id>.sqlite`.
2. Abre una transacción SQLite inmediata y aplica únicamente los cambios de esquema ausentes. Las columnas con restricciones `NOT NULL` usan valores por defecto conservadores, de modo que todas las filas existentes quedan válidas sin reescritura.
3. Confirma la transacción antes de iniciar OpenCode 1.19.5.

La migración no borra, reescribe ni convierte filas existentes. Las tres tablas nuevas empiezan vacías; las claves foráneas apuntan a `session` para las funciones nuevas de OpenCode. Si no se puede crear la copia previa o completar la transacción, Flufy revierte los cambios de esquema y no inicia el motor. En ese caso, el error incluye la ubicación de la copia previa si llegó a crearse. La primera ejecución puede necesitar espacio libre cercano al tamaño de `opencode.db` para guardar la copia.

Los inicios posteriores detectan la columna existente y no vuelven a copiar la base. La migración no lee ni modifica `auth.json`; las credenciales permanecen en el perfil local actual.

## Referencias upstream

- OpenCode 1.19.5: <https://github.com/anomalyco/opencode/releases/tag/v1.19.5>
- Cambio de esquema y error de compatibilidad `project_id`: <https://github.com/anomalyco/opencode/issues/55555>
- Esquemas V1 de [workspace](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/control-plane/workspace.sql.ts), [sesión e índices](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/session/sql.ts) y [data_migration](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/core/src/data-migration.sql.ts).
- API v2 y transición desde v1: <https://dev.opencode.ai/v2/docs/migrate-v1/>
