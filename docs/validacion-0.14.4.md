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

El harness de actualización detecta si el proceso está elevado. RunAsUser delega a Explorer en ese caso y no hereda el perfil aislado de QA, aunque el shell exista. En procesos elevados comprueba el reemplazo NSIS y la conservación del perfil, y luego arranca explícitamente la app con su entorno aislado; informa `automaticRelaunchTested: false`. En una sesión de escritorio no elevada exige además el relanzamiento automático. El informe se conserva como artefacto de Actions, sin credenciales ni contenido de conversaciones. Referencia del requisito: [implementación de RunAsUser de Tauri](https://github.com/tauri-apps/nsis-tauri-utils/blob/dev/crates/nsis-process/src/lib.rs).

La primera validación completa en Actions pasó frontend, Rust, integración de equipos y reinicios, pero encontró un fallo al liberar el motor durante la actualización NSIS: las rutas abreviadas de Windows no coincidían con las rutas largas informadas por el sistema. El instalador ahora compara las rutas reales de los archivos. Una prueba de regresión con un alias de carpeta reproduce el fallo anterior y verifica que se cierre solo el motor de esa instalación; otro motor sigue abierto y un bloqueo ajeno impide continuar.

La prueba real desde la interfaz de Windows creó un equipo de Lead, Backend, Frontend y QA en una carpeta sin Git. Los tres trabajos independientes comenzaron simultáneamente. Detectó que el Lead rechazaba comandos válidos de PowerShell por confundir el nombre de herramienta bash con el intérprete requerido. Se aclaró el contrato para trabajadores y revisores, y el feedback enumera las verificaciones reales satisfactorias para corregir el resultado sin repetir efectos. Una regresión comprueba que PowerShell observado con salida 0 es válido y que comandos fallidos, no observados o con descripciones añadidas siguen rechazados. La prueba integrada Hola mundo queda pendiente de repetir con esta corrección; no se considera aprobada todavía.

El nuevo intento real completó las cuatro tareas. QA ejecutó dos veces node qa/check.mjs con salida 0: puertos disponibles, backend JSON/CORS, página y recursos, rutas 404. La prueba visual permanece pendiente. La sesión de revisión individual aún mostraba el JSON interno: se añadió una presentación específica para sesiones del equipo (planes, revisiones, resultados y pedidos al Lead), también para historial y streaming. Se conserva el protocolo original para el runner y no se transforma el JSON solicitado en chats normales. Las aprobaciones sin criteriaSatisfied=true se muestran sin aprobación confirmada.

Corrección adicional del harness NSIS: en procesos elevados RunAsUser delega a Explorer y no hereda el entorno aislado de QA, aunque GetShellWindow exista. En ese caso el harness verifica reemplazo y conservación y relanza con su entorno explícito; marca automaticRelaunchTested=false. En escritorio no elevado sigue exigiendo /R. No se permite confundir esa cobertura con una prueba de relanzamiento elevado.

Validación de la corrección de presentación: 55 pruebas unitarias correctas; TypeScript/frontend compilados; lint sin errores (advertencias previas). Los nuevos tests de interfaz verifican lectura del historial, JSON parcial durante streaming, recarga y conservación del JSON solicitado en chats normales. El modo aislado de actualización NSIS pasó localmente con conversación y preferencias preservadas y sin cerrar el motor de otra instalación.
