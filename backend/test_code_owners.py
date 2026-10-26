"""code_owners.py: the machine-readable File Ownership table. Stdlib only, no
database. Run on its own: python -m pytest test_code_owners.py
"""
import ast
from pathlib import Path

import code_owners as C

VISESH = "visesh.lodha@greensglobal.com"
NEIL = "neil@greensglobal.com"


def test_normalize_adds_frontend_to_source_stamps():
    assert C.normalize("src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("./src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("frontend/src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("backend/routers/items.py") == "backend/routers/items.py"
    assert C.normalize("src\\views\\InventoryManagement.jsx") == "frontend/src/views/InventoryManagement.jsx"
    assert C.normalize("src/views/InventoryManagement.jsx:120:7") == "frontend/src/views/InventoryManagement.jsx"
    assert C.normalize("/Users/x/Greens-Nexus/frontend/src/asset/Map.jsx") == "frontend/src/asset/Map.jsx"
    assert C.normalize("") == "" and C.normalize(None) == ""


def test_normalize_picks_the_last_marker_in_an_absolute_path():
    assert C.normalize("/home/frontend/Greens-Nexus/backend/routers/items.py") == "backend/routers/items.py"
    assert C.owner_of("/home/frontend/Greens-Nexus/backend/routers/items.py")["name"] == "Visesh"
    assert C.normalize("/srv/backend/Greens-Nexus/frontend/src/asset/Map.jsx") == "frontend/src/asset/Map.jsx"
    assert C.normalize("C:/work/frontend/src/views/AssetModule.jsx") == "frontend/src/views/AssetModule.jsx"


def test_owner_of_files_and_folders():
    assert C.owner_of("src/views/InventoryManagement.jsx") == {"name": "Visesh", "email": VISESH}
    assert C.owner_of("backend/routers/items.py") == {"name": "Visesh", "email": VISESH}
    assert C.owner_of("src/asset/lib/sync.js") == {"name": "Neil", "email": NEIL}
    assert C.owner_of("backend/routers/property_assets.py")["name"] == "Neil"
    assert C.owner_of("src/tasks/TasksHome.jsx") is None
    assert C.owner_of("backend/routers/items_extra.py") is None      # exact file match only
    assert C.owner_of("frontend/src/assets/logo.svg") is None        # folder prefix is "asset/", not "asset"
    assert C.owner_of("") is None


def test_foreign_files_lists_only_other_peoples_files_once():
    paths = ["frontend/src/views/InventoryManagement.jsx", "src/views/InventoryManagement.jsx",
             "frontend/src/asset/App.jsx", "frontend/src/tasks/X.jsx"]
    assert C.foreign_files(paths, NEIL) == [
        {"path": "frontend/src/views/InventoryManagement.jsx", "name": "Visesh", "email": VISESH}]
    assert C.foreign_files(paths, VISESH.upper()) == [
        {"path": "frontend/src/asset/App.jsx", "name": "Neil", "email": NEIL}]
    assert C.foreign_files([], NEIL) == []


def test_stdlib_only():
    """tools/build_notes loads this file by path on machines without the
    backend's packages: no imports at all today, and never an app import."""
    tree = ast.parse(Path(C.__file__).read_text())
    imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert imports == []


def test_claude_md_table_names_the_same_owners():
    text = (Path(__file__).resolve().parent.parent / "CLAUDE.md").read_text()
    assert "backend/code_owners.py" in text
    rows = {line.split("|")[2].strip().strip("*"): line.split("|")[3]
            for line in text.splitlines() if line.startswith("| ") and line.count("|") >= 4}
    for owner in C.OWNERS:
        assert f"**{owner['name']}**" in text
        # every path code_owners.py lists is in that owner's table row
        for path in owner["paths"]:
            assert f"`{path}`" in rows[owner["name"]], (owner["name"], path)
