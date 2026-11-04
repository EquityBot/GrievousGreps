use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use gg_docs::index::{Index, Refresh};
use gg_docs::search::{self, Hit};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The version of the `--json` output, which GrievousGreps checks. Adding a field or a command
/// keeps it; removing or renaming a field, or changing its meaning or type, bumps it.
const PROTOCOL: u32 = 1;

/// Ranked search over a folder's Markdown, refreshed before every query.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// Folder to search.
    #[arg(long, default_value = ".", global = true)]
    root: PathBuf,
    /// Index file. Defaults to one per folder under $TRAIL_HOME/docs (~/.trail/docs).
    #[arg(long, global = true)]
    db: Option<PathBuf>,
    /// Refuse to run, before reading anything, unless this is the protocol the binary speaks.
    #[arg(long, global = true, value_name = "N")]
    protocol: Option<u32>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Best-matching documents for a query, best first.
    Search {
        query: Vec<String>,
        /// Number of results.
        #[arg(short = 'n', default_value_t = 10)]
        limit: usize,
        #[arg(long)]
        json: bool,
    },
    /// Print a document, or part of it, by its path relative to the folder.
    Get {
        path: String,
        /// First line to print, from 1.
        #[arg(long, default_value_t = 1)]
        from: usize,
        /// Number of lines to print.
        #[arg(short = 'l', long)]
        lines: Option<usize>,
    },
    /// Refresh the index and report what changed.
    Update {
        #[arg(long)]
        json: bool,
    },
    /// Indexed document and section counts.
    Status {
        #[arg(long)]
        json: bool,
    },
}

fn default_db(root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let home = match std::env::var_os("TRAIL_HOME") {
        Some(dir) => PathBuf::from(dir),
        None => std::env::home_dir()
            .ok_or("no home folder; pass --db")?
            .join(".trail"),
    };
    let key = gg_docs::index::hex(&Sha256::digest(root.to_string_lossy().as_bytes()));
    Ok(home.join("docs").join(format!("{}.turso", &key[..16])))
}

/// One `--json` answer: an object carrying `protocol` beside the command's own fields.
fn print_json(mut fields: Value) -> io::Result<()> {
    fields["protocol"] = json!(PROTOCOL);
    writeln!(io::stdout().lock(), "{fields}")
}

fn print_hits(hits: &[Hit], as_json: bool) -> io::Result<()> {
    if as_json {
        let rows: Vec<_> = hits
            .iter()
            .map(|h| {
                json!({"path": h.path, "line": h.line, "title": h.title, "heading": h.heading,
                            "snippet": h.snippet, "score": h.score})
            })
            .collect();
        return print_json(json!({ "hits": rows }));
    }
    let mut out = io::stdout().lock();
    for h in hits {
        for line in text_lines(h) {
            writeln!(out, "{line}")?;
        }
    }
    Ok(())
}

/// A hit as text: `path:line` and its title, then its heading and snippet indented. Every line is
/// read by an agent as tokens, so a title or heading that only repeats the file name is left out.
fn text_lines(h: &Hit) -> Vec<String> {
    let stem = plain(
        Path::new(&h.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
    );
    let title = plain(&h.title);
    let mut out = vec![if title.is_empty() || title == stem {
        format!("{}:{}", h.path, h.line)
    } else {
        format!("{}:{}  {}", h.path, h.line, h.title)
    }];
    let heading = plain(&h.heading);
    if !heading.is_empty() && heading != stem && heading != title {
        out.push(format!("  {}", h.heading));
    }
    if !h.snippet.is_empty() {
        out.push(format!("  {}", h.snippet));
    }
    out
}

/// Letters and digits only, lower-cased, so 'Mermaid palette' matches `mermaid-palette`.
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn print_update(r: &Refresh, as_json: bool) -> io::Result<()> {
    if as_json {
        return print_json(
            json!({"added": r.added, "updated": r.updated, "removed": r.removed,
                                  "unchanged": r.unchanged, "skipped_large": r.skipped_large}),
        );
    }
    writeln!(
        io::stdout().lock(),
        "added {}, updated {}, removed {}, unchanged {}, skipped over 4 MiB {}",
        r.added,
        r.updated,
        r.removed,
        r.unchanged,
        r.skipped_large
    )
}

fn print_status(index: &Index, as_json: bool) -> Result<(), String> {
    let (docs, chunks) = index.counts()?;
    let root = gg_docs::index::shown(index.root());
    let printed = if as_json {
        print_json(json!({"root": root, "documents": docs, "sections": chunks}))
    } else {
        writeln!(
            io::stdout().lock(),
            "{docs} documents, {chunks} sections in {root}"
        )
    };
    printed.map_err(|e| e.to_string())
}

fn run(cli: Cli) -> Result<(), String> {
    if let Some(wanted) = cli.protocol
        && wanted != PROTOCOL
    {
        return Err(format!(
            "protocol {wanted} is not supported; this gg-docs speaks protocol {PROTOCOL}"
        ));
    }
    let db = match cli.db {
        Some(db) => db,
        None => default_db(&cli.root)?,
    };
    if let Command::Get { path, from, lines } = &cli.command {
        print!("{}", gg_docs::get::slice(&cli.root, path, *from, *lines)?);
        return Ok(());
    }
    let mut index = Index::open(&db, &cli.root)?;
    let refreshed = index.refresh()?;
    match cli.command {
        Command::Get { .. } => unreachable!("handled before the index opens"),
        Command::Search { query, limit, json } => {
            let hits = search::search(&index.conn, &query.join(" "), limit)?;
            print_hits(&hits, json).map_err(|e| e.to_string())
        }
        Command::Update { json } => print_update(&refreshed, json).map_err(|e| e.to_string()),
        Command::Status { json } => print_status(&index, json),
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("gg-docs: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Hit, text_lines};

    fn hit(path: &str, title: &str, heading: &str) -> Hit {
        Hit {
            path: path.into(),
            line: 8,
            title: title.into(),
            heading: heading.into(),
            snippet: "the palette".into(),
            score: 1.0,
        }
    }

    #[test]
    fn titles_and_headings_that_repeat_the_file_name_are_left_out() {
        let repeated = hit(
            "memory/mermaid-palette.md",
            "mermaid-palette",
            "Mermaid palette",
        );
        assert_eq!(
            text_lines(&repeated),
            ["memory/mermaid-palette.md:8", "  the palette"]
        );
        let distinct = hit("tasks/x-2026.md", "Palette work", "Palette work > Goal");
        assert_eq!(
            text_lines(&distinct),
            [
                "tasks/x-2026.md:8  Palette work",
                "  Palette work > Goal",
                "  the palette"
            ]
        );
        let same_heading = hit("tasks/x.md", "Palette work", "Palette work");
        assert_eq!(
            text_lines(&same_heading),
            ["tasks/x.md:8  Palette work", "  the palette"]
        );
    }
}
