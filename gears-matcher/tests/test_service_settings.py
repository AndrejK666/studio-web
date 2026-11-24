"""The run settings an operator changes while the service runs (`GET`/`PUT /v1/settings`).

On the fake runner and a real PostgreSQL database; no model is called. Keys are never settings:
a provider is offered only when its key is there, which the fake check stands in for.
"""

import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest
import yaml
from jsonschema import Draft202012Validator
from service_fakes import FakeRunner, get, serve_app

from gears_matcher.service.app import create_app
from gears_matcher.service.errors import ProblemError
from gears_matcher.service.manager import RunManager
from gears_matcher.service.request import Limits, body_digest
from gears_matcher.service.settings import Settings, Values
from gears_matcher.service.store import TERMINAL, RunStore

SPEC = yaml.safe_load(
    (Path(__file__).parent.parent / "schemas/service/matcher-service.openapi.yaml").read_text(
        encoding="utf-8"
    )
)
CONFIG = Values("constructor", ("claude-sonnet-4-6", "claude-opus-5", "gpt-5.4"), 400, 100)
PROVIDERS = ("constructor", "anthropic", "openai")
SECRET = "s"  # noqa: S105 -- a test value
DOC = "# Todo\n"


def validate(name: str, value: Any) -> None:
    Draft202012Validator(
        {"$ref": f"#/components/schemas/{name}", "components": SPEC["components"]}
    ).validate(value)


def keys(*present: str) -> Any:
    """A provider check: these providers have their key, the others name the missing variable."""

    def check(provider: str) -> str | None:
        return None if provider in present else f"{provider.upper()}_KEY not set"

    return check


def settings(store: RunStore, *present: str) -> Settings:
    return Settings(CONFIG, PROVIDERS, keys(*present), store)


def update(s: Settings, version: int, **overrides: Any) -> dict[str, Any]:
    return s.update({"version": version, "overrides": overrides, "updated_by": "user-1"})


def code_of(call: Any) -> tuple[int, str]:
    with pytest.raises(ProblemError) as caught:
        call()
    return caught.value.status.value, caught.value.code


def test_with_no_override_the_config_file_is_what_runs_use(pg_url: str) -> None:
    s = settings(RunStore(pg_url), "constructor")
    view = s.view()
    validate("Settings", view)
    assert view["version"] == 0
    assert view["effective"] == view["config"] == CONFIG.as_json()
    assert view["overrides"] == dict.fromkeys(
        ("provider", "models", "max_calls", "max_extract_calls")
    )
    assert [p["available"] for p in view["providers"]] == [True, False, False]
    assert view["providers"][2]["reason"] == "OPENAI_KEY not set"
    assert "problem" not in view


def test_an_override_changes_what_runs_use_and_one_model_fills_all_three_roles(
    pg_url: str,
) -> None:
    s = settings(RunStore(pg_url), "constructor", "openai")
    view = update(s, 0, provider="openai", models=["gpt-5.4"], max_calls=600)
    validate("Settings", view)
    assert view["version"] == 1
    assert view["updated_by"] == "user-1"
    assert view["effective"] == {
        "provider": "openai",
        "models": ["gpt-5.4", "gpt-5.4", "gpt-5.4"],
        "max_calls": 600,
        "max_extract_calls": 100,
    }
    assert s.limits(Limits()).max_calls == 600
    # A null field goes back to the config file's value; the override is replaced as a whole.
    view = update(s, 1, provider="openai", models=None)
    assert view["effective"]["models"] == list(CONFIG.models)
    assert view["effective"]["max_calls"] == CONFIG.max_calls


def test_a_provider_without_its_key_is_refused_and_nothing_changes(pg_url: str) -> None:
    s = settings(RunStore(pg_url), "constructor")
    assert code_of(lambda: update(s, 0, provider="openai")) == (422, "provider_unavailable")
    assert s.view()["version"] == 0


@pytest.mark.parametrize(
    "overrides",
    [
        {"models": ["a", "b"]},
        {"models": ["bad model"]},
        {"max_calls": 0},
        {"max_calls": 2001},
        {"max_extract_calls": 501},
        {"max_calls": True},
    ],
)
def test_bad_values_are_refused(pg_url: str, overrides: dict[str, Any]) -> None:
    s = settings(RunStore(pg_url), "constructor")
    assert code_of(lambda: update(s, 0, **overrides)) == (422, "bad_settings")


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"overrides": {}},
        {"version": -1, "overrides": {}},
        {"version": 0, "overrides": {"api_key": "x"}},
        {"version": 0, "overrides": {}, "updated_by": "x" * 201},
        {"version": 0, "overrides": {}, "more": 1},
    ],
)
def test_a_malformed_update_is_400(pg_url: str, body: Any) -> None:
    s = settings(RunStore(pg_url), "constructor")
    assert code_of(lambda: s.update(body)) == (400, "bad_request")


def test_a_stale_version_is_409_and_the_other_write_stays(pg_url: str) -> None:
    store = RunStore(pg_url)
    first, second = settings(store, "constructor"), settings(store, "constructor")
    update(first, 0, max_calls=500)
    assert code_of(lambda: update(second, 0, max_calls=300)) == (409, "settings_conflict")
    second.reload()
    assert second.effective().max_calls == 500


def test_an_override_whose_key_is_gone_is_set_aside_at_start(pg_url: str) -> None:
    store = RunStore(pg_url)
    update(settings(store, "constructor", "openai"), 0, provider="openai")
    after_restart = settings(store, "constructor")  # the Secret lost the OpenAI key
    view = after_restart.view()
    assert view["effective"] == CONFIG.as_json()
    assert view["overrides"]["provider"] == "openai", "kept, so putting the key back restores it"
    assert "provider openai cannot be used" in view["problem"]


def body() -> dict[str, Any]:
    sha = hashlib.sha256(DOC.encode()).hexdigest()
    return {
        "product": "todo-app",
        "documents": [{"path": "specs/prd.md", "sha256": sha, "content": DOC}],
    }


def wait(m: RunManager, run_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        run = m.get(run_id)
        if run["state"] in TERMINAL:
            return run
        time.sleep(0.01)
    pytest.fail(f"run {run_id} did not end")


def test_a_run_keeps_the_settings_it_was_submitted_with(pg_url: str) -> None:
    store = RunStore(pg_url)
    s = settings(store, "constructor", "openai")
    m = RunManager(store, FakeRunner(0.01), Limits(), settings=s)
    first = m.submit("k1", body_digest(body()), body())
    update(s, 0, provider="openai", models=["gpt-5.4"])
    second = m.submit("k2", body_digest({**body(), "own_gears": []}), {**body(), "own_gears": []})
    one, two = wait(m, first["id"]), wait(m, second["id"])
    validate("Run", one)
    assert one["settings"] == {"provider": "constructor", "models": list(CONFIG.models)}
    assert two["settings"] == {"provider": "openai", "models": ["gpt-5.4"] * 3}
    m.shutdown()


def put(base: str, payload: Any) -> tuple[int, Any]:
    req = urllib.request.Request(  # noqa: S310 -- a local test server
        f"{base}/v1/settings",
        data=json.dumps(payload).encode(),
        method="PUT",
        headers={"Authorization": f"Bearer {SECRET}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 -- a local test server
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_the_routes_need_the_secret_and_info_follows_the_settings(pg_url: str) -> None:
    store = RunStore(pg_url)
    s = settings(store, "constructor", "openai")
    m = RunManager(store, FakeRunner(), Limits(), settings=s)
    with serve_app(create_app(m, SECRET, FakeRunner().info(), Limits(), s)) as base:
        assert get(f"{base}/v1/settings")[0] == 401
        status, view = get(f"{base}/v1/settings", secret=SECRET)
        assert (status, view["version"]) == (200, 0)
        status, view = put(
            base, {"version": 0, "overrides": {"provider": "openai", "max_calls": 50}}
        )
        assert (status, view["effective"]["provider"]) == (200, "openai")
        status, info = get(f"{base}/v1/info", secret=SECRET)
        validate("Info", info)
        assert (info["provider"], info["limits"]["max_calls"]) == ("openai", 50)
        status, problem = put(base, {"version": 0, "overrides": {}})
        assert (status, problem["code"]) == (409, "settings_conflict")
    m.shutdown()


def test_without_settings_the_routes_are_404_and_info_is_unchanged(pg_url: str) -> None:
    m = RunManager(RunStore(pg_url), FakeRunner(), Limits())
    with serve_app(create_app(m, SECRET, FakeRunner().info(), Limits())) as base:
        assert get(f"{base}/v1/settings", secret=SECRET)[0] == 404
        assert get(f"{base}/v1/info", secret=SECRET)[1]["models"] == ["fake"]
    m.shutdown()
