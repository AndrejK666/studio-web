"""A run may choose its connection and model (`options.provider`, `options.model`).

Constructor's connector is not one of a run's choices: it works only inside the VPN. The service's
settings (`/v1/settings`) may still choose it for every run. A run's own choice wins over them.
"""

import hashlib
from typing import Any

import pytest

from gears_matcher.judge.llm.run import PROVIDERS as KNOWN
from gears_matcher.judge.llm.run import default_model, provider_module
from gears_matcher.service.errors import ProblemError
from gears_matcher.service.request import RUN_PROVIDERS, Limits, RunRequest, parse_request
from gears_matcher.service.settings import Settings, Values

LIMITS = Limits()
TEXT = "# PRD\n\n- Users can sign in.\n"
CONFIG = Values("openai", ("gpt-5.4", "gpt-5.5", "gpt-5.4"), 400, 100)


def body(**options: Any) -> dict[str, Any]:
    digest = hashlib.sha256(TEXT.encode()).hexdigest()
    return {
        "product": "todo-app",
        "documents": [{"path": "PRD.md", "sha256": digest, "content": TEXT}],
        "options": options,
    }


def refused(call: Any) -> ProblemError:
    with pytest.raises(ProblemError) as caught:
        call()
    return caught.value


def settings(*present: str) -> Settings:
    """Settings without a store; `present` are the providers whose key the service holds."""

    def check(provider: str) -> str | None:
        return None if provider in present else f"{provider.upper()}_API_KEY not set"

    return Settings(
        CONFIG,
        tuple(KNOWN),
        check,
        default_model=lambda p: default_model(p, provider_module(p)),
    )


def test_a_run_may_choose_litellm_or_openai_and_a_model() -> None:
    assert RUN_PROVIDERS == ("litellm", "openai")
    request = parse_request(body(provider="litellm", model="deepseek-v4.1-flash-1017"), LIMITS)
    assert request.provider == "litellm"
    assert request.models == ("deepseek-v4.1-flash-1017",) * 3
    assert request.chosen
    assert parse_request(body(provider="openai"), LIMITS).models is None


def test_no_choice_leaves_the_services_settings() -> None:
    request = parse_request(body(), LIMITS)
    assert (request.provider, request.models, request.chosen) == (None, None, False)


def test_constructor_and_unknown_providers_are_refused() -> None:
    for name in ("constructor", "anthropic", "nope"):
        assert refused(lambda n=name: parse_request(body(provider=n), LIMITS)).code == (
            "unknown_provider"
        )
    # a model needs its provider
    assert refused(lambda: parse_request(body(model="gpt-5.4"), LIMITS)).code == "unknown_provider"


def test_a_model_must_be_a_model_id() -> None:
    for model in ("bad model!", ""):
        error = refused(lambda m=model: parse_request(body(provider="litellm", model=m), LIMITS))
        assert error.status.value == 400


def test_the_choice_survives_storage() -> None:
    request = parse_request(body(provider="openai", model="gpt-5.4"), LIMITS)
    again = RunRequest.from_json(request.to_json())
    assert (again.provider, again.models) == (request.provider, request.models)


def test_a_provider_without_a_key_is_refused_before_anything_is_stored() -> None:
    error = refused(lambda: settings("openai").for_run("litellm", None))
    assert (error.status.value, error.code) == (422, "provider_unavailable")
    assert "LITELLM_API_KEY" in error.detail


def test_a_run_choice_wins_over_the_settings() -> None:
    s = settings("openai", "litellm")
    assert s.for_run(None, None) == CONFIG
    chosen = s.for_run("litellm", ("deepseek-v4.1-flash-1017",) * 3)
    assert (chosen.provider, chosen.models) == ("litellm", ("deepseek-v4.1-flash-1017",) * 3)
    assert chosen.max_calls == CONFIG.max_calls  # the bounds stay the settings'
    # no model: another provider's default for all three roles, the same provider's settings
    assert s.for_run("litellm", None).models == ("glm-5.3-flash",) * 3
    assert s.for_run("openai", None).models == CONFIG.models


def test_info_says_which_providers_have_a_key() -> None:
    providers = {p["code"]: p for p in settings("litellm").providers_view()}
    assert providers["litellm"] == {
        "code": "litellm",
        "configured": True,
        "default_model": "glm-5.3-flash",
    }
    assert providers["openai"]["configured"] is False
