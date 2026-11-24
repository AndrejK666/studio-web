"""A `ModelClient` for any OpenAI-compatible `chat/completions` endpoint: OpenAI itself by default,
or another gateway through `OPENAI_BASE_URL`.

It asks the way `ConstructorClient` does (JSON requested in the system prompt, the judge validates
and repairs the reply once), so the two providers differ only in the endpoint and the credentials.
The key comes from the environment, is never logged, never in an error message and never in `repr`.
"""

import json
import os
import time
from urllib.parse import urlsplit

import httpx2

from gears_matcher.judge.llm import retry
from gears_matcher.judge.llm.constructor_client import (
    _CONTROL,
    DETAIL_LIMIT,
    ERROR_FROM,
    FORMAT_INSTRUCTION,
    MAX_TOKENS,
    Temperature,
    effective_temperature,
    json_text,
)
from gears_matcher.judge.llm.errors import (
    ClientError,
    MissingConfigError,
    ModelRefusedError,
    ProviderError,
    ReplyCutOffError,
)
from gears_matcher.judge.llm.judge import SDK_RETRIES
from gears_matcher.judge.llm.schema import ModelOutput

__all__ = [
    "BASE_URL_VARIABLE",
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL",
    "KEY_VARIABLE",
    "MAX_TOKENS",
    "SETTING_VARIABLES",
    "ClientError",
    "MissingConfigError",
    "ModelRefusedError",
    "OpenAIClient",
    "ProviderError",
    "ReplyCutOffError",
    "default_max_tokens",
    "label",
]

KEY_VARIABLE = "OPENAI_API_KEY"
BASE_URL_VARIABLE = "OPENAI_BASE_URL"
MODEL_VARIABLE = "OPENAI_MODEL"
SETTING_VARIABLES = (KEY_VARIABLE, BASE_URL_VARIABLE, MODEL_VARIABLE)

# A gateway such as LiteLLM answers 499 ("closed request") when its own call upstream was cut off.
# The same call usually works when sent again (a run where about one check in three got it).
_RETRY_STATUSES = retry.RETRY_STATUSES | {499}

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-5.4"


REASONING_PREFIXES = ("gpt-5.5", "gpt-5.6", "gpt-6", "o1", "o3", "o4")
REASONING_MAX_TOKENS = 32768  # hidden reasoning counts against the cap (run E used this)


def default_max_tokens(model: str) -> int:
    """The reply cap: the shared one, or a larger one for models that reason before they answer."""
    return REASONING_MAX_TOKENS if model.lower().startswith(REASONING_PREFIXES) else MAX_TOKENS


def label(
    model: str = DEFAULT_MODEL, *, max_tokens: int | None = None, temperature: Temperature = "auto"
) -> str:
    """What identifies this client's settings in the cache key: another model, other settings or
    another endpoint's way of asking must not share a cache entry with this one."""
    max_tokens = default_max_tokens(model) if max_tokens is None else max_tokens
    sent = effective_temperature(model, temperature)
    shown = "default" if sent is None else f"{sent:g}"
    return f"openai/{model}/t{shown}/max{max_tokens}/json-prompt-v1"


def _base_url(raw: str, variable: str = BASE_URL_VARIABLE, default: str = DEFAULT_BASE_URL) -> str:
    """The endpoint's base: https only (a key must not travel in clear), no query or fragment."""
    url = raw.strip().rstrip("/")
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.query or parts.fragment:
        raise MissingConfigError(
            f"{variable} must be an https URL with no query or fragment (default {default})"
        )
    return url


class OpenAIClient:
    """`ModelClient` for an OpenAI-compatible endpoint.

    A gateway with its own settings (the LiteLLM one) subclasses this and changes only the names
    below: the three variables, the default endpoint and the default model."""

    _key_variable = KEY_VARIABLE
    _base_url_variable = BASE_URL_VARIABLE
    _model_variable = MODEL_VARIABLE
    _default_base_url = DEFAULT_BASE_URL
    _default_model = DEFAULT_MODEL

    def __init__(
        self,
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: Temperature = "auto",
        http: httpx2.Client | None = None,
    ) -> None:
        env = os.environ
        key, base, chosen = (
            env.get(name, "").strip()
            for name in (self._key_variable, self._base_url_variable, self._model_variable)
        )
        if not key:
            raise MissingConfigError(
                f"{self._key_variable} not set: export it in your shell or put it in .env"
            )
        self._secret = key
        self._model = model or chosen or self._default_model
        self._max_tokens = default_max_tokens(self._model) if max_tokens is None else max_tokens
        self._temperature = effective_temperature(self._model, temperature)
        self._url = (
            _base_url(
                base or self._default_base_url, self._base_url_variable, self._default_base_url
            )
            + "/chat/completions"
        )
        self._http = http or httpx2.Client()

    @property
    def model(self) -> str:
        return self._model

    def __repr__(self) -> str:
        return f"{type(self).__name__}(model={self._model!r}, api_key=<set>)"

    def complete(
        self, *, system: str, user: str, schema: dict[str, object], timeout_s: float
    ) -> ModelOutput:
        instruction = FORMAT_INSTRUCTION + json.dumps(schema, separators=(",", ":"))
        response = self._post(self._body(f"{system}\n\n{instruction}", user), timeout_s)
        try:
            document = response.json()
            choice = document["choices"][0]
            finish = choice.get("finish_reason")
            content = choice["message"]["content"]
            usage = document.get("usage") or {}
            tokens = (
                int(usage.get("prompt_tokens") or 0),
                int(usage.get("completion_tokens") or 0),
            )
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError(f"unexpected response shape ({type(exc).__name__})") from None
        if finish == "content_filter":
            raise ModelRefusedError(
                "the endpoint filtered the reply (finish_reason content_filter)"
            )
        if finish == "length":
            raise ReplyCutOffError(f"the reply was cut off at max_tokens={self._max_tokens}")
        if not isinstance(content, str) or not content.strip():
            raise ProviderError("the response has no text")
        return ModelOutput(text=json_text(content), input_tokens=tokens[0], output_tokens=tokens[1])

    def _body(self, system: str, user: str) -> dict[str, object]:
        body: dict[str, object] = {
            "model": self._model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        if self._model.lower().startswith(("gpt-5", "o1", "o3", "o4")):
            # Reasoning models take max_completion_tokens; hidden reasoning counts against it.
            body["max_completion_tokens"] = max(self._max_tokens, 2000)
        else:
            body["max_tokens"] = self._max_tokens
        if self._temperature is not None:
            body["temperature"] = self._temperature
        return body

    def _post(self, body: dict[str, object], timeout_s: float) -> httpx2.Response:
        """One POST, retried on a transport error or a busy endpoint (`SDK_RETRIES` at most)."""
        headers = {"Authorization": f"Bearer {self._secret}"}
        last = "no attempt was made"
        for attempt in range(SDK_RETRIES + 1):
            if attempt:
                time.sleep(retry.pause_before(attempt))
            try:
                response = self._http.post(self._url, headers=headers, json=body, timeout=timeout_s)
            except httpx2.TransportError as exc:
                last = f"{type(exc).__name__} (no response)"
                continue
            if response.status_code in _RETRY_STATUSES:
                last = f"HTTP {response.status_code}: {response.text}"
                continue
            if response.status_code >= ERROR_FROM:
                raise ProviderError(self._scrub(f"HTTP {response.status_code}: {response.text}"))
            return response
        raise ProviderError(self._scrub(f"{last}, after {SDK_RETRIES + 1} attempts"))

    def _scrub(self, text: str) -> str:
        """No key in any message: the exact key removed, one line, short."""
        text = text.replace(self._secret, "[redacted]")
        text = _CONTROL.sub(" ", text)
        text = " ".join(text.split())
        return text if len(text) <= DETAIL_LIMIT else text[: DETAIL_LIMIT - 1] + "…"
