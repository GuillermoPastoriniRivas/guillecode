# Skills de Equipos IA

La 0.14.1 incorpora las trece skills del documento proporcionado, adaptadas al contrato real del runner. Están en `.opencode/skills/<nombre>/SKILL.md` y se incluyen en el ejecutable: no se depende de archivos del repositorio para que funcionen en la app instalada.

| Perfil | Skills principales | Guardas concretas |
| --- | --- | --- |
| Lead | Team Lead, Comportamientos | Delegación real, DAG, bloqueos, evidencias y QA manual separado |
| Frontend | Frontend, Security | Teclado/foco, estados de UI, respuestas obsoletas, validación del servidor, capturas |
| Backend | Backend, Security | Autorización por recurso, entradas, duplicados/constraints/transacciones, timeouts |
| Full Stack | Frontend, Backend, Security | Contratos completos entre UI y servidor |
| GraphQL | GraphQL, Backend | Operaciones reales, nullability, autorización, paginación y N+1 |
| QA | QA, Comportamientos | Casos críticos/negativos, passed/failed/blocked/not_run |
| Code Review | Code Review, Security | Hallazgos confirmados y veredicto tipado; quita edit/write/apply_patch |
| Database | Database, Security | Integridad, migraciones compatibles, concurrencia y datos previos |
| AWS | AWS, Security | Mínimo privilegio, planes y despliegues observados/autorizados |
| DevOps | DevOps, Docker | Pipelines, artefactos y rollback reales |
| Docker | Docker | Build, redes, volúmenes, health checks y secretos |
| Git Integration | Git Integration | Ownership, locks, cambios previos y conflictos sin sobrescrituras |

El identificador interno `review` se conserva por compatibilidad; su archivo OpenCode es `code-reviewer/SKILL.md`. Las skills incluidas usan versión 3 y aclaran que las comprobaciones del encargo son responsabilidad del equipo y el QA manual personal es opcional. Se agregan sobre versiones 2 oficiales reconocidas por su huella exacta, sin cambiar selecciones ni snapshots anteriores. El catálogo inicial simplificado se conserva como versión 1 en las bases que ya lo tenían. Si el usuario editó una skill, su versión se conserva y no se tapa con otra incluida. Los chats y runs anteriores mantienen exactamente su snapshot.

En el editor, **Aplicar perfil de skills** agrega las skills pertinentes y conserva selecciones adicionales. Las versiones antiguas seleccionadas muestran un botón explícito para actualizarlas. Una plantilla modificada se usa en chats nuevos. Las skills no son una sandbox ni conceden permisos: el scheduler y OpenCode siguen controlando las herramientas y repositorios.

El Lead recibe sus skills en la planificación, revisión de tareas y cierre. Los contratos JSON se adaptaron a `assignedAgentId`, `repository` y `approved|changes_requested|review_error`; no se instala el ejemplo incompatible `rejected` del texto original. El collector nativo administra `evidenceDir`, manifest y estados; las skills no crean otra ejecución ni notifican por su cuenta.

El ZIP de la release contiene únicamente los trece archivos públicos, su catálogo y un README. No contiene perfiles, cuentas, claves de firma, bases SQLite ni evidencias privadas.
