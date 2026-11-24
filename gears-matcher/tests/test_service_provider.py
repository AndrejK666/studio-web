"""A run may choose its connection and model (`options.provider`, `options.model`).

Constructor's connector is not one of the choices: it works only inside the VPN.
"""

import hashlib
from pathlib import Path
from typing import Any

import pytest

from gears_matcher.catalogue.models import Catalogue
from gears_matcher.service.errors import ProblemError
from gears_matcher.service.request import PROVIDERS, Document, Limits, RunRequest, parse_request
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


def test_a_run_may_choose_litellm_or_openai_and_a_model() -> None:
    assert PROVIDERS == ("litellm", "openai")
    request = parse_request(body(provider="litellm", model="deepseek-v4.1-flash-1017"), LIMITS)
    assert (request.provider, request.model) == ("litellm", "deepseek-v4.1-flash-1017")
    assert parse_request(body(provider="openai"), LIMITS).model is None


def test_no_choice_leaves_the_services_own_default() -> None:
    request = parse_request(body(), LIMITS)
    assert (request.provider, request.model) == (None, None)


def test_constructor_and_unknown_providers_are_refused() -> None:
    for name in ("constructor", "anthropic", "nope"):
        assert refused(provider=name).code == "unknown_provider"
    assert refused(model="gpt-5.4").code == "unknown_provider"  # a model needs its provider


def test_a_model_must_be_a_model_id() -> None:
    assert refused(provider="litellm", model="bad model!").status.value == 400
    assert refused(provider="litellm", model="").status.value == 400


def test_the_choice_survives_storage_and_an_older_stored_run_has_none() -> None:
    request = parse_request(body(provider="openai", model="gpt-5.4"), LIMITS)
    assert RunRequest.from_json(request.to_json()) == request
    old = request.to_json()
    del old["options"]["provider"], old["options"]["model"]
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


def test_a_run_builds_the_chosen_models_once_and_uses_one_model_for_all_roles(
    tmp_path: Path, fixture_catalogue: Catalogue, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_API_KEY", "not-a-real-key")
    runner = make_runner(tmp_path, fixture_catalogue)
    chosen = runner._models(request(provider="litellm", model="deepseek-v4.1-flash-1017"))
    assert chosen is not None
    models, factory = chosen
    assert models == ("deepseek-v4.1-flash-1017",) * 3
    label, client = factory("deepseek-v4.1-flash-1017")
    assert label.startswith("litellm/deepseek-v4.1-flash-1017/")
    assert factory("deepseek-v4.1-flash-1017")[1] is client
    default_models, _ = runner._models(request(provider="litellm"))  # type: ignore[misc]
    assert default_models == ("glm-5.3-flash",) * 3
    assert runner._models(request()) is None


def test_info_says_which_providers_have_a_key(
    tmp_path: Path, fixture_catalogue: Catalogue, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_API_KEY", "not-a-real-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    providers = {p["code"]: p for p in make_runner(tmp_path, fixture_catalogue).info()["providers"]}
    assert providers["litellm"] == {
        "code": "litellm",
        "configured": True,
        "default_model": "glm-5.3-flash",
    }
    assert providers["openai"]["configured"] is False
    assert "constructor" not in providers
