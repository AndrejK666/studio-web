"""The settings an operator may change while the service runs (`GET`/`PUT /v1/settings`).

Which provider a run uses, its three models (candidates 1, candidates 2, checks) and the per-run
call bounds. The config file (`[llm] provider`, `[llm] models`, `GEARS_MATCHER_MAX_CALLS`,
`GEARS_MATCHER_MAX_EXTRACT_CALLS`) says what they are by default; an override, stored in the run
store, replaces one or more of them until it is cleared. Studio sets an override from its portal.

**Keys are never settings.** They stay in the config file, the operator's Secret (ADR-0075 §6): an
override may choose only a provider whose key the service already has (its client can be built,
which sends nothing).

An override is validated when it is written and again when the service starts: one that can no
longer be used (its provider's key was removed from the Secret) is set aside, the config file's
values are used instead, and `problem` says why. Every run keeps the provider and models it was
submitted with, so a change never alters a run that is queued or running.
"""

import re
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from http import HTTPStatus
from typing import Any, Protocol

from gears_matcher.service.errors import ProblemError, bad_request, unprocessable
from gears_matcher.service.request import Limits

MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")
UPDATED_BY_MAX = 200
# The most an override may raise the bounds to; the config file may set more.
MAX_CALLS_CEILING = 2000
MAX_EXTRACT_CALLS_CEILING = 500
FIELDS = ("provider", "models", "max_calls", "max_extract_calls")


@dataclass(frozen=True)
class Values:
    """What a run uses."""

    provider: str
    models: tuple[str, str, str]
    max_calls: int
    max_extract_calls: int

    def as_json(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "models": list(self.models),
            "max_calls": self.max_calls,
            "max_extract_calls": self.max_extract_calls,
        }


class Stored(Protocol):
    """Where the override lives (the run store)."""

    def read_settings(self) -> dict[str, Any] | None: ...

    def write_settings(
        self, overrides: dict[str, Any], expected: int, updated_by: str | None, now: float
    ) -> dict[str, Any] | None: ...


# A provider's availability: None when its key and settings are there, else why not (never a value).
ProviderCheck = Callable[[str], str | None]


class SettingsError(Exception):
    """An override cannot be used; the message says which field and why."""


def models_of(value: Any) -> tuple[str, str, str]:
    """One model id for all three roles, or three; anything else is refused."""
    if not isinstance(value, list) or len(value) not in (1, 3):
        raise SettingsError("models takes one model id or three")
    if not all(isinstance(m, str) and MODEL_ID.match(m) for m in value):
        raise SettingsError(
            "a model id is 1-100 of A-Za-z0-9._:/- and starts with a letter or digit"
        )
    if len(value) == 1:
        return (value[0], value[0], value[0])
    return (value[0], value[1], value[2])


def _bound(value: Any, name: str, ceiling: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise SettingsError(f"{name} must be a positive integer")
    if value > ceiling:
        raise SettingsError(f"{name} is over the ceiling of {ceiling}")
    return value


class Settings:
    """The config file's values, the stored override, and what a run uses now."""

    def __init__(  # noqa: PLR0913 -- the last three are optional
        self,
        config: Values,
        providers: tuple[str, ...],
        check: ProviderCheck,
        store: Stored | None = None,
        clock: Callable[[], float] = time.time,
        *,
        default_model: Callable[[str], str] | None = None,
    ) -> None:
        self.config, self.providers, self.check, self.store, self.clock = (
            config,
            providers,
            check,
            store,
            clock,
        )
        self.default_model = default_model
        self._lock = threading.Lock()
        self._overrides: dict[str, Any] = {}
        self._version = 0
        self._updated_at: float | None = None
        self._updated_by: str | None = None
        self._problem: str | None = None
        self._effective = config
        self.reload()

    # --- reading

    def reload(self) -> None:
        """Read the stored override and settle what a run uses (at start, and after a write)."""
        row = self.store.read_settings() if self.store is not None else None
        with self._lock:
            self._overrides = dict(row["overrides"]) if row else {}
            self._version = int(row["version"]) if row else 0
            self._updated_at = row["updated_at"] if row else None
            self._updated_by = row["updated_by"] if row else None
            try:
                self._effective = self._apply(self._overrides)
                self._problem = None
            except SettingsError as exc:
                self._effective = self.config
                self._problem = f"the override is set aside: {exc}"

    def effective(self) -> Values:
        with self._lock:
            return self._effective

    def limits(self, base: Limits) -> Limits:
        """The deployment's limits, with the call bounds a run uses now."""
        now = self.effective()
        return replace(base, max_calls=now.max_calls, max_extract_calls=now.max_extract_calls)

    def for_run(self, provider: str | None, models: tuple[str, str, str] | None) -> Values:
        """What a run uses: what it chose itself (`options.provider`, `options.model`) on top of
        the settings. A provider without its key is `422 provider_unavailable`, before anything is
        stored or paid; no model chosen means the provider's default for all three roles."""
        now = self.effective()
        if provider is None:
            return now
        why = self.check(provider) if provider in self.providers else "not a provider"
        if why:
            raise unprocessable(
                "provider_unavailable", f"this service cannot use {provider}: {why}"
            )
        if models is None:
            if provider == now.provider:
                models = now.models
            else:
                one = self.default_model(provider) if self.default_model else None
                if one is None:
                    raise unprocessable("provider_unavailable", f"{provider} has no default model")
                models = (one, one, one)
        return replace(now, provider=provider, models=models)

    def providers_view(self) -> list[dict[str, Any]]:
        """`GET /v1/info`'s `providers`: whether each provider can be used, and its default."""
        out: list[dict[str, Any]] = []
        for name in self.providers:
            entry: dict[str, Any] = {"code": name, "configured": self.check(name) is None}
            if self.default_model:
                entry["default_model"] = self.default_model(name)
            out.append(entry)
        return out

    def view(self) -> dict[str, Any]:
        """The contract's `Settings`."""
        with self._lock:
            out: dict[str, Any] = {
                "version": self._version,
                "updated_at": _iso(self._updated_at),
                "updated_by": self._updated_by,
                "effective": self._effective.as_json(),
                "config": self.config.as_json(),
                "overrides": {f: self._overrides.get(f) for f in FIELDS},
                "providers": [_provider(p, self.check(p)) for p in self.providers],
                "ceilings": {
                    "max_calls": MAX_CALLS_CEILING,
                    "max_extract_calls": MAX_EXTRACT_CALLS_CEILING,
                },
            }
            if self._problem:
                out["problem"] = self._problem
            return out

    # --- writing

    def update(self, body: Any) -> dict[str, Any]:
        """`PUT /v1/settings`: replace the override, if `version` is still the stored one."""
        if not isinstance(body, dict) or set(body) - {"version", "overrides", "updated_by"}:
            raise bad_request("the body is {version, overrides, updated_by?}")
        version, overrides, by = body.get("version"), body.get("overrides"), body.get("updated_by")
        if not isinstance(version, int) or isinstance(version, bool) or version < 0:
            raise bad_request("version must be the version read from GET /v1/settings")
        if not isinstance(overrides, dict) or set(overrides) - set(FIELDS):
            raise bad_request(f"overrides takes only {', '.join(FIELDS)}")
        if by is not None and (not isinstance(by, str) or len(by) > UPDATED_BY_MAX):
            raise bad_request(f"updated_by is a string of at most {UPDATED_BY_MAX} characters")
        kept = {k: v for k, v in overrides.items() if v is not None}
        try:
            self._apply(kept)
        except SettingsError as exc:
            code = "provider_unavailable" if str(exc).startswith("provider") else "bad_settings"
            raise unprocessable(code, str(exc)) from exc
        if self.store is None:
            raise ProblemError(
                HTTPStatus.SERVICE_UNAVAILABLE, "unavailable", "the settings cannot be stored"
            )
        written = self.store.write_settings(kept, version, by, self.clock())
        if written is None:
            raise ProblemError(
                HTTPStatus.CONFLICT,
                "settings_conflict",
                "the settings were changed since they were read; read them again",
            )
        self.reload()
        return self.view()

    def _apply(self, overrides: Mapping[str, Any]) -> Values:
        """The config file's values with `overrides` on top, or `SettingsError`."""
        provider = overrides.get("provider", self.config.provider)
        if not isinstance(provider, str) or provider not in self.providers:
            raise SettingsError(f"provider must be one of {', '.join(self.providers)}")
        raw_models = overrides.get("models")
        models = models_of(raw_models) if raw_models is not None else self.config.models
        why = self.check(provider)
        if why:
            raise SettingsError(f"provider {provider} cannot be used: {why}")
        calls = overrides.get("max_calls")
        extract = overrides.get("max_extract_calls")
        return Values(
            provider=provider,
            models=models,
            max_calls=self.config.max_calls
            if calls is None
            else _bound(calls, "max_calls", MAX_CALLS_CEILING),
            max_extract_calls=self.config.max_extract_calls
            if extract is None
            else _bound(extract, "max_extract_calls", MAX_EXTRACT_CALLS_CEILING),
        )


def _provider(name: str, why: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": name, "available": why is None}
    if why:
        out["reason"] = why
    return out


def _iso(epoch: float | None) -> str | None:
    if epoch is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


__all__ = [
    "FIELDS",
    "MAX_CALLS_CEILING",
    "MAX_EXTRACT_CALLS_CEILING",
    "ProviderCheck",
    "Settings",
    "SettingsError",
    "Stored",
    "Values",
    "models_of",
]
