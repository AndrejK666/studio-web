"""A run may choose its connection (`options.provider`), and with it a fixed set of three models.

Constructor's connector is not one of a run's choices: it works only inside the VPN. The service's
settings (`/v1/settings`) may still choose it for every run. A run's own choice wins over them.
"""

import hashlib
from typing import Any

import pytest

from gears_matcher.judge.llm.run import PROVIDERS as KNOWN
from gears_matcher.service.errors import ProblemError
from gears_matcher.service.request import RUN_PROVIDERS, Limits, RunRequest, parse_request
from gears_matcher.service.settings import Settings, Values

LIMITS = Limits()
TEXT = "# PRD\n\n- Users can sign in.\n"
CONFIG = Values("constructor", ("claude-sonnet-4-6", "claude-opus-5", "gpt-5.4"), 400, 100)


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

    return Settings(CONFIG, tuple(KNOWN), check)


def test_each_connection_has_its_measured_models() -> None:
    assert RUN_PROVIDERS == {
        "litellm": ("glm-5.3-flash",) * 3,
        "openai": ("gpt-5.4", "gpt-5.5", "gpt-5.4"),
    }
    request = parse_request(body(provider="litellm"), LIMITS)
    assert (request.provider, request.models, request.chosen) == (
        "litellm",
        ("glm-5.3-flash",) * 3,
        True,
    )


def test_no_choice_leaves_the_services_settings() -> None:
    request = parse_request(body(), LIMITS)
    assert (request.provider, request.models, request.chosen) == (None, None, False)


def test_constructor_and_unknown_providers_are_refused() -> None:
    for name in ("constructor", "anthropic", "nope"):
        error = refused(lambda n=name: parse_request(body(provider=n), LIMITS))
        assert error.code == "unknown_provider"


def test_a_request_cannot_name_a_model() -> None:
    error = refused(lambda: parse_request(body(provider="litellm", model="x"), LIMITS))
    assert error.status.value == 400


def test_the_choice_survives_storage() -> None:
    request = parse_request(body(provider="openai"), LIMITS)
    again = RunRequest.from_json(request.to_json())
    assert (again.provider, again.models) == (request.provider, request.models)


def test_a_provider_without_a_key_is_refused_before_anything_is_stored() -> None:
    error = refused(lambda: settings("openai").for_run("litellm", RUN_PROVIDERS["litellm"]))
    assert (error.status.value, error.code) == (422, "provider_unavailable")
    assert "LITELLM_API_KEY" in error.detail


def test_a_run_choice_wins_over_the_settings_but_not_their_bounds() -> None:
    s = settings("constructor", "litellm")
    assert s.for_run(None, None) == CONFIG
    chosen = s.for_run("litellm", RUN_PROVIDERS["litellm"])
    assert (chosen.provider, chosen.models) == ("litellm", ("glm-5.3-flash",) * 3)
    assert (chosen.max_calls, chosen.max_extract_calls) == (CONFIG.max_calls, 100)


def test_info_says_which_providers_have_a_key_and_their_models() -> None:
    providers = {p["code"]: p for p in settings("litellm").providers_view()}
    assert providers["litellm"] == {
        "code": "litellm",
        "configured": True,
        "models": ["glm-5.3-flash"] * 3,
    }
    assert providers["openai"]["configured"] is False
    assert "constructor" not in providers
