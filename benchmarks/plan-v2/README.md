# Comparaciones de Plan Vivo V2

`npm run benchmark:plan-v2` ejecuta 30 escenarios de admisión pareados con objetivos distintos y dificultad baja/media/alta. Incluye TypeScript, NestJS, React, contratos entre stacks, pruebas negativas, requisitos ambiguos, carpetas sin Git y recuperación como escenarios del contrato. **No ejecuta treinta implementaciones ni reinicios**: los reinicios y efectos reales tienen harnesses nativos separados.

A usa extractos originales de v0.17.0, fijados por commit y SHA-256; B pasa exactamente las mismas propuestas finales al validador V2 con selección manual; C añade el selector real de rutas y un catálogo controlado. Las propuestas representan la frontera de admisión después de las oportunidades de reparación. Se mide admisión, sustituciones genéricas y disponibilidad por capacidades, no tasa de planes válidos al primer intento ni calidad de inferencia. El catálogo de estrés no incluye el modelo manual y sí una alternativa configurada compatible. No representa frecuencia de desconexiones en producción.

Los resultados JSON y Markdown se generan en `test-results/benchmarks/`. Las duraciones locales son nanosegundos del validador/selector, no latencia de modelos. Precio, cuota e intervención no observados son `null`, nunca cero. El baseline sólo se compila bajo `cfg(test)` y no entra al ejecutable.

## Resultados de implementaciones reales

`npm run benchmark:plan-v2:results -- manifest.json` compara exportaciones de ejecuciones con veredictos independientes. No lanza inferencia paga ni ejecuta comandos contenidos en archivos de entrada. Los tests o el evaluador externo deben producir los veredictos antes de importar resultados; un cierre narrado por el trabajador no los reemplaza. Para una evaluación ciega, el evaluador recibe objetivo, requisitos y artefactos sin nombre del brazo; el recolector agrega `caseId` y hash después.

Formato del manifiesto (rutas relativas al manifiesto):

```json
{
  "schemaVersion": 1,
  "corpusSha256": "SHA-256 de corpus.json, bytes exactos",
  "samples": [{
    "caseId": "01-typescript-dto-valid", "arm": "b",
    "controls": { "model": "proveedor/modelo/variante", "toolsSha256": "hash", "fixtureSha256": "hash", "runtimeVersion": "versión observada", "commit": "commit medido" },
    "runPath": "run.json", "verdictPath": "independent-verdict.json",
    "wallTimeMs": 1000, "humanInterventions": [{ "kind": "final_manual_qa" }]
  }]
}
```

`arm` admite a/b/c y d opcional. A debe declarar el commit original de `baseline.json`; A/B deben compartir modelo, herramientas, fixture y versión del runtime; B/C comparten herramientas, fixture y runtime. B debe tener ruteo deshabilitado y C habilitado en el snapshot del equipo. El reporte sólo se considera completo al cubrir los treinta objetivos en A/B/C. D exige exportación normalizada al contrato Run y controles equivalentes; no hay resultados de CodeAF/Oh My Hermes incluidos.

```json
{
  "caseId": "01-typescript-dto-valid", "runSha256": "SHA-256 de los bytes exactos de run.json",
  "evaluator": "test-suite independiente versión/hash",
  "objectivePassed": true,
  "requirements": [{ "id": "R1", "passed": true, "evidence": "reporte de test positivo y negativo" }],
  "scopeViolations": null, "duplicateEffects": null
}
```

El éxito requiere simultáneamente veredicto independiente, todos los requisitos originales y recibos observados de sesiones/comandos/revisión. Un objetivo sin veredicto queda desconocido. Se reportan cobertura, intentos, revisiones, decisiones de ruteo, tiempo y costo observado; intervenciones desconocidas no se sustituyen por cero y el QA final deliberado se excluye. El importador vincula evidencias por hash pero no certifica la honestidad del evaluador: debe ser una herramienta de confianza. Seguridad, recuperación y usabilidad requieren mediciones propias; no se infieren de un estado verde.

Pruebas de ejecución separadas:

```powershell
node tests/teams-engine.mjs --plan-v2 --routing
node tests/teams-restart.mjs --plan-v2 --routing
npx playwright test tests/e2e/pwa-teams.spec.ts --workers=1
```
