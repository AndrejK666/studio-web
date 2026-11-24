"""The LiteLLM `ModelClient`, on a mock transport: no network, no real key."""

import json
import os
from typing import Any

import httpx2
import pytest

from gears_matcher.judge.llm import litellm_client as lc
from gears_matcher.judge.llm.litellm_client import LiteLLMClient, MissingConfigError, label
from gears_matcher.judge.llm.run import (
    default_model,
    load_env_file,
    provider_module,
    selected_provider,
)

KEY = "not-a-real-key-SENTINEL"  # a sentinel, not a credential


@pytest.fixture(autouse=True)
def settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*lc.SETTING_VARIABLES, "OPENAI_API_KEY", "GEARS_MATCHER_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LITELLM_API_KEY", KEY)


def make(**kw: Any) -> tuple[LiteLLMClient, list[httpx2.Request]]:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        body = {
            "choices": [{"message": {"content": '{"judgements": []}'}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2},
        }
        return httpx2.Response(200, json=body)

    return LiteLLMClient(http=httpx2.Client(transport=httpx2.MockTransport(handler)), **kw), seen


def test_request_goes_to_the_gateway_with_its_default_model() -> None:
    client, seen = make()
    out = client.complete(system="s", user="u", schema={}, timeout_s=5.0)
    (request,) = seen
    assert str(request.url) == "https://litellm.ext.constr.dev/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert body["model"] == "glm-5.3-flash"
    assert "max_tokens" in body
    assert (out.input_tokens, out.output_tokens) == (5, 2)
    assert KEY not in repr(client)
    assert "LiteLLMClient" in repr(client)


def test_the_openai_key_is_not_used_and_the_message_names_the_litellm_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LITELLM_API_KEY")
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    with pytest.raises(MissingConfigError, match="LITELLM_API_KEY"):
        LiteLLMClient()


def test_base_url_must_be_https_and_names_its_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LITELLM_BASE_URL", "http://gw.example.test/v1")
    with pytest.raises(MissingConfigError, match="LITELLM_BASE_URL"):
        LiteLLMClient()


def test_provider_selection_and_model_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEARS_MATCHER_PROVIDER", "LiteLLM")
    assert selected_provider() == "litellm"
    module = provider_module("litellm")
    assert default_model("litellm", module) == "glm-5.3-flash"
    monkeypatch.setenv("LITELLM_MODEL", "deepseek-v4.1-flash-1017")
    assert default_model("litellm", module) == "deepseek-v4.1-flash-1017"


def test_label_is_its_own_cache_namespace() -> None:
    assert label("glm-5.3-flash") == "litellm/glm-5.3-flash/t0/max8192/json-prompt-v1"


def test_the_env_file_may_set_the_litellm_names(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `load_env_file` writes the real environment: an empty value is "unset" to it, and `setenv`
    # remembers that nothing was there, so the names are removed again at teardown.
    monkeypatch.setenv("LITELLM_API_KEY", "")
    monkeypatch.setenv("GEARS_MATCHER_PROVIDER", "")
    env = tmp_path / ".env"
    env.write_text("LITELLM_API_KEY=abc\nGEARS_MATCHER_PROVIDER=litellm\n")
    load_env_file(env)
    assert os.environ["LITELLM_API_KEY"] == "abc"
