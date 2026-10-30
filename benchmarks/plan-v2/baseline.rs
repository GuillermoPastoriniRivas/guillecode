// Verbatim excerpts from eba1f55758792f972014987da17af8ab891ed16c; benchmark only.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub assigned_agent_id: String,
    pub repository: String,
    pub dependencies: Vec<String>,
    pub expected_files: Vec<String>,
    /// Explicit relative files/directories owned by this task. Empty means exclusive folder.
    #[serde(default)]
    pub write_paths: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    #[serde(default = "pending")]
    pub status: String,
    #[serde(default)]
    pub attempts: Vec<Attempt>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default)]
    pub agents: Vec<AgentProposal>,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub evidence_targets: Vec<CaptureTarget>,
}

pub fn same_path(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

fn normalize(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

pub fn valid_write_path(path: &str) -> bool {
    let path = path.replace('\\', "/");
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains([':', '*', '?', '[', ']', '{', '}'])
        && path
            .trim_end_matches('/')
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != ".." && c.trim() == c && !c.ends_with('.'))
}

pub fn validate_plan(p: &Plan, team: &Team) -> Result<(), String> {
    super::capture::validate_targets(&p.evidence_targets)?;
    if p.tasks.is_empty() || p.tasks.len() > 100 {
        return Err("El plan debe contener entre 1 y 100 tareas".into());
    }
    let ids: HashSet<_> = p.tasks.iter().map(|t| t.id.as_str()).collect();
    if ids.len() != p.tasks.len() || ids.contains("") {
        return Err("IDs de tareas duplicados o vacíos".into());
    }
    for t in &p.tasks {
        if t.write_paths.iter().any(|p| !valid_write_path(p)) {
            return Err("writePaths debe contener archivos relativos o directorios terminados en /, sin comodines ni escapes".into());
        }
        if t.title.trim().is_empty()
            || t.objective.trim().is_empty()
            || t.acceptance_criteria.is_empty()
            || t.acceptance_criteria.iter().any(|s| s.trim().is_empty())
            || !team.members.iter().any(|m| m.id == t.assigned_agent_id)
        {
            return Err(format!(
                "Tarea incompleta o responsable inexistente: {}",
                t.id
            ));
        }
        if !team
            .allowed_repositories
            .iter()
            .any(|r| same_path(r, &t.repository))
        {
            return Err(format!("Carpeta no autorizada: {}", t.repository));
        }
        if t.dependencies
            .iter()
            .any(|d| !ids.contains(d.as_str()) || d == &t.id)
        {
            return Err("Dependencia inválida".into());
        }
        if t.expected_files.iter().any(|p| {
            p.starts_with(['/', '\\'])
                || p.contains(':')
                || p.replace('\\', "/").split('/').any(|c| c == "..")
        }) {
            return Err("Alcance de archivos fuera de la carpeta autorizada".into());
        }
    }
    let mut done = HashSet::new();
    loop {
        let n = done.len();
        for t in &p.tasks {
            if t.dependencies.iter().all(|d| done.contains(d.as_str())) {
                done.insert(t.id.as_str());
            }
        }
        if done.len() == p.tasks.len() {
            return Ok(());
        }
        if done.len() == n {
            return Err("El plan contiene un ciclo".into());
        }
    }
}

pub fn parse_json<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let s = text.trim();
    let s = if s.starts_with("```") {
        s.split_once('\n')
            .and_then(|(_, b)| b.strip_suffix("```"))
            .ok_or("JSON incompleto")?
            .trim()
    } else {
        s
    };
    serde_json::from_str(s).map_err(|e| format!("Respuesta estructurada inválida: {}", e))
}

fn fallback_plan(r: &Run, reason: &str) -> (Plan, String) {
    let employee = r
        .team
        .members
        .iter()
        .find(|member| {
            member
                .tools
                .iter()
                .any(|tool| matches!(tool.as_str(), "edit" | "write" | "apply_patch"))
        })
        .or_else(|| {
            r.team
                .members
                .iter()
                .find(|member| member.id == r.team.lead_agent_id)
        })
        .expect("validate_team guarantees at least one Lead");
    let task = Task {
        id: "T1".into(),
        title: "Resolver el objetivo del usuario".into(),
        objective: r.goal.clone(),
        assigned_agent_id: employee.id.clone(),
        repository: r.team.allowed_repositories[0].clone(),
        dependencies: vec![],
        expected_files: vec![],
        write_paths: vec![],
        acceptance_criteria: vec![
            "Completar el objetivo y ejecutar las comprobaciones pertinentes".into(),
            "Informar cambios, resultados observados y cualquier limitación real".into(),
        ],
        status: "pending".into(),
        attempts: vec![],
        error: None,
    };
    (
        Plan {
            agents: vec![],
            tasks: vec![task],
            evidence_targets: vec![],
        },
        evidence::sanitize(reason),
    )
}

fn validated_plan(text: &str, r: &Run) -> Result<Plan, String> {
    parse_json::<Plan>(text).and_then(|plan| {
        super::staffing::validate_assignments(&plan.agents, &plan.tasks)?;
        let team = super::staffing::with_agents(&r.team, &plan.agents, &r.skills)?;
        validate_plan(&plan, &team)?;
        Ok(plan)
    })
}

fn usable_plan(text: &str, r: &Run) -> (Plan, Option<String>) {
    match validated_plan(text, r) {
        Ok(plan) => (plan, None),
        Err(reason) => {
            let (plan, reason) = fallback_plan(r, &reason);
            (plan, Some(reason))
        }
    }
}
