//! The audit port: a handle reaches the recorder a kit registered, and an
//! assembly without one keeps nothing and fails nothing.

use std::sync::Mutex;

use serde_json::json;

use super::*;

#[derive(Default)]
struct Kept(Mutex<Vec<AuditEvent>>);

#[async_trait]
impl AuditRecorder for Kept {
    async fn record(&self, _: &SecurityContext, events: Vec<AuditEvent>) -> anyhow::Result<()> {
        self.0.lock().unwrap().extend(events);
        Ok(())
    }
}

struct Broken;

#[async_trait]
impl AuditRecorder for Broken {
    async fn record(&self, _: &SecurityContext, _: Vec<AuditEvent>) -> anyhow::Result<()> {
        anyhow::bail!("the audit store is down")
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x5e))
        .subject_tenant_id(Uuid::from_u128(0x0a))
        .build()
        .unwrap()
}

#[tokio::test]
async fn a_handle_records_through_the_recorder_a_kit_registered() {
    let hub = Arc::new(ClientHub::new());
    let audit = Audit::new(Arc::clone(&hub));
    // Registered after the handle was made: it is looked up per event.
    let kept = Arc::new(Kept::default());
    hub.register::<dyn AuditRecorder>(kept.clone());
    let org = Uuid::from_u128(0x0a);
    audit
        .record(
            &ctx(),
            vec![
                AuditEvent::new(&ctx(), org, "studio-kits", "kit.installed")
                    .on("org-costs")
                    .with(json!({ "version": "1" })),
            ],
        )
        .await
        .unwrap();
    let kept = kept.0.lock().unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].actor, Uuid::from_u128(0x5e));
    assert_eq!(kept[0].tenant, org);
    assert_eq!(kept[0].action, "kit.installed");
    assert_eq!(kept[0].subject.as_deref(), Some("org-costs"));
    assert_eq!(kept[0].detail, json!({ "version": "1" }));
}

#[tokio::test]
async fn without_a_recorder_nothing_is_kept_and_nothing_fails() {
    let audit = Audit::new(Arc::new(ClientHub::new()));
    let event = AuditEvent::new(&ctx(), Uuid::nil(), "studio-kits", "kit.installed");
    audit.record(&ctx(), vec![event.clone()]).await.unwrap();
    audit.note(&ctx(), event).await;
}

#[tokio::test]
async fn a_failing_recorder_fails_record_and_is_only_logged_by_note() {
    let audit = Audit::fixed(Arc::new(Broken));
    let event = AuditEvent::new(&ctx(), Uuid::nil(), "studio-kits", "kit.installed");
    let err = audit.record(&ctx(), vec![event.clone()]).await.unwrap_err();
    assert!(err.to_string().contains("down"), "{err}");
    audit.note(&ctx(), event).await;
}

#[tokio::test]
async fn nothing_to_record_never_reaches_the_recorder() {
    let audit = Audit::fixed(Arc::new(Broken));
    audit.record(&ctx(), Vec::new()).await.unwrap();
}
