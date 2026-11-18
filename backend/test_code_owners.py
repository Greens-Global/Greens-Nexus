"""code_owners.py: who owns which files - nobody since Neil, 11/13/2026.
The mechanism is still tested on a sample list. Stdlib only, no database.
Run on its own: python -m pytest test_code_owners.py
"""
import ast
from pathlib import Path

import pytest

import code_owners as C

VISESH = "visesh.lodha@greensglobal.com"
NEIL = "neil@greensglobal.com"
SAMPLE = [
    {"name": "Visesh", "email": VISESH, "paths": [
        "frontend/src/views/InventoryManagement.jsx", "frontend/src/inventory/", "backend/routers/items.py"]},
    {"name": "Neil", "email": NEIL, "paths": [
        "frontend/src/views/AssetModule.jsx", "frontend/src/asset/", "backend/routers/property_assets.py"]},
]


@pytest.fixture
def sample(monkeypatch):
    monkeypatch.setattr(C, "OWNERS", SAMPLE)


def test_nobody_owns_any_files():
    # Neil, 11/13/2026: "Remove those limitations permanently".
    assert C.OWNERS == []
    assert C.owner_of("src/views/InventoryManagement.jsx") is None
    assert C.owner_of("src/asset/lib/sync.js") is None
    assert C.foreign_files(["backend/routers/items.py", "frontend/src/asset/App.jsx"], NEIL) == []


def test_normalize_adds_frontend_to_source_stamps():
    assert C.normalize("src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("./src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("frontend/src/tasks/X.jsx") == "frontend/src/tasks/X.jsx"
    assert C.normalize("backend/routers/items.py") == "backend/routers/items.py"
    assert C.normalize("src\\views\\InventoryManagement.jsx") == "frontend/src/views/InventoryManagement.jsx"
    assert C.normalize("src/views/InventoryManagement.jsx:120:7") == "frontend/src/views/InventoryManagement.jsx"
    assert C.normalize("/Users/x/Greens-Nexus/frontend/src/asset/Map.jsx") == "frontend/src/asset/Map.jsx"
    assert C.normalize("") == "" and C.normalize(None) == ""


def test_normalize_picks_the_last_marker_in_an_absolute_path(sample):
    assert C.normalize("/home/frontend/Greens-Nexus/backend/routers/items.py") == "backend/routers/items.py"
    assert C.owner_of("/home/frontend/Greens-Nexus/backend/routers/items.py")["name"] == "Visesh"
    assert C.normalize("/srv/backend/Greens-Nexus/frontend/src/asset/Map.jsx") == "frontend/src/asset/Map.jsx"
    assert C.normalize("C:/work/frontend/src/views/AssetModule.jsx") == "frontend/src/views/AssetModule.jsx"


def test_owner_of_files_and_folders(sample):
    assert C.owner_of("src/views/InventoryManagement.jsx") == {"name": "Visesh", "email": VISESH}
    assert C.owner_of("backend/routers/items.py") == {"name": "Visesh", "email": VISESH}
    assert C.owner_of("src/asset/lib/sync.js") == {"name": "Neil", "email": NEIL}
    assert C.owner_of("backend/routers/property_assets.py")["name"] == "Neil"
    assert C.owner_of("src/tasks/TasksHome.jsx") is None
    assert C.owner_of("backend/routers/items_extra.py") is None      # exact file match only
    assert C.owner_of("frontend/src/assets/logo.svg") is None        # folder prefix is "asset/", not "asset"
    assert C.owner_of("") is None


def test_foreign_files_lists_only_other_peoples_files_once(sample):
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


def test_claude_md_has_no_ownership_limits():
    text = (Path(__file__).resolve().parent.parent / "CLAUDE.md").read_text()
    assert "Do not modify the other developer's files" not in text
    assert "| Owner |" not in text
