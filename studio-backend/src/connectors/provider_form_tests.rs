//! The form each driver says a connection is made with: what `GET /providers`
//! hands a client so it draws the form with no code per provider.

use super::assembly_service::AssemblyServiceDriver;
use super::driver::{ConnectorDriver, FieldKind, FormField, Holder};
use super::github::GitHubDriver;
use super::kubernetes::KubernetesDriver;
use super::registry::RegistryDriver;
use super::research::ResearchDriver;
use super::rest::FormFieldDto;
use super::slack::SlackWebhookDriver;

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

fn names(driver: &dyn ConnectorDriver) -> Vec<String> {
    driver.form_fields().into_iter().map(|f| f.name).collect()
}

/// A source host: its address, optional with a default, then its token.
#[test]
fn a_pasted_provider_asks_for_its_address_and_its_token() {
    let driver = GitHubDriver::new(http());
    let fields = driver.form_fields();
    assert_eq!(names(&driver), [FormField::BASE_URL, FormField::TOKEN]);
    assert_eq!(fields[0].kind, FieldKind::Url);
    assert_eq!(fields[0].placeholder, driver.default_base_url());
    assert!(!fields[0].required);
    assert_eq!(fields[1].kind, FieldKind::Secret);
    assert_eq!(fields[1].label, "Personal Access Token (PAT)");
    assert_eq!(fields[1].placeholder, "ghp_…");
    assert!(fields[1].required);
    assert_eq!(driver.holder(), Holder::Any);
    assert!(!driver.holder_fixed());
}

/// A webhook's URL is its whole address: no address field beside it.
#[test]
fn a_webhook_asks_only_for_its_url() {
    let driver = SlackWebhookDriver::new(http());
    assert_eq!(names(&driver), [FormField::TOKEN]);
}

/// Research's address is the deployment's; a member pastes only a key, and
/// the account is their own.
#[test]
fn research_asks_only_for_a_key_and_starts_personal() {
    let driver = ResearchDriver::new(http(), None, "https://research.example.com/api".into());
    let fields = driver.form_fields();
    assert_eq!(names(&driver), [FormField::TOKEN]);
    assert_eq!(fields[0].placeholder, "rk-…");
    assert!(!fields[0].hint.is_empty());
    assert_eq!(driver.holder(), Holder::Personal);
}

/// A cluster's credential may be a kubeconfig, and only the organization
/// holds a cluster or a registry.
#[test]
fn a_cluster_takes_a_kubeconfig_and_is_the_organizations() {
    let driver = KubernetesDriver;
    let fields = driver.form_fields();
    assert_eq!(names(&driver), [FormField::BASE_URL, FormField::TOKEN]);
    assert_eq!(fields[1].format, Some("kubeconfig"));
    assert_eq!(driver.holder(), Holder::Organization);
    assert!(!driver.holder_fixed());
    assert_eq!(RegistryDriver::new(http()).holder(), Holder::Organization);
}

/// An assembly service: the strategy, a required address (there is no
/// default) and the secret; only the organization, with no choice.
#[test]
fn an_assembly_service_names_its_strategy_and_has_one_holder() {
    let driver = AssemblyServiceDriver::new(http());
    let fields = driver.form_fields();
    assert_eq!(
        names(&driver),
        ["strategy", FormField::BASE_URL, FormField::TOKEN]
    );
    let strategy = &fields[0];
    assert_eq!(strategy.kind, FieldKind::Text);
    assert!(strategy.required);
    assert_eq!(strategy.max_length, Some(40));
    let pattern = strategy.pattern.expect("a strategy id has a shape");
    assert_eq!(pattern, "^[a-z][a-z0-9_]{0,39}$");
    assert!(fields[1].required, "no default address, so one is typed");
    assert_eq!(driver.holder(), Holder::Organization);
    assert!(driver.holder_fixed());
}

/// The wire form keeps every word of the driver's.
#[test]
fn a_field_goes_out_as_the_driver_said_it() {
    let dto = FormFieldDto::from(
        KubernetesDriver
            .form_fields()
            .into_iter()
            .nth(1)
            .expect("a token field"),
    );
    assert_eq!(dto.name, "token");
    assert_eq!(dto.kind, "secret");
    assert_eq!(dto.format.as_deref(), Some("kubeconfig"));
    assert!(dto.required);
    assert!(dto.choices.is_empty());
    assert_eq!(dto.pattern, None);
}
