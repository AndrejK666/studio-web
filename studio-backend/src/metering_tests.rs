//! The metering port: a handle reaches the recorder a kit registered, and an
//! assembly without one records nothing.

use std::sync::Mutex;

use super::*;

#[derive(Default)]
struct Kept(Mutex<Vec<String>>);

#[async_trait]
impl UsageRecorder for Kept {
    async fn record(&self, _: &SecurityContext, records: Vec<UsageRecord>) -> anyhow::Result<()> {
        self.0
            .lock()
            .unwrap()
            .extend(records.into_iter().map(|r| r.key));
        Ok(())
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x5e))
        .subject_tenant_id(Uuid::from_u128(0x0a))
        .build()
        .unwrap()
}

fn record(key: &str) -> UsageRecord {
    UsageRecord {
        key: key.to_owned(),
        tenant_id: Uuid::from_u128(0x0a),
        person_id: None,
        source: Source::Session,
        payer: Payer::Organization,
        provider: "kubernetes".to_owned(),
        item: SESSION_ITEM.to_owned(),
        occurred_at: OffsetDateTime::UNIX_EPOCH,
        tokens: TokenCounts::default(),
        runtime: Runtime::default(),
    }
}

#[tokio::test]
async fn a_handle_records_through_the_recorder_a_kit_registered() {
    let hub = Arc::new(ClientHub::new());
    let usage = Usage::new(Arc::clone(&hub));
    // Registered after the handle was made: it is looked up per record.
    let kept = Arc::new(Kept::default());
    hub.register::<dyn UsageRecorder>(kept.clone());
    usage
        .record(&ctx(), vec![record("session:a:0"), record("session:a:1")])
        .await
        .unwrap();
    assert_eq!(*kept.0.lock().unwrap(), ["session:a:0", "session:a:1"]);
}

#[tokio::test]
async fn without_a_recorder_nothing_is_recorded_and_nothing_fails() {
    let usage = Usage::new(Arc::new(ClientHub::new()));
    usage
        .record(&ctx(), vec![record("session:b:0")])
        .await
        .unwrap();
}
