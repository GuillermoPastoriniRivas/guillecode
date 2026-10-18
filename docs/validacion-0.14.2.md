# Validación 0.14.2

Fecha: 18 de octubre de 2026.

## Comportamiento comprobado

- Los equipos nuevos incluyen Team Lead, QA, Backend y Frontend con sus perfiles de skills.
- El nombre del equipo y «Abrir chat» llevan a la conversación existente; «Configurar» queda como acción secundaria.
- Enter envía el objetivo y Shift+Enter conserva una nueva línea. La conversación permanece en la vista Chat.
- Los límites son opcionales y permanecen plegados. El presupuesto o cambio de modelo solo aparece cuando el error corresponde a ese caso.
- Un JSON inválido o un plan vacío del Lead se reemplaza por una tarea segura basada en el objetivo original y la carpeta autorizada.
- La reconciliación ignora planes persistidos inválidos y puede volver a planificar sin bloquearse con «1 a 100 tareas».
- Los errores de cuota, conexión o autenticación se muestran como mensajes breves. Los errores JSON guardados previamente también se presentan sin cabeceras, cookies ni datos de transporte en Chat, Tareas y Actividad.
- Un límite de uso de la cuenta no ofrece compactar el historial como solución. El cambio de modelo queda disponible para elegir otra cuenta o proveedor.

## Evidencia y pruebas

- `npm test`: 51 pruebas aprobadas.
- `cargo test --manifest-path src-tauri/Cargo.toml --release --lib teams::`: 25 pruebas aprobadas.
- `playwright test tests/e2e/teams.spec.ts tests/e2e/session-recovery.spec.ts`: 20 flujos aprobados.
- Integración nativa aprobada con Git y sin Git: planificación, modelos distintos, escrituras reales, comandos, corrección del Lead, evidencias inmutables y entrega pendiente de QA manual.
- Recuperación real aprobada con Git y sin Git: reinicio de aplicación y motor, misma sesión e intento, efecto aplicado una sola vez y entrega durable.
- Captura real de la interfaz: [Equipos IA como chat](evidencias/0.14.2-equipos-chat.png).
- Captura de la interfaz renderizada con un error de proveedor simulado de gran tamaño: [Error breve y legible](evidencias/0.14.2-error-proveedor-legible.png).

Las advertencias de compilación existentes no afectaron las pruebas.
