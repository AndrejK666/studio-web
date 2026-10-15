use super::*;

fn paths(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn parts_are_found_by_what_the_files_are() {
    let files = paths(&[
        "charts/app/Chart.yaml",
        "charts/app/values.yaml",
        "charts/app/values-prod.yaml",
        "charts/app/templates/deployment.yaml",
        "Dockerfile",
        "docker-compose.yml",
        "infra/main.tf",
        "infra/variables.tf",
        "deploy/k8s/service.yaml",
        ".github/workflows/deploy-dev.yml",
        ".github/workflows/ci.yml",
        "config/app.yaml",
        "config/log.yaml",
        ".env.example",
        "studio-backend/config/docker.yaml",
        "db/migrations/0001_init.sql",
        "db/migrations/0002_users.sql",
        "prisma/schema.prisma",
        "node_modules/x/Chart.yaml",
        "src/main.rs",
    ]);
    let found = detect("acme/app", &files);
    let got: Vec<(&str, &str)> = found
        .iter()
        .map(|p| (p.kind, p.reference.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            ("configuration", ".env.example"),
            ("configuration", "charts/app/values-prod.yaml"),
            ("configuration", "charts/app/values.yaml"),
            ("configuration", "config"),
            ("configuration", "studio-backend/config"),
            ("deployment", ".github/workflows/deploy-dev.yml"),
            ("deployment", "Dockerfile"),
            ("deployment", "charts/app"),
            ("deployment", "deploy/k8s"),
            ("deployment", "docker-compose.yml"),
            ("deployment", "infra"),
            ("storage", "db/migrations"),
            ("storage", "prisma/schema.prisma"),
        ]
    );
    let chart = found
        .iter()
        .find(|p| p.reference == "charts/app")
        .expect("chart");
    assert_eq!(chart.name, "app");
    assert_eq!(chart.evidence, "Helm chart");
}
