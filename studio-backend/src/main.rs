//! Constructor Studio Backend — the Studio backend server assembled from CF/Gears.
//!
//! Modeled after `gears-rust/apps/cf-gears-example-server`. All gear logic
//! lives in the linked gear crates (see `registered_gears.rs`); this binary
//! only loads layered config and hands control to `toolkit::bootstrap`.

mod keycloak_idp_plugin; // real user provisioning via Keycloak Admin API (ADR-0004)
mod llm_proxy; // OpenAI-compatible LLM proxy for Theia AI in IDE sessions
mod registered_gears;
mod studio_session; // Studio's own gear: per-workspace Theia IDE containers

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use mimalloc::MiMalloc;
use toolkit::bootstrap::{
    AppConfig, dump_effective_gears_config_yaml, list_gear_names, run_migrate, run_server,
};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// Constructor Studio backend server (CF/Gears assembly).
#[derive(Parser)]
#[command(name = "studio-backend")]
#[command(about = "Constructor Studio backend — CF/Gears assembly (account-management demo)")]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    /// Path to configuration file (default: config/dev.yaml conventions apply)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Print effective configuration (YAML) and exit
    #[arg(long)]
    print_config: bool,

    /// List all configured gear names and exit
    #[arg(long)]
    list_gears: bool,

    /// Dump effective per-gear configuration (YAML) and exit
    #[arg(long)]
    dump_gears_config: bool,

    /// Log verbosity level (-v debug, -vv trace)
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the server (default)
    Run,
    /// Run database migrations and exit
    Migrate,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Layered config: defaults -> YAML -> env (APP__*) -> CLI overrides.
    let mut config = AppConfig::load_or_default(cli.config.as_ref())?;
    config.apply_cli_overrides(cli.verbose);

    if cli.print_config {
        println!("Effective configuration:\n{}", config.to_yaml()?);
        return Ok(());
    }

    if cli.list_gears {
        let gears = list_gear_names(&config);
        println!("Configured gears ({}):", gears.len());
        for gear in gears {
            println!("  - {gear}");
        }
        return Ok(());
    }

    if cli.dump_gears_config {
        println!("{}", dump_effective_gears_config_yaml(&config)?);
        return Ok(());
    }

    match cli.command.unwrap_or(Commands::Run) {
        Commands::Run => run_server(config).await,
        Commands::Migrate => run_migrate(config).await,
    }
}
