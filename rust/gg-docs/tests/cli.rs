//! The binary as GrievousGreps runs it: the protocol guard, the `--json` envelopes and exit codes.

use std::fs;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gg-docs"));
    command
        .arg("--root")
        .arg(dir.join("root"))
        .arg("--db")
        .arg(dir.join("index/docs.turso"))
        .args(args);
    command
}

fn gg_docs(dir: &Path, args: &[&str]) -> Output {
    command(dir, args).output().unwrap()
}

fn folder() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("root")).unwrap();
    fs::write(
        dir.path().join("root/claims.md"),
        "# Claims\n\nA claim lapses after four hours.\n",
    )
    .unwrap();
    dir
}

fn envelope(out: &Output) -> Value {
    assert!(out.status.success(), "{out:?}");
    let text = String::from_utf8(out.stdout.clone()).unwrap();
    assert_eq!(text.lines().count(), 1, "one JSON line: {text}");
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["protocol"], 1);
    value
}

#[test]
fn version_file_matches_the_crate() {
    // Trimmed, as a Windows checkout may end the line with CRLF.
    let version =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("VERSION")).unwrap();
    assert_eq!(version.trim_end(), env!("CARGO_PKG_VERSION"));
    let out = Command::new(env!("CARGO_BIN_EXE_gg-docs"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        format!("gg-docs {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn another_protocol_is_refused_before_anything_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let out = gg_docs(dir.path(), &["--protocol", "2", "status"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(out.stderr).unwrap(),
        "gg-docs: protocol 2 is not supported; this gg-docs speaks protocol 1\n"
    );
    assert!(out.stdout.is_empty());
    assert!(!dir.path().join("index").exists(), "no index was created");
}

#[test]
fn json_answers_carry_the_protocol() {
    let dir = folder();
    let update = envelope(&gg_docs(
        dir.path(),
        &["--protocol", "1", "update", "--json"],
    ));
    assert_eq!(update["added"], 1);
    assert_eq!(update["skipped_large"], 0);
    let search = envelope(&gg_docs(
        dir.path(),
        &["--protocol", "1", "search", "claim", "lapses", "--json"],
    ));
    assert_eq!(search["hits"][0]["path"], "claims.md");
    assert_eq!(search["hits"][0]["line"], 1);
    let status = envelope(&gg_docs(dir.path(), &["status", "--json"]));
    assert_eq!(status["documents"], 1);
    assert!(status["root"].as_str().unwrap().ends_with("root"));
}

#[test]
fn text_answers_are_unchanged_by_the_protocol_flag() {
    let dir = folder();
    let plain = gg_docs(dir.path(), &["search", "claim"]);
    let checked = gg_docs(dir.path(), &["--protocol", "1", "search", "claim"]);
    assert!(plain.status.success());
    assert_eq!(plain.stdout, checked.stdout);
    assert!(
        String::from_utf8(plain.stdout)
            .unwrap()
            .starts_with("claims.md:1")
    );
}

#[test]
fn usage_errors_exit_2_and_domain_errors_exit_1() {
    let dir = folder();
    assert_eq!(gg_docs(dir.path(), &["get"]).status.code(), Some(2));
    assert_eq!(
        gg_docs(dir.path(), &["search", "--nope"]).status.code(),
        Some(2)
    );
    let missing = gg_docs(dir.path(), &["get", "missing.md"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(
        String::from_utf8(missing.stderr)
            .unwrap()
            .starts_with("gg-docs: missing.md:")
    );
}

#[test]
fn concurrent_runs_on_one_index_all_answer() {
    let dir = folder();
    for i in 0..20 {
        let note = format!(
            "# Note {i}

A claim lapses after {i} hours.
"
        );
        fs::write(dir.path().join(format!("root/note{i}.md")), note).unwrap();
    }
    let race = |runs: &[&[&str]]| {
        let children: Vec<_> = runs
            .iter()
            .map(|args| {
                let mut command = command(dir.path(), args);
                command.stdout(Stdio::piped()).stderr(Stdio::piped());
                command.spawn().unwrap()
            })
            .collect();
        for child in children {
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{out:?}");
        }
    };
    let search: &[&str] = &["search", "claim", "lapses"];
    // The first runs find no index, so each tries to create it.
    race(&[search; 8]);
    fs::write(
        dir.path().join("root/note0.md"),
        "# Note 0

Edited.
",
    )
    .unwrap();
    race(&[
        search,
        &["update"],
        search,
        &["update"],
        search,
        &["update"],
    ]);
    assert_eq!(
        envelope(&gg_docs(dir.path(), &["status", "--json"]))["documents"],
        21
    );
}
