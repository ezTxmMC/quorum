"""Exercise the built CLI against an isolated database, without model requests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="quorum-plan-cli-") as temporary:
    root = Path(temporary)
    workspace = root / "workspace with spaces"
    workspace.mkdir()
    environment = {**os.environ, "QUORUM_DATA_DIR": str(root / "data")}

    def run(*arguments, success=True):
        result = subprocess.run(
            ["node", str(project / "bin/quorum.mjs"), "plan", *map(str, arguments)],
            env=environment, capture_output=True, text=True, timeout=20,
        )
        if not success:
            assert result.returncode != 0, result.stdout
            return result
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    definition = {
        "objective": "Implement a feature", "requirements": [], "constraints": [],
        "assumptions": [], "outOfScope": [],
        "phases": [{"id": "phase", "title": "Implementation", "order": 0}],
        "tasks": [{
            "id": "task", "phaseId": "phase", "order": 0, "title": "Implement",
            "description": "Implement the feature", "dependencies": [], "priority": "normal",
            "complexity": "simple", "instructions": [], "expectedFiles": [],
            "expectedArtifacts": [], "requiresApproval": True, "maxAttempts": 1,
            "acceptanceCriteria": [{"id": "criterion", "description": "Reviewed", "verification": "manual"}],
        }], "modelAssignments": [],
    }
    definition_path = root / "definition.json"
    definition_path.write_text(json.dumps(definition))
    created = run("create", workspace, "CLI plan", definition_path)
    plan_id = created["plan"]["id"]
    revision = created["plan"]["currentRevisionId"]
    assert run("list", workspace)[0]["id"] == plan_id
    assert run("show", plan_id)["revisions"][0]["objective"] == definition["objective"]
    scope_path = root / "scope.json"
    scope_path.write_text(json.dumps({"workspaceRoot": str(workspace), "allowedPaths": ["."], "allowedTools": ["read"], "allowShell": False, "allowNetwork": False}))
    asked = run("ask", plan_id, revision, "Which tests?")
    run("approve", plan_id, revision, scope_path, success=False)
    answered = run("answer", plan_id, asked["questions"][0]["id"], "Integration tests")
    assert answered["questions"][0]["answer"] == "Integration tests"
    assert run("approve", plan_id, revision, scope_path)["plan"]["status"] == "approved"
    revised = run("revise", plan_id, revision, definition_path)
    assert len(revised["revisions"]) == 2
    run("revise", plan_id, revision, definition_path, success=False)
    exported = run("export", plan_id)
    export_path = root / "export.json"
    export_path.write_text(json.dumps(exported))
    imported = run("import", workspace, export_path)
    assert imported["plan"]["id"] != plan_id
    assert imported["approvals"] == []
    assert run("archive", imported["plan"]["id"])["plan"]["status"] == "archived"
    print("Plan CLI: launcher, shared SQLite state, CRUD, questions, approvals, stale revisions and import/export passed.")
