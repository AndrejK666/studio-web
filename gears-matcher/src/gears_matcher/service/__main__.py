"""`gears-service`: serve the matcher over HTTP.

Keys and connections come from the service's config file, `GEARS_MATCHER_CONFIG` (TOML; see
`gears_matcher.service.config`): the shared secret, the LLM connector's settings, the gears-rust
clone token and, optionally, the database URL. Each config value is an environment variable too,
and a variable set in the environment wins over the file.

Required: `GEARS_MATCHER_SECRET` (the shared secret callers send as a bearer token),
`GEARS_RUST_REPO` (a `gears-rust` checkout the catalogue is read from, at the pinned commits), the
LLM connector's settings (`LLM_CONNECTORS_ACCESS_KEY` and the rest, read by the model clients), and
the run store: `GEARS_MATCHER_DATABASE_URL`, or the libpq `PG*` variables (`PGHOST` at least). For a
local run `GEARS_MATCHER_ENV_FILE` may name a `.env` file that holds the connector settings.

Optional: `GEARS_MATCHER_DATA` (the reply cache and scratch space; default
`/var/lib/gears-matcher`), `GEARS_MATCHER_DB_POOL` (connections to the run store; 4),
`GEARS_MATCHER_HOST`, `GEARS_MATCHER_PORT`, `GEARS_MATCHER_WORKERS`,
`GEARS_MATCHER_MAX_CONCURRENT_RUNS` (unset: no cap), `GEARS_MATCHER_MAX_CALLS` (the per-run call
bound a request may lower but not raise, and the default when it sets none; 400) and
`GEARS_MATCHER_MAX_EXTRACT_CALLS` (100), `GEARS_MD_REF`, `GEARS_GDL_REF`, `GEARS_BUNDLE`.
"""

import logging
import os
import sys
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import psycopg
import uvicorn
from psycopg_pool import PoolTimeout

from gears_matcher.catalogue import PINNED_GDL_COMMIT, PINNED_MD_COMMIT, build_from_repo
from gears_matcher.judge.llm import ModelClient
from gears_matcher.judge.llm.run import (
    PROVIDERS,
    RunError,
    default_model,
    load_client,
    load_env_file,
    provider_module,
    selected_provider,
)
from gears_matcher.run import ModelFactory, verified_models
from gears_matcher.service.app import create_app
from gears_matcher.service.config import ConfigError, load_config
from gears_matcher.service.manager import RunManager
from gears_matcher.service.request import Limits
from gears_matcher.service.runner import RealRunner
from gears_matcher.service.settings import Settings as RunSettings
from gears_matcher.service.settings import SettingsError as RunSettingsError
from gears_matcher.service.settings import Values
from gears_matcher.service.store import RunStore

log = logging.getLogger("gears_matcher.service")
EXIT_CANNOT_START = 2


class SettingsError(Exception):
    """The environment cannot start the service; the message says which variable and why."""


@dataclass(frozen=True)
class Settings:
    secret: str
    gears_rust: Path
    database: str
    db_pool: int
    data: Path
    host: str
    port: int
    workers: int
    limits: Limits
    md_ref: str
    gdl_ref: str
    bundle: Path | None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        secret = env.get("GEARS_MATCHER_SECRET", "")
        if not secret:
            raise SettingsError("GEARS_MATCHER_SECRET is required")
        repo = env.get("GEARS_RUST_REPO", "")
        if not repo or not Path(repo).is_dir():
            raise SettingsError("GEARS_RUST_REPO must name a gears-rust checkout")
        database = env.get("GEARS_MATCHER_DATABASE_URL", "").strip()
        if not database and not env.get("PGHOST", "").strip():
            raise SettingsError(
                "the run store needs GEARS_MATCHER_DATABASE_URL ([database] url in the config "
                "file) or the PG* variables"
            )
        cap = env.get("GEARS_MATCHER_MAX_CONCURRENT_RUNS")
        bundle = env.get("GEARS_BUNDLE")
        return cls(
            secret=secret,
            gears_rust=Path(repo),
            database=database,
            db_pool=_number(env, "GEARS_MATCHER_DB_POOL", 4),
            data=Path(env.get("GEARS_MATCHER_DATA", "/var/lib/gears-matcher")),
            host=env.get("GEARS_MATCHER_HOST", "0.0.0.0"),  # noqa: S104 -- a container's own port
            port=_number(env, "GEARS_MATCHER_PORT", 8080),
            workers=_number(env, "GEARS_MATCHER_WORKERS", 4),
            limits=Limits(
                max_calls=_number(env, "GEARS_MATCHER_MAX_CALLS", Limits.max_calls),
                max_extract_calls=_number(
                    env, "GEARS_MATCHER_MAX_EXTRACT_CALLS", Limits.max_extract_calls
                ),
                max_concurrent_runs=int(cap) if cap else None,
            ),
            md_ref=env.get("GEARS_MD_REF", PINNED_MD_COMMIT),
            gdl_ref=env.get("GEARS_GDL_REF", PINNED_GDL_COMMIT),
            bundle=Path(bundle) if bundle else None,
        )


def _number(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise SettingsError(f"{name} must be a whole number") from exc
    if value < 1:
        raise SettingsError(f"{name} must be at least 1")
    return value


class ClientPool:
    """Clients, built once per (provider, model) and shared. Building one sends nothing; a
    missing key fails there, naming the variable."""

    def __init__(self) -> None:
        self._made: dict[tuple[str, str], tuple[str, ModelClient]] = {}
        self._lock = threading.Lock()
        self._why: dict[str, str | None] = {}

    def factory(self, provider: str) -> ModelFactory:
        module = provider_module(provider)

        def make(name: str) -> tuple[str, ModelClient]:
            with self._lock:
                if (provider, name) not in self._made:
                    client = load_client(module, provider, name)
                    self._made[provider, name] = (module.label(name), client)
                return self._made[provider, name]

        return make

    def unavailable(self, provider: str) -> str | None:
        """Why a provider cannot be used (its key or a setting is missing), or None. Keys come
        from the config file, read at start, so the answer is kept."""
        if provider not in self._why:
            try:
                module = provider_module(provider)
                load_client(module, provider, default_model(provider, module))
                self._why[provider] = None
            except RunError as exc:
                self._why[provider] = str(exc)
        return self._why[provider]


def model_factory(pool: ClientPool | None = None) -> ModelFactory:
    """The clients of the provider the config file chooses; a missing key fails here, at start."""
    factory = (pool or ClientPool()).factory(selected_provider())
    for name in dict.fromkeys(verified_models()):
        factory(name)
    return factory


def build(settings: Settings) -> tuple[RunManager, RealRunner, RunSettings]:
    catalogue = build_from_repo(settings.gears_rust, settings.md_ref, settings.gdl_ref)
    bundle = (
        build_from_repo(settings.gears_rust, settings.md_ref, settings.gdl_ref, settings.bundle)
        if settings.bundle
        else None
    )
    pool = ClientPool()
    runner = RealRunner(
        catalogue,
        model_factory(pool),
        cache_dir=settings.data / "cache",
        work_dir=settings.data / "work",
        bundle_catalogue=bundle,
        providers=pool.factory,
    )
    store = RunStore(settings.database, pool_size=settings.db_pool)
    config = Values(
        provider=selected_provider(),
        models=verified_models(),
        max_calls=settings.limits.max_calls,
        max_extract_calls=settings.limits.max_extract_calls,
    )
    run_settings = RunSettings(config, tuple(PROVIDERS), pool.unavailable, store)
    problem = run_settings.view().get("problem")
    if problem:
        log.warning("%s", problem)
    manager = RunManager(store, runner, settings.limits, settings.workers, settings=run_settings)
    return manager, runner, run_settings


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        config = os.environ.get("GEARS_MATCHER_CONFIG")
        if config:
            load_config(Path(config))
        env_file = os.environ.get("GEARS_MATCHER_ENV_FILE")
        if env_file:
            load_env_file(Path(env_file))
        settings = Settings.from_env(os.environ)
        manager, runner, run_settings = build(settings)
    except (
        SettingsError,
        RunSettingsError,
        ConfigError,
        RunError,
        OSError,
        ValueError,
        psycopg.Error,
        PoolTimeout,
    ) as exc:
        print(f"gears-service: cannot start: {exc}", file=sys.stderr)
        return EXIT_CANNOT_START
    app = create_app(manager, settings.secret, runner.info(), settings.limits, run_settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
