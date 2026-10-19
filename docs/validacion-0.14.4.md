# Validación 0.14.4

Esta actualización reemplaza mensajes técnicos crudos por explicaciones breves con la causa conocida y el próximo paso. La misma traducción se aplica al guardar los fallos de agentes, para que Chat, Tareas, Actividad, evidencias y notificaciones muestren el mismo motivo.

Incluye errores anidados de cuota, modelo, autenticación, conexión, carpeta sin Git, plan inválido y comprobaciones no observadas. Los detalles de encabezados, cookies y tokens siguen fuera de la interfaz.

Validación local:

- `npm test`: 52 pruebas correctas.
- `npm run build`: compilación TypeScript y frontend correcta.
- `npm run lint`: correcto, con advertencias existentes del repositorio.
- `npx playwright test tests/e2e/session-recovery.spec.ts tests/e2e/teams.spec.ts`: 21 pruebas correctas; cubre chat normal, Chat/Tareas/Actividad y errores de Git y verificaciones.
- `cargo test --manifest-path src-tauri/Cargo.toml --release --locked --lib`: 110 correctas, 4 ignoradas.
- `cargo test --manifest-path src-tauri/Cargo.toml --release --locked --lib teams::errors::tests`: 3 correctas con las traducciones finales.

La prueba de interfaz usa datos locales controlados. La actualización conserva el historial y el perfil mediante el canal firmado existente.

Se quitó del chat el bloque de tokens y costo de cada ejecución. El seguimiento interno se mantiene para los límites configurados.

El harness de actualización detecta si Windows dispone del shell de escritorio que requiere `RunAsUser` al ejecutar un instalador elevado. En runners sin ese shell comprueba el reemplazo NSIS y la conservación del perfil, y luego arranca explícitamente la app; informa `automaticRelaunchTested: false`. En una sesión de escritorio exige además el relanzamiento automático. El informe se conserva como artefacto de Actions, sin credenciales ni contenido de conversaciones. Referencia del requisito: [implementación de RunAsUser de Tauri](https://github.com/tauri-apps/nsis-tauri-utils/blob/dev/crates/nsis-process/src/lib.rs).

La primera validación completa en Actions pasó frontend, Rust, integración de equipos y reinicios, pero encontró un fallo al liberar el motor durante la actualización NSIS: las rutas abreviadas de Windows no coincidían con las rutas largas informadas por el sistema. El instalador ahora compara las rutas reales de los archivos. Una prueba de regresión con un alias de carpeta reproduce el fallo anterior y verifica que se cierre solo el motor de esa instalación; otro motor sigue abierto y un bloqueo ajeno impide continuar.

La prueba real desde la interfaz de Windows creó un equipo de Lead, Backend, Frontend y QA en una carpeta sin Git. Los tres trabajos independientes comenzaron simultáneamente. Detectó que el Lead rechazaba comandos válidos de PowerShell por confundir el nombre de herramienta bash con el intérprete requerido. Se aclaró el contrato para trabajadores y revisores, y el feedback enumera las verificaciones reales satisfactorias para corregir el resultado sin repetir efectos. Una regresión comprueba que PowerShell observado con salida 0 es válido y que comandos fallidos, no observados o con descripciones añadidas siguen rechazados. La prueba integrada Hola mundo queda pendiente de repetir con esta corrección; no se considera aprobada todavía.
