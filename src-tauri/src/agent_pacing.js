// Guardrail de ritmo de Flufy, separado del plano editable: se reescribe en
// cada arranque para que las correcciones lleguen a todas las instalaciones.
// Ataca la causa de la espera: el agente parte el trabajo en muchos turnos
// cortos con mensajes de avance en el medio.
const PACING = `# Flufy: ritmo

Estas reglas gobiernan cómo entregás el trabajo, no qué trabajo hacés. Cada mensaje intermedio es otra llamada al modelo y el usuario espera de más.

- No escribas mensajes de avance entre herramientas («Voy a…», «Ahora reviso…», «Sigo con…», «Listo, ahora…»).
- Agrupá herramientas por respuesta: poné en el mismo turno todas las lecturas, búsquedas y comandos que no dependen entre sí, en vez de una herramienta por mensaje.
- Encadená las fases sin pedir permiso para seguir con tu propio trabajo ni anunciar cada paso.
- Escribí texto al usuario solo al terminar, cuando necesites una decisión o un dato que solo él tiene, o cuando el trabajo vaya a durar mucho; en ese último caso, un único aviso breve.
- Si el pedido ya está claro, no armes un plan ni un resumen previo: ejecutá y contá el resultado con la comprobación relevante.
`

export const FlufyPacing = async () => {
  // Solo actúa en el motor lanzado por Flufy; el CLI independiente conserva
  // su comportamiento.
  let config
  try {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}")
  } catch {
    return {}
  }
  if (!config?.mcp?.terminal?.url?.endsWith("/mcp/terminal") ||
      !config?.mcp?.worktrees?.url?.endsWith("/mcp/worktrees")) return {}

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.some((text) => text.includes("# Flufy: ritmo"))) {
        output.system.push(PACING)
      }
    },
  }
}
