//! The build Job's steps on the `studio-backend` command line
//! (`build-prepare`, `build-publish`), contributed through the core's
//! command-line port (`crate::CliCommand`, ADR-0079 §4): no profile, no
//! database, no listener.

use clap::{CommandFactory, FromArgMatches, Parser};

use super::build;

/// One step of a build in an organization's cluster (ADR-0048 §9): clone
/// the product's repository and gear sources, generate the profile and
/// make the tree buildable. Run by the build Job, not by people.
#[derive(Parser)]
#[command(name = "build-prepare")]
struct BuildPrepare {
    #[arg(long)]
    work: std::path::PathBuf,
    #[arg(long)]
    repo_url: String,
    #[arg(long = "ref")]
    git_ref: Option<String>,
    /// Take only the product file from this ref (a `product/…` branch);
    /// the code is `--ref`'s (ADR-0053 §4).
    #[arg(long)]
    description_ref: Option<String>,
    /// The Studio revision whose text is in `STUDIO_PRODUCT_DESCRIPTION`
    /// (ADR-0053 §2); for the log.
    #[arg(long)]
    description_revision: Option<i64>,
    #[arg(long)]
    product_file: String,
    #[arg(long)]
    profile: String,
    /// A build of the repository's own Dockerfiles and chart, as JSON
    /// (ADR-0054 §7); without it the product description is built.
    #[arg(long)]
    own: Option<String>,
    /// `id=ref`: the description's `git(...)` source `id`, one of the
    /// project's repositories, fetched at `ref` (ADR-0060 §3).
    #[arg(long = "source-ref")]
    source_refs: Vec<String>,
    /// `dev` builds the profile as a development one (ADR-0060 §5).
    #[arg(long)]
    strictness: Option<String>,
}

/// The last step of a build in an organization's cluster: push the chart
/// beside the images and leave the manifest as the termination message.
#[derive(Parser)]
#[command(name = "build-publish")]
struct BuildPublish {
    #[arg(long)]
    work: std::path::PathBuf,
    #[arg(long)]
    prefix: String,
    #[arg(long)]
    registry_config: std::path::PathBuf,
}

inventory::submit! {
    crate::CliCommand {
        order: 10,
        command: BuildPrepare::command,
        run: build_prepare,
    }
}

inventory::submit! {
    crate::CliCommand {
        order: 20,
        command: BuildPublish::command,
        run: build_publish,
    }
}

fn build_prepare(matches: &clap::ArgMatches) -> anyhow::Result<()> {
    let a = BuildPrepare::from_arg_matches(matches)?;
    // Studio's revision when the Job carries one (ADR-0053 §2), else only
    // the file of a product branch (§4), else the checkout's own.
    let studio_text = std::env::var(build::DESCRIPTION_ENV)
        .ok()
        .filter(|t| !t.trim().is_empty());
    let description = match (studio_text.as_deref(), a.description_ref.as_deref()) {
        (Some(text), _) => build::DescriptionFrom::Text {
            revision: a.description_revision,
            text,
        },
        (None, Some(r)) => build::DescriptionFrom::Ref(r),
        (None, None) => build::DescriptionFrom::Checkout,
    };
    build::prepare(
        &a.work,
        &a.repo_url,
        a.git_ref.as_deref(),
        &description,
        &a.product_file,
        &a.profile,
        a.own.as_deref(),
        &build::SourceOptions::parse(&a.source_refs, a.strictness.as_deref())?,
    )
    .inspect_err(build::say_failure)
}

fn build_publish(matches: &clap::ArgMatches) -> anyhow::Result<()> {
    let a = BuildPublish::from_arg_matches(matches)?;
    build::publish(&a.work, &a.prefix, &a.registry_config)
        .map(|_| ())
        .inspect_err(build::say_failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Job calls the steps by these names and flags.
    #[test]
    fn the_steps_parse_as_the_job_calls_them() {
        let m = BuildPublish::command().get_matches_from([
            "build-publish",
            "--work",
            "/work",
            "--prefix",
            "p",
            "--registry-config",
            "/registry/config.json",
        ]);
        let a = BuildPublish::from_arg_matches(&m).unwrap();
        assert_eq!(a.prefix, "p");
        let m = BuildPrepare::command().get_matches_from([
            "build-prepare",
            "--work",
            "/w",
            "--repo-url",
            "u",
            "--ref",
            "main",
            "--product-file",
            "product.gdl",
            "--profile",
            "kubernetes",
            "--source-ref",
            "a=b",
        ]);
        let a = BuildPrepare::from_arg_matches(&m).unwrap();
        assert_eq!(a.git_ref.as_deref(), Some("main"));
        assert_eq!(a.source_refs, ["a=b"]);
    }
}
