"""A run may choose its connection (`options.provider`), and each connection has one fixed
combination of models: the ones that were measured. Constructor's connector is not a choice: it
works only inside the VPN.
"""

import hashlib
from pathlib import Path
from typing import Any

import pytest

from gears_matcher.catalogue.models import Catalogue
from gears_matcher.service.errors import ProblemError
from gears_matcher.service.request import (
    PROVIDER_MODELS,
    PROVIDERS,
    Document,
    Limits,
    RunRequest,
    parse_request,
)
from gears_matcher.service.runner import RealRunner

LIMITS = Limits()
TEXT = "# PRD\n\n- Users can sign in.\n"


def body(**options: Any) -> dict[str, Any]:
    digest = hashlib.sha256(TEXT.encode()).hexdigest()
    return {
        "product": "todo-app",
        "documents": [{"path": "PRD.md", "sha256": digest, "content": TEXT}],
        "options": options,
    }


def refused(**options: Any) -> ProblemError:
    with pytest.raises(ProblemError) as caught:
        parse_request(body(**options), LIMITS)
    return caught.value


def test_the_combinations_are_the_measured_ones() -> None:
    assert PROVIDERS == ("litellm", "openai")
    assert PROVIDER_MODELS["litellm"] == ("glm-5.3-flash",) * 3
    assert PROVIDER_MODELS["openai"] == ("gpt-5.4", "gpt-5.5", "gpt-5.4")


def test_a_run_may_choose_litellm_or_openai() -> None:
    assert parse_request(body(provider="litellm"), LIMITS).provider == "litellm"
    assert parse_request(body(provider="openai"), LIMITS).provider == "openai"


def test_no_choice_leaves_the_services_own_default() -> None:
    assert parse_request(body(), LIMITS).provider is None


def test_constructor_and_unknown_providers_are_refused() -> None:
    for name in ("constructor", "anthropic", "nope", ""):
        assert refused(provider=name).code == "unknown_provider"


def test_a_run_cannot_name_a_model() -> None:
    assert refused(provider="litellm", model="deepseek-v4.1-flash").status.value == 400
    assert refused(model="gpt-5.4").status.value == 400


def test_the_choice_survives_storage_and_an_older_stored_run_has_none() -> None:
    request = parse_request(body(provider="openai"), LIMITS)
    assert RunRequest.from_json(request.to_json()) == request
    old = request.to_json()
    del old["options"]["provider"]
    assert RunRequest.from_json(old).provider is None


def make_runner(tmp_path: Path, catalogue: Catalogue) -> RealRunner:
    def never(name: str) -> Any:
        raise AssertionError("the default factory is not for a run that chose its own")

    return RealRunner(catalogue, never, tmp_path / "cache", tmp_path / "work")


def request(**more: Any) -> RunRequest:
    doc = Document("PRD.md", hashlib.sha256(TEXT.encode()).hexdigest(), TEXT)
    return RunRequest(product="todo-app", documents=(doc,), **more)


def test_a_provider_without_a_key_is_refused_before_anything_is_stored(
    tmp_path: Path, fixture_catalogue: Catalogue, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("LITELLM_API_KEY", raising=False)
    with pytest.raises(ProblemError) as caught:
        make_runner(tmp_path, fixture_catalogue).preflight(request(provider="litellm"))
    assert caught.value.code == "provider_unavailable"


def test_a_run_uses_its_providers_combination_with_clients_built_once(
    tmp_path: Path, fixture_catalogue: Catalogue, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_API_KEY", "not-a-real-key")
    monkeypatch.setenv("OPENAI_API_KEY", "not-a-real-key")
    runner = make_runner(tmp_path, fixture_catalogue)
    chosen = runner._models(request(provider="litellm"))
    assert chosen is not None
    models, factory = chosen
    assert models == ("glm-5.3-flash",) * 3
    label, client = factory("glm-5.3-flash")
    assert label.startswith("litellm/glm-5.3-flash/")
    assert factory("glm-5.3-flash")[1] is client
    openai = runner._models(request(provider="openai"))
    assert openai is not None
    assert openai[0] == ("gpt-5.4", "gpt-5.5", "gpt-5.4")
    assert openai[1]("gpt-5.5")[0].startswith("openai/gpt-5.5/")
    assert runner._models(request()) is None


def test_info_lists_each_provider_with_its_models_and_whether_it_has_a_key(
    tmp_path: Path, fixture_catalogue: Catalogue, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_API_KEY", "not-a-real-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    info = make_runner(tmp_path, fixture_catalogue).info()
    providers = {p["code"]: p for p in info["providers"]}
    assert providers["litellm"] == {
        "code": "litellm",
        "configured": True,
        "models": ["glm-5.3-flash"] * 3,
    }
    assert providers["openai"]["configured"] is False
    assert providers["openai"]["models"] == ["gpt-5.4", "gpt-5.5", "gpt-5.4"]
    assert "constructor" not in providers
