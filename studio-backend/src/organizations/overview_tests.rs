//! The overview's rules, stated as tests: these are the product here.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;
use time::macros::datetime;
use uuid::Uuid;

use super::*;
use crate::organizations::port::{BlockNeedDto, LineDto, Signals, TileDto, english};

const ORG: Uuid = Uuid::from_u128(0x0);
const ADA: Uuid = Uuid::from_u128(0xADA);
const BOB: Uuid = Uuid::from_u128(0xB0B);
const GONE: Uuid = Uuid::from_u128(0x6011E);

fn run(
    state: &str,
    repo: &str,
    error: Option<&str>,
    at: OffsetDateTime,
    project: &str,
) -> RunSummary {
    RunSummary {
        id: Uuid::nil(),
        tenant_id: ORG,
        task_type: "artifact.ingest".into(),
        state: state.into(),
        payload: json!({
            "provider": "github",
            "secret_ref": "gh-org",
            "repo_full_path": repo,
            "project_id": project,
        }),
        last_error: error.map(str::to_owned),
        created_at: at,
    }
}

fn member(person: &str, subjects: &[Uuid]) -> RosterMember {
    RosterMember {
        person: person.into(),
        subjects: subjects.iter().map(Uuid::to_string).collect(),
    }
}

// ── Periods ──

#[test]
fn spend_compares_the_last_30_days_with_the_same_days_a_month_earlier() {
    let w = windows(datetime!(2026-10-19 15:00 UTC));
    assert_eq!(w.current.from, datetime!(2026-09-20 0:00 UTC));
    assert_eq!(w.current.to, datetime!(2026-10-20 0:00 UTC));
    // 21 Aug – 19 Sep, both included.
    assert_eq!(w.previous.from, datetime!(2026-08-21 0:00 UTC));
    assert_eq!(w.previous.to, datetime!(2026-09-20 0:00 UTC));
    assert_eq!(w.month.from, datetime!(2026-10-01 0:00 UTC));
    assert_eq!((w.elapsed_days, w.month_days), (19, 31));
}

#[test]
fn a_month_back_from_the_31st_is_the_last_day_of_a_shorter_month() {
    // 31 March: one month back is 28 February, not 3 March.
    assert_eq!(
        windows(datetime!(2026-03-31 10:00 UTC)).previous.to,
        datetime!(2026-03-01 0:00 UTC)
    );
    // January reaches back into December of the year before.
    assert_eq!(
        windows(datetime!(2026-01-10 10:00 UTC)).previous.to,
        datetime!(2025-12-11 0:00 UTC)
    );
}

#[test]
fn growth_needs_something_before() {
    assert_eq!(growth(150.0, 100.0), Some(0.5));
    assert_eq!(growth(10.0, 0.0), None);
}

// ── Refused connections ──

#[test]
fn a_refused_credential_is_not_a_rate_limit() {
    assert_eq!(
        refusal(Some("GitHub 401 Unauthorized: Bad credentials")),
        Some("401")
    );
    assert_eq!(
        refusal(Some(
            "403 Forbidden: Resource not accessible by integration"
        )),
        Some("403")
    );
    assert_eq!(
        refusal(Some(
            "GitHub 403 Forbidden: API rate limit exceeded for user ID 301748190."
        )),
        None
    );
    assert_eq!(refusal(Some("took 4013 ms, connection reset")), None);
    assert_eq!(refusal(None), None);
}

#[test]
fn only_each_repositorys_newest_run_counts() {
    let runs = [
        // Newest first. acme/api synced again since it was refused: fine.
        run(
            "succeeded",
            "acme/api",
            None,
            datetime!(2026-10-19 10:00 UTC),
            "p1",
        ),
        run(
            "failed",
            "acme/web",
            Some("GitHub 401 Bad credentials"),
            datetime!(2026-10-19 9:00 UTC),
            "p2",
        ),
        run(
            "failed",
            "acme/api",
            Some("GitHub 401 Bad credentials"),
            datetime!(2026-10-18 9:00 UTC),
            "p1",
        ),
        run(
            "failed",
            "acme/web",
            Some("GitHub 401 Bad credentials"),
            datetime!(2026-10-17 9:00 UTC),
            "p2",
        ),
        run(
            "failed",
            "acme/docs",
            Some("GitHub 401 Bad credentials"),
            datetime!(2026-10-16 9:00 UTC),
            "p3",
        ),
        run(
            "failed",
            "acme/x",
            Some("timeout"),
            datetime!(2026-10-16 9:00 UTC),
            "p3",
        ),
    ];
    let broken = broken_connections(&runs);
    assert_eq!(broken.len(), 1);
    let b = &broken[0];
    assert_eq!(
        (b.key.as_str(), b.provider.as_str(), b.status),
        ("gh-org", "github", "401")
    );
    assert_eq!(b.repos, ["acme/web", "acme/docs"]);
    assert_eq!(b.projects, ["p2", "p3"]);
    assert_eq!(b.since, datetime!(2026-10-16 9:00 UTC));
    // The refusals are said as one; the timeout is counted.
    assert_eq!(other_failures(&runs), 1);
}

#[test]
fn the_middle_wait_and_quiet_days() {
    assert_eq!(median(&[5, 1, 3]), Some(3.0));
    assert_eq!(median(&[1, 2, 3, 4]), Some(2.5));
    assert_eq!(median(&[]), None);
    let now = datetime!(2026-10-19 12:00 UTC);
    assert_eq!(days_since(Some("2026-10-01T12:00:00Z"), now), Some(18));
    assert_eq!(days_since(None, now), None);
    assert_eq!(days_since(Some("yesterday"), now), None);
}

// ── Workspaces, worst first ──

fn workspace(id: u128, name: &str) -> Row {
    Row {
        id: Uuid::from_u128(id),
        name: name.into(),
        ..Row::default()
    }
}

fn project(id: u128, name: &str, ws: u128, extra: impl FnOnce(&mut Row)) -> Row {
    let mut r = Row {
        id: Uuid::from_u128(id),
        name: name.into(),
        workspace: Some(Uuid::from_u128(ws)),
        last_at: Some("2026-10-18T00:00:00Z".into()),
        ..Row::default()
    };
    extra(&mut r);
    r
}

#[test]
fn the_workspace_in_most_trouble_comes_first_and_says_why() {
    let now = datetime!(2026-10-19 12:00 UTC);
    let rows = [
        workspace(1, "Calm"),
        workspace(2, "Fire"),
        project(11, "ok", 1, |_| {}),
        project(21, "broken", 2, |_| {}),
        project(22, "slow", 2, |r| {
            r.specs_failing = Some(1);
            r.last_at = Some("2026-09-01T00:00:00Z".into());
        }),
    ];
    let id = |n: u128| Uuid::from_u128(n).to_string();
    let spend = BTreeMap::from([(id(21), 30.0), (id(22), 10.0), (id(11), 5.0)]);
    let previous = BTreeMap::from([(id(21), 10.0), (id(11), 5.0)]);
    let stuck = BTreeMap::from([(id(22), 2)]);
    let broken = BTreeSet::from([id(21)]);
    let health = workspace_health(
        &rows,
        &HealthInputs {
            spend: Some(&spend),
            previous: Some(&previous),
            stuck: &stuck,
            broken: &broken,
            now,
        },
    );
    assert_eq!(
        health.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(),
        ["Fire", "Calm"]
    );
    let fire = &health[0];
    assert_eq!(
        fire.projects
            .iter()
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>(),
        ["broken", "slow"]
    );
    assert_eq!(
        fire.projects[0].reasons,
        [Reason::Refused, Reason::SpendGrows(2.0)]
    );
    assert_eq!(
        fire.projects[1].reasons,
        [Reason::SpecsFailing(1), Reason::Stuck(2), Reason::Quiet(48)]
    );
    assert_eq!(
        (
            fire.spend,
            fire.previous,
            fire.specs_failing,
            fire.stuck,
            fire.quiet_days
        ),
        (Some(40.0), Some(10.0), 1, 2, Some(1))
    );
    assert!(health[1].projects[0].reasons.is_empty());

    // Without costs, spend is unknown rather than zero.
    let blind = workspace_health(
        &rows,
        &HealthInputs {
            spend: None,
            previous: None,
            stuck: &stuck,
            broken: &broken,
            now,
        },
    );
    assert!(blind.iter().all(|w| w.spend.is_none()));
}

// ── People ──

#[test]
fn an_idle_member_is_one_no_block_saw_at_work() {
    let members = [member("ada", &[]), member("bob", &[]), member("cid", &[])];
    let active = BTreeSet::from(["ada".to_owned(), "bob".to_owned()]);
    assert_eq!(idle(&members, &active), ["cid"]);
}

// ── What needs the leader ──

#[test]
fn a_refused_connection_comes_first_then_failed_runs() {
    let broken = [Broken {
        key: "k".into(),
        provider: "github".into(),
        status: "401",
        error: String::new(),
        repos: vec!["a/b".into()],
        projects: vec!["p1".into(), "p-unknown".into()],
        since: datetime!(2026-10-19 0:00 UTC),
    }];
    let names = BTreeMap::from([("p1".to_owned(), "Shop".to_owned())]);
    let all = needs(&NeedInputs {
        broken: &broken,
        project_names: &names,
        other_failures: 1,
    });
    assert_eq!(
        all,
        [
            Need::Refused {
                provider: "github".into(),
                status: "401",
                projects: vec!["Shop".into()],
                repos: 1
            },
            Need::RunsFailed { runs: 1 }
        ]
    );
    let calm = needs(&NeedInputs {
        broken: &[],
        project_names: &names,
        other_failures: 0,
    });
    assert!(calm.is_empty());
}

// ── The answer ──

/// A kit's block, as its gear would register it (the kits' own are tested
/// in their gears).
struct Fake;

#[async_trait::async_trait]
impl blocks::BlockSource for Fake {
    async fn answer(
        &self,
        _hub: &ClientHub,
        _ctx: &SecurityContext,
        _prepared: blocks::Prepared,
        _scope: &BlockScope<'_>,
    ) -> Option<BlockAnswer> {
        None
    }
}

static MONEY: OverviewBlock = OverviewBlock {
    kit: "kit-money",
    gear: "test",
    id: "money",
    order: 10,
    level: Level::Organization,
    source: &Fake,
};
static WORK: OverviewBlock = OverviewBlock {
    kit: "kit-work",
    gear: "test",
    id: "work",
    order: 20,
    level: Level::Organization,
    source: &Fake,
};

fn p1() -> String {
    Uuid::from_u128(11).to_string()
}

/// Spend 40 against 20 on the project, Ada seen spending.
fn money(activity: Activity) -> BlockAnswer {
    BlockAnswer {
        tile: Some(TileDto {
            title: english("Spend"),
            ..TileDto::default()
        }),
        needs: vec![BlockNeedDto {
            key: "spend".into(),
            tone: "warn".into(),
            sentence: LineDto::new(english("Spend grows")),
            ..BlockNeedDto::default()
        }],
        signals: Signals {
            spend: Some(BTreeMap::from([(p1(), 40.0)])),
            previous: Some(BTreeMap::from([(p1(), 20.0)])),
            activity,
            ..Signals::default()
        },
        data: json!({ "costs": "shown" }),
    }
}

/// Two pull requests stuck in the project, Bob seen on one.
fn work() -> BlockAnswer {
    BlockAnswer {
        signals: Signals {
            stuck: Some(BTreeMap::from([(p1(), 2)])),
            activity: Activity::Seen(BTreeSet::from(["person-bob".to_owned()])),
            ..Signals::default()
        },
        ..BlockAnswer::default()
    }
}

fn read(blocks: Vec<(&'static OverviewBlock, BlockAnswer)>) -> Read {
    let p1 = Uuid::from_u128(11);
    Read {
        name: "Acme".into(),
        rows: vec![
            workspace(1, "Payments"),
            project(11, "Checkout", 1, |r| {
                r.specs = Some(4);
                r.specs_failing = Some(1);
            }),
        ],
        members: Some(vec![
            member("person-ada", &[ADA]),
            member("person-bob", &[BOB]),
            member("person-cid", &[GONE]),
        ]),
        names: BTreeMap::from([("person-ada".to_owned(), "Ada".to_owned())]),
        runs: Some(vec![run(
            "failed",
            "acme/checkout",
            Some("401 Bad credentials"),
            datetime!(2026-10-19 9:00 UTC),
            &p1.to_string(),
        )]),
        windows: windows(datetime!(2026-10-19 12:00 UTC)),
        kits: Kits::All,
        blocks,
    }
}

#[test]
fn the_blocks_come_back_in_their_order_and_feed_the_health_and_the_idle() {
    let now = datetime!(2026-10-19 12:00 UTC);
    let dto = compose(
        ORG,
        &read(vec![
            (&MONEY, money(Activity::Seen(BTreeSet::from(["person-ada".to_owned()])))),
            (&WORK, work()),
        ]),
        now,
    );
    let blocks: Vec<(&str, &str)> = dto
        .blocks
        .iter()
        .map(|b| (b.kit.as_str(), b.id.as_str()))
        .collect();
    assert_eq!(blocks, [("kit-money", "money"), ("kit-work", "work")]);
    assert_eq!(dto.blocks[0].needs[0].key, "spend");
    assert!(dto.blocks[1].tile.is_none());
    assert_eq!(dto.blocks[0].data["costs"], "shown");

    // The organization's own needs are the core's: the refused connection.
    assert_eq!(
        dto.needs.iter().map(|n| n.kind.as_str()).collect::<Vec<_>>(),
        ["connection"]
    );
    assert_eq!(dto.needs[0].projects, ["Checkout"]);

    // The project's health reads both blocks' signals and its own row.
    let checkout = &dto.workspaces[0].projects[0];
    assert_eq!((checkout.spend, checkout.previous, checkout.stuck), (Some(40.0), Some(20.0), 2));
    assert!(checkout.broken);
    let reasons: Vec<&str> = checkout.reasons.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(reasons, ["refused", "specs_failing", "stuck", "spend_grows"]);
    assert_eq!(dto.workspaces[0].spend, Some(40.0));

    // Ada spent, Bob is on a pull request: Cid is idle.
    assert_eq!(dto.people.active, Some(3));
    let idle: Vec<&str> = dto
        .people
        .idle
        .as_ref()
        .unwrap()
        .iter()
        .map(|p| p.person_id.as_str())
        .collect();
    assert_eq!(idle, ["person-cid"]);
}

#[test]
fn without_a_kits_block_its_part_is_gone_and_the_rest_stands() {
    let now = datetime!(2026-10-19 12:00 UTC);
    // No block at all: an empty Studio's overview.
    let bare = compose(ORG, &read(vec![]), now);
    assert!(bare.blocks.is_empty());
    assert_eq!(bare.needs.len(), 1);
    let checkout = &bare.workspaces[0].projects[0];
    assert_eq!((checkout.spend, checkout.stuck), (None, 0));
    assert!(checkout.broken);
    // Nobody watched who works, so nobody is called idle.
    assert_eq!(bare.people.active, Some(3));
    assert!(bare.people.idle.is_none());

    // Only the work block: no spend anywhere, idleness from pull requests.
    let work_only = compose(ORG, &read(vec![(&WORK, work())]), now);
    assert!(work_only.workspaces[0].spend.is_none());
    assert_eq!(work_only.workspaces[0].projects[0].stuck, 2);
    assert_eq!(work_only.people.idle.as_ref().unwrap().len(), 2);

    // A block that could not tell who works (costs hidden): nobody is idle.
    let hidden = compose(
        ORG,
        &read(vec![(&MONEY, money(Activity::Unknown)), (&WORK, work())]),
        now,
    );
    assert!(hidden.people.idle.is_none());
}

#[test]
fn the_kits_the_answer_was_computed_for_are_said() {
    let now = datetime!(2026-10-19 12:00 UTC);
    assert!(compose(ORG, &read(vec![]), now).kits.is_none());
    let only = Read {
        kits: Kits::Only(vec!["kit-work".into()]),
        ..read(vec![(&WORK, work())])
    };
    assert_eq!(
        compose(ORG, &only, now).kits.as_deref(),
        Some(&["kit-work".to_owned()][..])
    );
}

// ── Answers kept between requests ────────────────────────────────────────────

#[test]
fn a_kept_overview_is_served_to_the_same_caller() {
    let answers: Answers<u32> = Answers::default();
    answers.put(ORG, ADA, 7);
    assert_eq!(answers.get(ORG, ADA), Some(7));
}

#[test]
fn one_callers_overview_is_not_anothers() {
    // The money is there only for someone who may see costs, so an answer
    // read as one person is never shown to another.
    let answers: Answers<u32> = Answers::default();
    answers.put(ORG, ADA, 7);
    assert_eq!(answers.get(ORG, BOB), None);
}

#[test]
fn one_organizations_overview_is_not_anothers() {
    let answers: Answers<u32> = Answers::default();
    answers.put(ORG, ADA, 7);
    assert_eq!(answers.get(GONE, ADA), None);
}

#[test]
fn an_overview_past_its_minute_is_read_again() {
    let answers: Answers<u32> = Answers::with_ttl(std::time::Duration::ZERO);
    answers.put(ORG, ADA, 7);
    assert_eq!(answers.get(ORG, ADA), None);
}

/// The Workspaces tree's project rows say each project's phase, from the
/// same rollup rows; a phase never moves the score.
#[test]
fn a_project_s_phase_reaches_its_health_and_never_scores() {
    let rows = [
        workspace(1, "W"),
        project(11, "built", 1, |r| r.phase = Some("build".into())),
        project(12, "none", 1, |_| {}),
    ];
    let health = workspace_health(
        &rows,
        &HealthInputs {
            spend: None,
            previous: None,
            stuck: &BTreeMap::new(),
            broken: &BTreeSet::new(),
            now: datetime!(2026-10-19 12:00 UTC),
        },
    );
    let phase = |name: &str| {
        health[0]
            .projects
            .iter()
            .find(|p| p.name == name)
            .unwrap()
            .clone()
    };
    assert_eq!(phase("built").phase.as_deref(), Some("build"));
    assert_eq!(phase("none").phase, None);
    assert_eq!(phase("built").score, phase("none").score);
}
