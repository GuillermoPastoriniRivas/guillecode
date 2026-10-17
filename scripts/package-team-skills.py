"""Package only the bundled, public OpenCode skill files; never a user profile."""
import json
import re
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
catalog = json.loads((root / ".opencode/skills/catalog.json").read_text(encoding="utf-8"))
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "test-results/release"
output.mkdir(parents=True, exist_ok=True)
destination = output / f"guillecode-team-skills-{version}.zip"
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
    for skill in catalog:
        slug = skill["slug"]
        if not re.fullmatch(r"[a-z]+(?:-[a-z]+)*", slug):
            raise ValueError("Invalid bundled skill slug")
        path = f".opencode/skills/{slug}/SKILL.md"
        archive.write(root / path, path)
    archive.write(root / ".opencode/skills/catalog.json", ".opencode/skills/catalog.json")
    archive.writestr("README.md", "# GuilleCode — 13 skills\n\nCopiá las carpetas .opencode/skills/ al proyecto OpenCode deseado. Revisá skills existentes antes de reemplazarlas. En GuilleCode ya vienen integradas: elegí un perfil por integrante en Equipos IA. Las skills son instrucciones; no otorgan permisos. El QA manual queda pendiente del usuario.\n")
with zipfile.ZipFile(destination) as archive:
    assert archive.testzip() is None
    assert len([name for name in archive.namelist() if name.endswith("/SKILL.md")]) == 13
print(destination)
