"""Storage Academy content package: loader + validator. ONE FILE PER PROCESS."""
import json
import os
import tempfile

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

import pytest  # noqa: E402

import kb_academy  # noqa: E402
from kb_academy_testpkg import _pkg, _q  # noqa: E402

SLUGS = kb_academy.ORDER


@pytest.fixture(autouse=True)
def _no_pinned_minimums(monkeypatch):
    # the minimal package is tiny; the pinned-minimum tests restore the real values
    monkeypatch.setattr(kb_academy, "MIN_READING", dict.fromkeys(SLUGS, 0))


def _probs(tmp_path, mutate=None):
    return kb_academy.problems(kb_academy.load(_pkg(tmp_path, mutate)))


def test_valid_minimal_package_has_no_problems(tmp_path):
    assert _probs(tmp_path) == []


def _has(probs, text):
    assert any(text in p for p in probs), probs


def _quiz(cfg, fn):
    fn(cfg["quiz"]["questions"])


CASES = {
    "missing page": (lambda c: c["lessons"].__setitem__(1, {"page": "nope", "title": "Nope", "summary": "s"}), "does not exist"),
    "answer out of range": (lambda c: c["quiz"]["questions"][0].update(answer=[5]), "normalizer changes"),
    "multi one answer": (lambda c: c["quiz"]["questions"][0].update(type="multi"), "multi question needs"),
    "order one item": (lambda c: c["quiz"]["questions"][0].update(type="order", options=["A"], answer=[]), "normalizer"),
    "checkpoint over 10": (lambda c: c["lessons"][2].update(questions=[_q(i) for i in range(11)]), "more than 10"),
    "bank too small": (lambda c: c["quiz"].update(questions=[_q(i) for i in range(44)]), "needs 45"),
    "draw too low": (lambda c: c["quiz"].update(drawCount=14), "drawCount"),
    "draw too high": (lambda c: c["quiz"].update(drawCount=41), "drawCount"),
    "photo": (lambda c: c["quiz"]["questions"][0].update(type="photo", options=[], answer=[]), "photo"),
    "short digit": (lambda c: c["quiz"]["questions"][0].update(type="short", options=[], answer=[], keywords=["30 days"]), "digit"),
    "long q": (lambda c: c["quiz"]["questions"][0].update(q="x" * 601), "over 600"),
    "long option": (lambda c: c["quiz"]["questions"][0].update(options=["x" * 301, "B"]), "over 300"),
    "long explanation": (lambda c: c["quiz"]["questions"][0].update(explanation="x" * 401), "over 400"),
    "seven options": (lambda c: c["quiz"]["questions"][0].update(options=list("ABCDEFG")), "more than 6"),
    "empty checkpoint title": (lambda c: c["lessons"][2].update(checkpoint=""), "empty title"),
    "em dash": (lambda c: c.update(lesson=c["lesson"] + "\nA — B\n"), "banned copy"),
    "en dash in option": (lambda c: c["quiz"]["questions"][0].update(options=["A–Z", "B"]), "banned copy"),
    "iso date": (lambda c: c.update(page=c["page"] + "\nOn 2026-11-04 it began.\n"), "banned copy"),
    "timecard": (lambda c: c.update(page=c["page"] + "\nFill the timecard.\n"), "banned copy"),
    "Global Admin": (lambda c: c.update(page=c["page"] + "\nAsk a Global Admin.\n"), "banned copy"),
    "greens to fill": (lambda c: c.update(page=c["page"].replace("tags: a, b", "tags: cubby-filled") + "\n[Greens to fill]\n"), "Greens to fill"),
    "title case": (lambda c: c["lessons"].__setitem__(1, {"page": "gate-codes", "title": "gate codes", "summary": "s"}), "Title Case"),
    "page title case": (lambda c: c.update(page=c["page"].replace("Gate Codes", "gate codes")), "Title Case"),
    "one-line callout": (lambda c: c.update(lesson=c["lesson"] + "\n> [!TIP] one line\n"), "callout"),
    "page no title": (lambda c: c.update(page=c["page"].replace("title: Gate Codes\n", "")), "no title"),
    "lesson by number": (lambda c: c.update(lesson=c["lesson"] + "\nSee lesson 3 for more.\n"), "names a lesson by number"),
    "page lesson by number": (lambda c: c.update(page=c["page"] + "\nIn Lesson 2 you saw it.\n"), "names a lesson by number"),
    "question lesson by number": (lambda c: c["quiz"]["questions"][0].update(explanation="Covered in lesson 4."), "names a lesson by number"),
    "bold lessons header": (lambda c: c.update(lesson=c["lesson"] + "\n**Lessons:** 4, 5.\n"), "names a lesson by number"),
    "plan order": (lambda c: c["plan"].update(courses=list(reversed(SLUGS))), "in order"),
    "too many lessons": (lambda c: c.update(lessons=[{"file": "01.md"}] * 61), "more than 60"),
}


@pytest.mark.parametrize("name", [n for n in CASES if n != "order one item"])
def test_problem_is_reported(tmp_path, name):
    mutate, text = CASES[name]
    _has(_probs(tmp_path, mutate), text)


def test_order_with_one_item_is_reported(tmp_path):
    _has(_probs(tmp_path, CASES["order one item"][0]), "normalizer")


def test_reading_minutes_below_minimum(tmp_path):
    pkg = _pkg(tmp_path)
    p = pkg / "courses" / "01-nexus-fundamentals" / "course.json"
    c = json.loads(p.read_text())
    c["min_reading_minutes"] = 70
    p.write_text(json.dumps(c))
    _has(kb_academy.problems(kb_academy.load(pkg)), "reading minutes")


def test_real_package_is_valid(monkeypatch):
    monkeypatch.undo()  # the pinned minimums apply to the real package
    if not list((kb_academy.ROOT / "courses").glob("*/course.json")):
        pytest.skip("no courses authored yet")
    assert kb_academy.problems(kb_academy.load()) == []


def test_dash_in_words_does_not_trip_admin_check(tmp_path):
    def m(c):
        c["page"] += "\nPlease submit administrators and audit admin notes.\n"
    assert _probs(tmp_path, m) == []


def test_load_errors_become_problems(tmp_path):
    pkg = _pkg(tmp_path)
    (pkg / "courses" / "01-nexus-fundamentals" / "lessons" / "01.md").unlink()
    (pkg / "courses" / "02-self-storage-fundamentals" / "course.json").write_text("{not json")
    (pkg / "courses" / "04-rv-boat-storage-fundamentals" / "course.json").write_text("{}")
    probs = kb_academy.problems(kb_academy.load(pkg))
    assert sum("cannot load" in p for p in probs) == 3, probs


def test_pinned_minimums_are_enforced(tmp_path, monkeypatch):
    monkeypatch.setattr(kb_academy, "MIN_READING", {"nexus-fundamentals": 70})
    _has(_probs(tmp_path), "nexus-fundamentals: reading minutes")


def test_est_minutes_pinned(tmp_path):
    pkg = _pkg(tmp_path)
    p = pkg / "courses" / "01-nexus-fundamentals" / "course.json"
    c = json.loads(p.read_text())
    c["est_minutes"] = 60
    p.write_text(json.dumps(c))
    _has(kb_academy.problems(kb_academy.load(pkg)), "est_minutes 60 must be 100")


def test_tf_options(tmp_path):
    tf = {"type": "tf", "q": "Is it?", "answer": [0], "explanation": "Yes."}
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    assert _probs(tmp_path / "a", lambda c: c["quiz"]["questions"].__setitem__(0, dict(tf))) == []
    _has(_probs(tmp_path / "b", lambda c: c["quiz"]["questions"].__setitem__(0, dict(tf, options=["Yes", "No"]))), "normalizer changes")


def test_sanitize_changes_are_reported(tmp_path):
    a = kb_academy.load(_pkg(tmp_path))
    img = {"type": "image", "attrs": {"src": "data:image/png;base64,AAAA", "alt": "Gate"}}
    a.pages["gate-codes"].blocks["content"].append(img)
    a.courses[0].lessons[0]["blocks"]["content"].append(dict(img))
    probs = kb_academy.problems(a)
    _has(probs, "sanitize changes page gate-codes")
    _has(probs, "sanitize changes nexus-fundamentals 'Welcome Aboard'")


def test_question_lesson_must_name_a_lesson(tmp_path):
    _has(_probs(tmp_path, lambda c: c["quiz"]["questions"][0].update(lesson="99-missing.md")), "names lesson '99-missing.md'")


def test_question_lesson_links_lesson_id(tmp_path):
    def tag(c):
        c["quiz"]["questions"][0]["lesson"] = "01.md"
        c["lessons"][2]["questions"][0]["lesson"] = "gate-codes"
    a = kb_academy.load(_pkg(tmp_path, tag))
    assert kb_academy.problems(a) == []
    c = a.courses[0]
    assert [L["_id"] for L in c.lessons] == [f"l_{c.slug}_01", f"l_{c.slug}_02", f"l_{c.slug}_03"]
    assert c.quiz["questions"][0]["lessonId"] == c.lessons[0]["_id"]
    assert c.lessons[2]["questions"][0]["lessonId"] == c.lessons[1]["_id"]
