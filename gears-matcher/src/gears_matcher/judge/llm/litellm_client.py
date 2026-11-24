"""A `ModelClient` for Constructor's LiteLLM gateway, an OpenAI-compatible endpoint that works
without the VPN. It is `OpenAIClient` with its own settings (`LITELLM_*`), so it can sit beside the
OpenAI route and neither one's key or cache entries can be taken for the other's.

Models on the gateway: `glm-5.3-flash`, `deepseek-v4.1-flash-1017`, `deepseek-v4.1-flash`.
The key comes from the environment (a secret, never in the repository, a log or `repr`).
"""

from gears_matcher.judge.llm.constructor_client import MAX_TOKENS as _MAX_TOKENS
from gears_matcher.judge.llm.constructor_client import (
    Temperature,
    effective_temperature,
)
from gears_matcher.judge.llm.errors import (
    ClientError,
    MissingConfigError,
    ModelRefusedError,
    ProviderError,
    ReplyCutOffError,
)
from gears_matcher.judge.llm.openai_client import OpenAIClient

__all__ = [
    "BASE_URL_VARIABLE",
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL",
    "KEY_VARIABLE",
    "SETTING_VARIABLES",
    "ClientError",
    "LiteLLMClient",
    "MissingConfigError",
    "ModelRefusedError",
    "ProviderError",
    "ReplyCutOffError",
    "label",
]

KEY_VARIABLE = "LITELLM_API_KEY"
BASE_URL_VARIABLE = "LITELLM_BASE_URL"
MODEL_VARIABLE = "LITELLM_MODEL"
SETTING_VARIABLES = (KEY_VARIABLE, BASE_URL_VARIABLE, MODEL_VARIABLE)

DEFAULT_BASE_URL = "https://litellm.ext.constr.dev/v1"
DEFAULT_MODEL = "glm-5.3-flash"  # deepseek-v4.1-flash took 104 s for one whole-catalogue call


def label(
    model: str = DEFAULT_MODEL, *, max_tokens: int | None = None, temperature: Temperature = "auto"
) -> str:
    """What identifies this client's settings in the cache key (see `openai_client.label`)."""
    max_tokens = _MAX_TOKENS if max_tokens is None else max_tokens
    sent = effective_temperature(model, temperature)
    shown = "default" if sent is None else f"{sent:g}"
    return f"litellm/{model}/t{shown}/max{max_tokens}/json-prompt-v1"


class LiteLLMClient(OpenAIClient):
    """`ModelClient` for the LiteLLM gateway."""

    _key_variable = KEY_VARIABLE
    _base_url_variable = BASE_URL_VARIABLE
    _model_variable = MODEL_VARIABLE
    _default_base_url = DEFAULT_BASE_URL
    _default_model = DEFAULT_MODEL
