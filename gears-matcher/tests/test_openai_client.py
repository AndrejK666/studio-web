"""The OpenAI-compatible `ModelClient`, on a mock transport: no network, no real key."""

import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest

from gears_matcher import run as runs
from gears_matcher.judge.llm import ModelReply
from gears_matcher.judge.llm import openai_client as oc
from gears_matcher.judge.llm.openai_client import (
    MissingConfigError,
    OpenAIClient,
    ProviderError,
    ReplyCutOffError,
    label,
)
from gears_matcher.judge.llm.run import RunError, default_model, provider_module, selected_provider

KEY = "not-a-real-key-SENTINEL"  # a sentinel, not a credential
Handler = Callable[[httpx2.Request], httpx2.Response]


@pytest.fixture(autouse=True)
def settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*oc.SETTING_VARIABLES, "GEARS_MATCHER_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", KEY)
    monkeypatch.setattr(f"{oc.__name__}.time.sleep", lambda seconds: None)


def completion(content: str = '{"judgements": []}', finish: str = "stop") -> dict[str, Any]:
    return {
        "choices": [{"message": {"content": content}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 12, "completion_tokens": 3},
    }


def client_for(handler: Handler, **kw: Any) -> tuple[OpenAIClient, list[httpx2.Request]]:
    seen: list[httpx2.Request] = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return handler(request)

    return OpenAIClient(http=httpx2.Client(transport=httpx2.MockTransport(record)), **kw), seen


def call(client: OpenAIClient) -> Any:
    return client.complete(
        system="sys", user="usr", schema=ModelReply.model_json_schema(), timeout_s=5.0
    )


def ok(body: dict[str, Any] | None = None) -> Handler:
    return lambda request: httpx2.Response(200, json=body or completion())


def test_gpt_5_request_uses_bearer_key_completion_tokens_and_no_temperature() -> None:
    client, seen = client_for(ok(), model="gpt-5.4")
    out = call(client)
    (request,) = seen
    assert str(request.url) == "https://api.openai.com/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert body["model"] == "gpt-5.4"
    assert body["max_completion_tokens"] >= 2000
    assert not {"temperature", "max_tokens", "tools", "stream"} & body.keys()
    assert KEY not in request.content.decode()
    assert (out.input_tokens, out.output_tokens) == (12, 3)


def test_a_classic_model_takes_max_tokens_and_temperature_zero() -> None:
    client, seen = client_for(ok(), model="gpt-4.1")
    call(client)
    body = json.loads(seen[0].content)
    assert body["max_tokens"] == oc.MAX_TOKENS
    assert body["temperature"] == 0
    assert "max_completion_tokens" not in body


def test_base_url_is_configurable_but_only_https(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", "https://gw.example.test/openai/v1/")
    client, seen = client_for(ok())
    call(client)
    assert str(seen[0].url) == "https://gw.example.test/openai/v1/chat/completions"
    monkeypatch.setenv("OPENAI_BASE_URL", "http://gw.example.test/v1")
    with pytest.raises(MissingConfigError):
        OpenAIClient()


def test_a_missing_key_names_the_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY")
    with pytest.raises(MissingConfigError, match="OPENAI_API_KEY"):
        OpenAIClient()


def test_fenced_json_is_unwrapped() -> None:
    client, _ = client_for(ok(completion('```json\n{"judgements": []}\n```')))
    assert call(client).text == '{"judgements": []}'


def test_length_and_http_errors_are_typed_and_the_key_is_scrubbed() -> None:
    client, _ = client_for(ok(completion(finish="length")))
    with pytest.raises(ReplyCutOffError):
        call(client)
    bad, _ = client_for(lambda r: httpx2.Response(401, text=f"bad key {KEY}"))
    with pytest.raises(ProviderError) as info:
        call(bad)
    assert KEY not in str(info.value)
    assert KEY not in repr(bad)


def test_a_busy_endpoint_is_retried_then_succeeds() -> None:
    replies = [httpx2.Response(429, text="slow down"), httpx2.Response(200, json=completion())]
    client, seen = client_for(lambda r: replies.pop(0))
    call(client)
    assert len(seen) == 2


def test_label_separates_model_and_provider_in_the_cache_key() -> None:
    assert label("gpt-5.4") == "openai/gpt-5.4/tdefault/max8192/json-prompt-v1"
    assert label("gpt-4.1").startswith("openai/gpt-4.1/t0/")


def test_provider_selection_by_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    assert selected_provider() == "constructor"
    monkeypatch.setenv("GEARS_MATCHER_PROVIDER", "OpenAI")
    assert selected_provider() == "openai"
    assert default_model("openai", provider_module("openai")) == "gpt-5.4"
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4-mini")
    assert default_model("openai", provider_module("openai")) == "gpt-5.4-mini"
    monkeypatch.setenv("GEARS_MATCHER_PROVIDER", "nope")
    with pytest.raises(RunError):
        selected_provider()


def test_verified_models_can_be_one_id_for_all_three(monkeypatch: pytest.MonkeyPatch) -> None:
    assert runs.verified_models() == runs.VERIFIED_MODELS
    monkeypatch.setenv("GEARS_MATCHER_VERIFIED_MODELS", "gpt-5.4")
    assert runs.verified_models() == ("gpt-5.4",) * 3
    monkeypatch.setenv("GEARS_MATCHER_VERIFIED_MODELS", "a, b")
    with pytest.raises(ValueError, match="one model id or three"):
        runs.verified_models()


def test_a_reasoning_model_gets_a_larger_reply_cap_in_the_request_and_the_label() -> None:
    assert oc.default_max_tokens("gpt-5.4") == oc.MAX_TOKENS
    assert oc.default_max_tokens("gpt-5.5") == oc.REASONING_MAX_TOKENS
    assert label("gpt-5.5") == "openai/gpt-5.5/tdefault/max32768/json-prompt-v1"
    client, seen = client_for(ok(), model="gpt-5.5")
    call(client)
    assert json.loads(seen[0].content)["max_completion_tokens"] == oc.REASONING_MAX_TOKENS


def test_a_gateways_499_is_retried_then_succeeds() -> None:
    replies = [httpx2.Response(499, text=""), httpx2.Response(200, json=completion())]
    client, seen = client_for(lambda r: replies.pop(0))
    call(client)
    assert len(seen) == 2
