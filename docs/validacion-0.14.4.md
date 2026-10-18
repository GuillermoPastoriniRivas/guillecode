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
