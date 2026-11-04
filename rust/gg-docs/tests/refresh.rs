//! The index follows the folder: additions, edits, renames, deletions, ignore rules and links.

use std::fs;
use std::path::Path;

use gg_docs::index::{Index, Refresh};
use gg_docs::search::search;

fn paths(index: &Index, query: &str) -> Vec<String> {
    search(&index.conn, query, 10)
        .unwrap()
        .into_iter()
        .map(|h| h.path)
        .collect()
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn open(dir: &tempfile::TempDir) -> Index {
    Index::open(
        &dir.path().join("index/docs.sqlite"),
        &dir.path().join("root"),
    )
    .unwrap()
}

fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    fs::create_dir_all(&root).unwrap();
    (dir, root)
}

#[test]
fn bulk_rebuilds_and_live_updates_both_stay_searchable() {
    let (dir, root) = setup();
    // More new text (about 300 KiB) than a live update takes, so the first refresh rebuilds the
    // FTS index in bulk.
    let filler = "filler ".repeat(170);
    for i in 0..250 {
        write(
            &root,
            &format!("n{i:03}.md"),
            &format!("# Note {i}\n{filler}\n"),
        );
    }
    write(&root, "a.md", "# Alpha\nthe heron flies\n");
    let mut index = open(&dir);
    assert_eq!(index.refresh().unwrap().added, 251);
    assert_eq!(paths(&index, "heron"), ["a.md"]);

    // Enough live edits to pass a segment merge; each edit also changes the file's size.
    for round in 1..20 {
        write(
            &root,
            "a.md",
            &format!("# Alpha\nmarker{round} {}\n", "x".repeat(round)),
        );
        assert_eq!(index.refresh().unwrap().updated, 1);
        assert_eq!(paths(&index, &format!("marker{round}")), ["a.md"]);
        assert!(paths(&index, &format!("marker{}", round - 1)).is_empty());
    }
    assert!(paths(&index, "heron").is_empty());
    assert_eq!(paths(&index, "note 7").len(), 10);
}

#[test]
fn edits_renames_and_deletions_are_seen_on_the_next_refresh() {
    let (dir, root) = setup();
    write(&root, "a.md", "# Alpha\nthe heron flies\n");
    write(&root, "notes/b.md", "# Beta\nthe kestrel hovers\n");
    let mut index = open(&dir);
    let first = index.refresh().unwrap();
    assert_eq!((first.added, first.updated, first.removed), (2, 0, 0));
    assert_eq!(paths(&index, "heron"), ["a.md"]);

    write(&root, "a.md", "# Alpha\nthe egret wades, a longer line\n");
    fs::rename(root.join("notes/b.md"), root.join("notes/c.md")).unwrap();
    let second = index.refresh().unwrap();
    assert_eq!((second.added, second.updated, second.removed), (1, 1, 1));
    assert!(paths(&index, "heron").is_empty());
    assert_eq!(paths(&index, "egret"), ["a.md"]);
    assert_eq!(paths(&index, "kestrel"), ["notes/c.md"]);

    fs::remove_file(root.join("a.md")).unwrap();
    assert_eq!(index.refresh().unwrap().removed, 1);
    assert!(paths(&index, "egret").is_empty());
    assert_eq!(
        index.refresh().unwrap(),
        Refresh {
            unchanged: 1,
            ..Refresh::default()
        }
    );
}

#[test]
fn a_reopened_index_keeps_its_documents() {
    let (dir, root) = setup();
    write(&root, "a.md", "# Alpha\nthe heron flies\n");
    open(&dir).refresh().unwrap();
    let mut again = open(&dir);
    assert_eq!(again.refresh().unwrap().unchanged, 1);
    assert_eq!(paths(&again, "heron"), ["a.md"]);
}

#[test]
fn ignore_rules_and_dot_folders() {
    let (dir, root) = setup();
    fs::create_dir_all(root.join(".git")).unwrap();
    write(&root, ".gitignore", "secret/\n");
    write(&root, "secret/s.md", "the heron is hidden\n");
    write(&root, ".git/x.md", "the heron is in git\n");
    write(&root, ".trail/learnings/l.md", "the heron is a learning\n");
    write(&root, "code.rs", "// the heron is code\n");
    let mut index = open(&dir);
    index.refresh().unwrap();
    assert_eq!(paths(&index, "heron"), [".trail/learnings/l.md"]);
}

#[test]
fn malformed_and_binary_files_do_not_stop_a_refresh() {
    let (dir, root) = setup();
    write(
        &root,
        "unclosed.md",
        "---\ntitle: never closed\n``` unclosed fence\n# heron\n",
    );
    fs::write(
        root.join("bytes.md"),
        [0xff, 0xfe, b'h', b'e', b'r', b'o', b'n', 0x00],
    )
    .unwrap();
    write(&root, "empty.md", "");
    let mut index = open(&dir);
    assert_eq!(index.refresh().unwrap().added, 3);
    let mut found = paths(&index, "heron");
    found.sort();
    assert_eq!(found, ["bytes.md", "unclosed.md"]);
}

#[cfg(unix)]
#[test]
fn links_out_of_the_folder_are_not_followed() {
    let (dir, root) = setup();
    write(dir.path(), "outside/o.md", "the heron is outside\n");
    std::os::unix::fs::symlink(dir.path().join("outside"), root.join("linked")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("outside/o.md"), root.join("file.md")).unwrap();
    let mut index = open(&dir);
    index.refresh().unwrap();
    assert!(paths(&index, "heron").is_empty());
}

#[test]
fn moving_the_index_to_another_folder_rebuilds_it() {
    let (dir, root) = setup();
    write(&root, "a.md", "the heron flies\n");
    open(&dir).refresh().unwrap();
    let other = dir.path().join("other");
    write(&other, "b.md", "the kestrel hovers\n");
    let mut index = Index::open(&dir.path().join("index/docs.sqlite"), &other).unwrap();
    index.refresh().unwrap();
    assert!(paths(&index, "heron").is_empty());
    assert_eq!(paths(&index, "kestrel"), ["b.md"]);
}
