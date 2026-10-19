use super::domain::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    id: String,
    slug: String,
    name: String,
    version: u32,
    description: String,
    verification_guidelines: Vec<String>,
}

const DOCUMENTS: &[(&str, &str)] = &[
    (
        "aws",
        include_str!("../../../.opencode/skills/aws/SKILL.md"),
    ),
    (
        "backend",
        include_str!("../../../.opencode/skills/backend/SKILL.md"),
    ),
    (
        "code-reviewer",
        include_str!("../../../.opencode/skills/code-reviewer/SKILL.md"),
    ),
    (
        "comportamientos",
        include_str!("../../../.opencode/skills/comportamientos/SKILL.md"),
    ),
    (
        "database",
        include_str!("../../../.opencode/skills/database/SKILL.md"),
    ),
    (
        "devops",
        include_str!("../../../.opencode/skills/devops/SKILL.md"),
    ),
    (
        "docker",
        include_str!("../../../.opencode/skills/docker/SKILL.md"),
    ),
    (
        "frontend",
        include_str!("../../../.opencode/skills/frontend/SKILL.md"),
    ),
    (
        "git-integration",
        include_str!("../../../.opencode/skills/git-integration/SKILL.md"),
    ),
    (
        "graphql",
        include_str!("../../../.opencode/skills/graphql/SKILL.md"),
    ),
    ("qa", include_str!("../../../.opencode/skills/qa/SKILL.md")),
    (
        "security",
        include_str!("../../../.opencode/skills/security/SKILL.md"),
    ),
    (
        "team-lead",
        include_str!("../../../.opencode/skills/team-lead/SKILL.md"),
    ),
];

pub fn catalog() -> Vec<Skill> {
    let definitions: Vec<Definition> =
        serde_json::from_str(include_str!("../../../.opencode/skills/catalog.json"))
            .expect("bundled skill catalog");
    definitions
        .into_iter()
        .map(|d| {
            let document = DOCUMENTS
                .iter()
                .find(|(slug, _)| *slug == d.slug)
                .expect("bundled skill document")
                .1;
            let document = document.replace("\r\n", "\n");
            let instructions = document
                .strip_prefix("---\n")
                .and_then(|s| s.split_once("\n---\n"))
                .expect("skill frontmatter")
                .1
                .trim()
                .to_string();
            Skill {
                id: d.id,
                name: d.name,
                version: d.version,
                description: d.description,
                instructions,
                verification_guidelines: d.verification_guidelines,
            }
        })
        .collect()
}

pub fn upgrade(store: &mut Store) {
    let legacy = legacy_catalog();
    for skill in catalog() {
        let existing: Vec<_> = store.skills.iter().filter(|s| s.id == skill.id).collect();
        // A customized version is never replaced or hidden by a bundled update.
        let upgrade_default = existing.len() == 1
            && legacy.iter().any(|old| {
                old.id == skill.id
                    && serde_json::to_value(old).ok() == serde_json::to_value(existing[0]).ok()
            });
        if existing.is_empty() || upgrade_default {
            store.skills.push(skill);
        }
    }
    // Templates with no skills get useful defaults. Existing selections and all
    // immutable chat/run snapshots keep their original versions and contents.
    for team in &mut store.teams {
        for member in &mut team.members {
            if member.skill_refs.is_empty() && member.id == team.lead_agent_id {
                member.skill_refs = store
                    .skills
                    .iter()
                    .filter(|s| ["team-lead", "comportamientos"].contains(&s.id.as_str()))
                    .filter(|s| {
                        !store
                            .skills
                            .iter()
                            .any(|v| v.id == s.id && v.version > s.version)
                    })
                    .map(|s| SkillRef {
                        id: s.id.clone(),
                        version: s.version,
                    })
                    .collect();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_upgrade_keeps_custom_versions_and_chat_snapshots() {
        let mut store = Store {
            schema_version: 2,
            teams: vec![super::super::domain::tests::team()],
            skills: legacy_catalog(),
            chats: vec![],
        };
        let mut custom = store
            .skills
            .iter()
            .find(|s| s.id == "backend")
            .unwrap()
            .clone();
        custom.version = 2;
        custom.instructions = "Custom backend rules".into();
        store.skills.push(custom);
        let snapshot = store.teams[0].clone();
        store.chats.push(Chat {
            messages: vec![],
            id: "chat".into(),
            title: "Original".into(),
            archived: false,
            team: snapshot,
            skills: store.skills.clone(),
            created_at: 0,
            runs: vec![],
        });
        let original = serde_json::to_value(&store.chats).unwrap();
        upgrade(&mut store);
        assert_eq!(serde_json::to_value(&store.chats).unwrap(), original);
        assert_eq!(store.skills.iter().filter(|s| s.id == "backend").count(), 2);
        assert_eq!(
            store
                .skills
                .iter()
                .find(|s| s.id == "backend" && s.version == 2)
                .unwrap()
                .instructions,
            "Custom backend rules"
        );
        assert!(store
            .skills
            .iter()
            .any(|s| s.id == "frontend" && s.version == 2));
        assert_eq!(store.teams[0].members[0].skill_refs.len(), 2);
        let count = store.skills.len();
        upgrade(&mut store);
        assert_eq!(store.skills.len(), count);
    }
    #[test]
    fn thirteen_skills_have_observable_checks_and_runner_contracts() {
        let skills = catalog();
        assert_eq!(skills.len(), 13);
        for s in skills {
            assert!(s.instructions.contains("Contrato de GuilleCode"));
            assert!(!s.verification_guidelines.is_empty());
            assert!(s.instructions.len() > 1000 && s.instructions.len() < 32_000);
        }
    }
}
