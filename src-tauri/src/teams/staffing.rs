use super::domain::*;
use std::collections::HashSet;

pub const MAX_WORKERS: usize = 10;

pub fn validate_assignments(proposals: &[AgentProposal], tasks: &[Task]) -> Result<(), String> {
    if proposals.iter().any(|p|super::support::reserved(&p.id)) || tasks.iter().any(|t|super::support::reserved(&t.assigned_agent_id)) { return Err("El Solucionador y el Supervisor se administran por sus sesiones de apoyo, sin tareas de escritura".into()); }
    if proposals
        .iter()
        .any(|p| !tasks.iter().any(|t| t.assigned_agent_id == p.id))
    {
        return Err("Cada especialista nuevo necesita una tarea concreta asignada".into());
    }
    Ok(())
}

pub fn prompt(team: &Team) -> String {
    if !team.autonomous {
        return String::new();
    }
    format!("\nMODO EQUIPO AUTOMÁTICO: vos decidís cuántos especialistas necesita ESTE objetivo. No hay una plantilla obligatoria. Podés resolver algo pequeño vos mismo o incorporar hasta {} especialistas en total, contando los ya incorporados. Permití varios agentes del mismo rol (por ejemplo back-1 y back-2 con role Backend, más front-1 con role Frontend). Agregá al JSON agents:[{{\"id\":\"back-1\",\"role\":\"Backend\",\"instructions\":\"responsabilidad concreta\",\"skillIds\":[\"backend\",\"security\"]}}] SOLO con agentes NUEVOS. Las tareas usan esos IDs en assignedAgentId. Se heredan el modelo, las herramientas autorizadas y las carpetas del Lead: no elijas cuentas, proveedores, modelos ni permisos nuevos. Las skills deben existir en el catálogo. Usá el mínimo equipo útil, repartí archivos propios y ejecutá lo independiente en paralelo; nunca agregues agentes solo para aparentar actividad. Para coordinación o cierre podés incorporar otro especialista si falta trabajo sin responsable, junto con sus tareas, sin reemplazar los ya activos.", MAX_WORKERS)
}

pub fn with_agents(
    team: &Team,
    proposals: &[AgentProposal],
    skills: &[Skill],
) -> Result<Team, String> {
    if proposals.is_empty() {
        return Ok(team.clone());
    }
    if !team.autonomous {
        return Err("Los integrantes de este equipo manual se configuran en su plantilla".into());
    }
    if team.members.iter().filter(|m|!super::support::member(m)).count() + proposals.len() > MAX_WORKERS + 1 {
        return Err("El Lead propuso demasiados especialistas para una ejecución".into());
    }
    let lead = team
        .members
        .iter()
        .find(|m| m.id == team.lead_agent_id)
        .ok_or("Falta Lead")?;
    let mut next = team.clone();
    let mut ids: HashSet<_> = team.members.iter().map(|m| m.id.clone()).collect();
    for p in proposals {
        if super::support::reserved(&p.id) || p.id.is_empty()
            || p.id.len() > 64
            || !p
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || !ids.insert(p.id.clone())
            || p.role.trim().is_empty()
            || p.role.len() > 80
            || p.role.eq_ignore_ascii_case("lead")
            || p.instructions.len() > 4000
            || p.skill_ids.len() > 12
        {
            return Err("El Lead propuso un especialista inválido o duplicado".into());
        }
        let defaults: &[&str] = match p.role.to_lowercase().as_str() {
            "frontend" => &["frontend", "security"],
            "backend" => &["backend", "security"],
            "qa" => &["qa", "comportamientos"],
            "database" => &["database", "security"],
            "devops" => &["devops", "docker"],
            "code review" => &["review", "security"],
            "full stack" => &["frontend", "backend", "security"],
            _ => &["security"],
        };
        if p.skill_ids
            .iter()
            .any(|id| !skills.iter().any(|s| s.id == *id))
        {
            return Err("El Lead pidió una skill que no existe en el catálogo".into());
        }
        let refs = skills
            .iter()
            .filter(|s| {
                (p.skill_ids.contains(&s.id) || defaults.contains(&s.id.as_str()))
                    && !skills.iter().any(|v| v.id == s.id && v.version > s.version)
            })
            .map(|s| SkillRef {
                id: s.id.clone(),
                version: s.version,
            })
            .collect();
        let ordinal = next
            .members
            .iter()
            .filter(|m| m.role.eq_ignore_ascii_case(&p.role))
            .count()
            + 1;
        let tools = lead
            .tools
            .iter()
            .filter(|t| {
                !p.role.eq_ignore_ascii_case("code review")
                    || !["edit", "write", "apply_patch"].contains(&t.as_str())
            })
            .cloned()
            .collect();
        next.members.push(Employee {
            id: p.id.clone(),
            name: format!("{} {}", p.role, ordinal),
            role: p.role.clone(),
            model: lead.model.clone(),
            variant: lead.variant.clone(),
            skill_refs: refs,
            instructions: p.instructions.clone(),
            tools,
            max_concurrent_tasks: 1,
        });
    }
    validate_team(&next, skills)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lead_can_add_two_backends_and_frontend_without_expanding_authority() {
        let mut team = super::super::domain::tests::team();
        team.autonomous = true;
        let proposals: Vec<AgentProposal> = serde_json::from_value(serde_json::json!([
            {"id":"back-1","role":"Backend"}, {"id":"back-2","role":"Backend"}, {"id":"front-1","role":"Frontend"}
        ])).unwrap();
        let expanded = with_agents(&team, &proposals, &[]).unwrap();
        assert_eq!(expanded.members.len(), 4);
        assert_eq!(expanded.members[1].name, "Backend 1");
        assert_eq!(expanded.members[2].name, "Backend 2");
        for member in &expanded.members[1..] {
            assert_eq!(member.tools, team.members[0].tools);
            assert_eq!(member.model.model_id, team.members[0].model.model_id);
        }
        assert_eq!(expanded.allowed_repositories, team.allowed_repositories);
        assert!(with_agents(&expanded, &proposals, &[]).is_err());
        team.autonomous = false;
        assert!(with_agents(&team, &proposals, &[]).is_err());
        team.autonomous = true;
        let mut invalid = proposals.clone();
        invalid[0].skill_ids = vec!["missing".into()];
        assert!(with_agents(&team, &invalid, &[]).is_err());
        invalid = proposals.clone();
        invalid[0].id = "lead".into();
        assert!(with_agents(&team, &invalid, &[]).is_err());
        let overflow: Vec<_> = (0..MAX_WORKERS + 1)
            .map(|n| AgentProposal {
                id: format!("back-{}", n),
                role: "Backend".into(),
                instructions: String::new(),
                skill_ids: vec![],
            })
            .collect();
        assert!(with_agents(&team, &overflow[..MAX_WORKERS], &[]).is_ok());
        assert!(with_agents(&team, &overflow, &[]).is_err());
    }
}
