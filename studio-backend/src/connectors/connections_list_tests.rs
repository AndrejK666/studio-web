//! The connections list (#1077): what it costs account-management and the
//! identity gear per request, and that the answer is the one the walk one
//! level after another gave.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::oauth_flow_tests::{Catalogues, Secrets};
use super::*;
use crate::connectors::ownership::PLATFORM_ROOT_TENANT;

const ROOT: Uuid = PLATFORM_ROOT_TENANT;
const ORG: Uuid = Uuid::from_u128(0x0a);
const WS: Uuid = Uuid::from_u128(0x0b);
const PROJECT: Uuid = Uuid::from_u128(0x0c);

const ME: u128 = 0xa1;

fn caller() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(ME))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

/// A catalogue holding one connection per `(id, created_by)`, owned by `tenant`.
fn catalogue(tenant: Uuid, rows: &[(u128, &str)]) -> Value {
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, by)| {
            json!({
                "id": Uuid::from_u128(*id),
                "owner_tenant_id": tenant,
                "provider": "github",
                "label": format!("connection {id}"),
                "base_url": "https://api.github.com",
                "secret_ref": format!("studio-connection-{id}"),
                "scope": "organization",
                "created_by": by,
                "created_at_epoch_secs": 1,
            })
        })
        .collect();
    json!({ "items": items })
}

/// root -> ORG -> WS -> PROJECT, with the catalogues `docs` names.
fn tree(docs: &[(Uuid, Value)]) -> Arc<Catalogues> {
    Arc::new(Catalogues {
        docs: Mutex::new(docs.iter().cloned().collect()),
        parents: HashMap::from([(ORG, ROOT), (WS, ORG), (PROJECT, WS)]),
        calls: Mutex::default(),
    })
}

fn service(am: &Arc<Catalogues>) -> Arc<ConnectorService> {
    ConnectorService::new(am.clone(), Arc::new(Secrets::default()), Vec::new())
}

fn ids(items: &[Connection]) -> Vec<u128> {
    items.iter().map(|c| c.id.as_u128()).collect()
}

/// Account-management calls made, by method.
fn counted(am: &Catalogues) -> HashMap<&'static str, usize> {
    let mut out = HashMap::new();
    for call in am.calls.lock().unwrap().iter() {
        *out.entry(*call).or_default() += 1;
    }
    out
}

#[tokio::test]
async fn a_projects_list_reads_each_level_once() {
    let am = tree(&[
        (PROJECT, catalogue(PROJECT, &[(0x1, "a")])),
        (WS, catalogue(WS, &[(0x2, "a")])),
        (ORG, catalogue(ORG, &[(0x3, "a"), (0x4, "b")])),
        (ROOT, catalogue(ROOT, &[(0x9, "a")])),
    ]);
    let items = service(&am)
        .list_with_ancestors(&caller(), PROJECT)
        .await
        .unwrap();

    // Nearest first, the root's left out.
    assert_eq!(ids(&items), [0x1, 0x2, 0x3, 0x4]);
    // Three catalogues and the two parents above the project; it was seven
    // calls one after another: the own list, then a catalogue and a parent
    // per level, the organization's parent included.
    let calls = counted(&am);
    assert_eq!(calls.get("resolve_metadata"), Some(&3), "{calls:?}");
    assert_eq!(calls.get("get_tenant"), Some(&2), "{calls:?}");
    assert_eq!(calls.values().sum::<usize>(), 5, "{calls:?}");
}

#[tokio::test]
async fn a_level_without_a_catalogue_inherits_as_before() {
    // The project holds nothing: its own list is its workspace's, and the
    // workspace's rows come once, before the organization's.
    let am = tree(&[
        (WS, catalogue(WS, &[(0x2, "a")])),
        (ORG, catalogue(ORG, &[(0x3, "a")])),
    ]);
    let svc = service(&am);
    let items = svc.list_with_ancestors(&caller(), PROJECT).await.unwrap();
    assert_eq!(ids(&items), [0x2, 0x3]);
    assert_eq!(ids(&svc.list(&caller(), PROJECT).await.unwrap()), [0x2]);
}

#[tokio::test]
async fn an_organizations_list_stops_at_the_root() {
    let am = tree(&[
        (ORG, catalogue(ORG, &[(0x3, "a")])),
        (ROOT, catalogue(ROOT, &[(0x9, "a")])),
    ]);
    let items = service(&am)
        .list_with_ancestors(&caller(), ORG)
        .await
        .unwrap();
    assert_eq!(ids(&items), [0x3]);
    let calls = counted(&am);
    assert_eq!(calls.get("resolve_metadata"), Some(&2), "{calls:?}");
    assert_eq!(calls.get("get_tenant"), Some(&2), "{calls:?}");
}

#[tokio::test]
async fn the_root_sees_its_own() {
    let am = tree(&[(ROOT, catalogue(ROOT, &[(0x9, "a")]))]);
    let items = service(&am)
        .list_with_ancestors(&caller(), ROOT)
        .await
        .unwrap();
    assert_eq!(ids(&items), [0x9]);
}

#[tokio::test]
async fn the_plain_list_is_one_call() {
    let am = tree(&[(ORG, catalogue(ORG, &[(0x3, "a")]))]);
    let items = service(&am).list(&caller(), PROJECT).await.unwrap();
    assert_eq!(ids(&items), [0x3]);
    assert_eq!(am.calls.lock().unwrap().as_slice(), ["resolve_metadata"]);
}

#[tokio::test]
async fn a_key_lookup_walks_the_same_levels() {
    let am = tree(&[
        (PROJECT, catalogue(PROJECT, &[(0x1, "a")])),
        (ORG, catalogue(ORG, &[(0x3, "a"), (0x1, "a")])),
    ]);
    let found = reachable_connections(am.as_ref(), &caller(), PROJECT).await;
    assert_eq!(ids(&found), [0x1, 0x3]);
    assert_eq!(counted(&am).values().sum::<usize>(), 5);
}

/* ── whose each row is ── */

const OTHER_LOGIN: &str = "00000000-0000-0000-0000-0000000000b2";
const STRANGER: &str = "00000000-0000-0000-0000-0000000000c3";
const UNKNOWN: &str = "00000000-0000-0000-0000-0000000000d4";

/// A `login` table that counts what it is asked: the caller is person "me",
/// [`OTHER_LOGIN`] is another of their logins, [`STRANGER`] somebody else.
#[derive(Default)]
struct CountingLogins {
    callers: Mutex<usize>,
    recorded: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl PersonResolver for CountingLogins {
    async fn resolve_caller(&self, _ctx: &SecurityContext) -> anyhow::Result<String> {
        *self.callers.lock().unwrap() += 1;
        Ok("me".to_owned())
    }
    async fn resolve_recorded_subject(&self, subject: &str) -> anyhow::Result<Option<String>> {
        self.recorded.lock().unwrap().push(subject.to_owned());
        Ok(match subject {
            OTHER_LOGIN => Some("me".to_owned()),
            STRANGER => Some("someone".to_owned()),
            _ => None,
        })
    }
}

#[tokio::test]
async fn the_caller_is_resolved_once_and_each_creator_once() {
    let me = Uuid::from_u128(ME).to_string();
    let rows = [
        me.as_str(),
        OTHER_LOGIN,
        STRANGER,
        OTHER_LOGIN,
        UNKNOWN,
        STRANGER,
        me.as_str(),
        "",
    ];
    let people = CountingLogins::default();
    let mine = mine_of(&caller(), &rows, Some(&people)).await;

    assert_eq!(mine, [true, true, false, true, false, false, true, false]);
    assert_eq!(*people.callers.lock().unwrap(), 1);
    let mut asked = people.recorded.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, ["", OTHER_LOGIN, STRANGER, UNKNOWN]);
}

#[tokio::test]
async fn every_answer_is_the_one_same_person_gives() {
    let me = Uuid::from_u128(ME).to_string();
    let rows = [me.as_str(), OTHER_LOGIN, STRANGER, UNKNOWN, ""];
    let people = CountingLogins::default();
    let mine = mine_of(&caller(), &rows, Some(&people)).await;
    for (row, mine) in rows.iter().zip(mine) {
        let one = same_person(&caller(), row, Some(&people)).await.unwrap();
        assert_eq!(mine, one, "{row}");
    }
    // Without the identity gear only the caller's own sign-in is theirs.
    let alone = mine_of(&caller(), &rows, None).await;
    assert_eq!(alone, [true, false, false, false, false]);
}

#[tokio::test]
async fn nobody_else_to_ask_about_asks_nobody() {
    let me = Uuid::from_u128(ME).to_string();
    let people = CountingLogins::default();
    let mine = mine_of(&caller(), &[me.as_str(), me.as_str()], Some(&people)).await;
    assert_eq!(mine, [true, true]);
    assert_eq!(*people.callers.lock().unwrap(), 0);
    assert!(people.recorded.lock().unwrap().is_empty());
}

#[tokio::test]
async fn creators_who_are_nobody_never_resolve_the_caller() {
    // As `same_person`: the caller is only looked up to compare with a
    // creator that is somebody, so a list of unknown creators provisions
    // nothing.
    let people = CountingLogins::default();
    let mine = mine_of(&caller(), &[UNKNOWN, ""], Some(&people)).await;
    assert_eq!(mine, [false, false]);
    assert_eq!(*people.callers.lock().unwrap(), 0);
}
