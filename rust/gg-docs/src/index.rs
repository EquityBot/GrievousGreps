//! The on-disk index: one Turso database whose `chunks` table carries a Tantivy-backed FTS index,
//! refreshed from the folder before each use. The index is a cache of the folder, so an index
//! from another schema version or folder is rebuilt rather than migrated.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use turso::{Builder, Connection};

use crate::markdown;

/// Bump when the schema or what is indexed changes; an index with another version is rebuilt.
const SCHEMA_VERSION: &str = "4";
const EXTENSIONS: [&str; 4] = ["md", "markdown", "mdx", "txt"];
/// Larger files are skipped and counted, not indexed.
pub const MAX_BYTES: u64 = 4 << 20;
/// How long to wait for another process to release the index. Turso opens a database for one
/// process at a time (its multi-process WAL is experimental and unsupported on Windows).
const LOCK_WAIT: Duration = Duration::from_secs(15);

const SCHEMA: &str = "
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE docs(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER NOT NULL,
                  mtime_ns INTEGER NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, line INTEGER NOT NULL,
                    path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX chunks_doc ON chunks(doc_id);
";

/// Tantivy scores each field on its own, so these weights differ from the FTS5 column weights
/// gg-docs used before: on the tuning queries, body at 2.0 matched FTS5's recall@10 with a
/// higher MRR, whilst path at 3.0 cost recall.
const FTS_INDEX: &str = "CREATE INDEX chunk_fts ON chunks USING fts (path, title, heading, body)
    WITH (tokenizer = 'en_stem', weights = 'path=1.0,title=1.0,heading=1.0,body=2.0')";

/// A refresh that reads more than this many bytes of new or edited files writes its rows without
/// the FTS index and rebuilds the index once afterwards, which is far faster in bulk (22,509
/// sections: about 1.4 s, against about 150 s row by row). Bulk writes also commit every
/// `BATCH_BYTES`, so a first index of a large folder does not hold it all in memory.
/// shortcut: fixed sizes; the live-versus-bulk crossover grows with the folder, so a ratio to the
/// indexed size would fit very large folders better.
const LIVE_BYTES: u64 = 256 << 10;
const BATCH_BYTES: u64 = 8 << 20;
/// Tantivy segments are not merged automatically; merge after this many live updates.
const OPTIMIZE_EVERY: i64 = 16;

pub struct Index {
    pub conn: Connection,
    root: PathBuf,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refresh {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub skipped_large: usize,
}

struct Stored {
    id: i64,
    size: i64,
    mtime_ns: i64,
    hash: String,
}

impl Index {
    /// Opens or creates the index at `db` for the folder `root`, rebuilding it if its schema
    /// version or root differs, and waiting up to `LOCK_WAIT` for another process to finish.
    pub fn open(db: &Path, root: &Path) -> Result<Self, String> {
        if let Some(dir) = db.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
        pollster::block_on(Self::open_async(db, root))
    }

    async fn open_async(db: &Path, root: PathBuf) -> Result<Self, String> {
        let path = db
            .to_str()
            .ok_or_else(|| format!("{}: not UTF-8", db.display()))?;
        let conn = connect(path).await?;
        let root_text = root.to_string_lossy().into_owned();
        let current = meta(&conn, "schema").await.as_deref() == Some(SCHEMA_VERSION)
            && meta(&conn, "root").await.as_deref() == Some(root_text.as_str());
        if !current {
            reset(&conn, &root_text).await?;
        } else if !has_fts(&conn).await? {
            // A bulk rebuild stopped between dropping and recreating the FTS index.
            conn.execute(FTS_INDEX, ()).await.map_err(sql)?;
        }
        Ok(Self { conn, root })
    }

    /// Brings the index in line with the folder: new, edited, renamed and deleted files.
    pub fn refresh(&mut self) -> Result<Refresh, String> {
        pollster::block_on(self.refresh_async())
    }

    async fn refresh_async(&mut self) -> Result<Refresh, String> {
        let mut stored = self.stored().await?;
        let mut stats = Refresh::default();
        let candidates = self.scan(&mut stored, &mut stats);
        if candidates.is_empty() && stored.is_empty() {
            return Ok(stats);
        }
        let bulk = candidates.iter().map(|c| c.2.unsigned_abs()).sum::<u64>() > LIVE_BYTES;
        if bulk {
            self.conn
                .execute("DROP INDEX chunk_fts", ())
                .await
                .map_err(sql)?;
        }
        let mut writer = Writer::new(&self.conn, if bulk { BATCH_BYTES } else { u64::MAX });
        for (rel, full, size, mtime_ns) in candidates {
            // pollster runs this one future on this thread, so a blocking read stalls nothing else.
            let Ok(bytes) = fs::read(&full) else { continue }; // NOSONAR: see above
            let hash = hex(&Sha256::digest(&bytes));
            match stored.remove(&rel) {
                Some(old) if old.hash == hash => {
                    writer.touch(old.id, size, mtime_ns).await?;
                    stats.unchanged += 1;
                }
                old => {
                    if let Some(old) = &old {
                        writer.remove(old.id).await?;
                        stats.updated += 1;
                    } else {
                        stats.added += 1;
                    }
                    let parsed = markdown::parse(&String::from_utf8_lossy(&bytes), stem(&rel));
                    let doc = (rel.as_str(), size, mtime_ns, hash.as_str());
                    writer.insert(doc, &parsed, bytes.len() as u64).await?;
                }
            }
        }
        stats.removed = stored.len();
        for old in stored.into_values() {
            writer.remove(old.id).await?;
        }
        let changed = writer.finish().await?;
        if bulk {
            self.conn.execute(FTS_INDEX, ()).await.map_err(sql)?;
            set_meta(&self.conn, "live_updates", "0").await?;
        } else if changed {
            self.count_live_update().await?;
        }
        Ok(stats)
    }

    /// Files to read, as (relative path, full path, size, mtime_ns): those whose size or
    /// modification time differ from `stored`. Unchanged files leave `stored` and are counted;
    /// an unreadable or oversized file stays in `stored`, so the refresh removes it.
    fn scan(
        &self,
        stored: &mut HashMap<String, Stored>,
        stats: &mut Refresh,
    ) -> Vec<(String, PathBuf, i64, i64)> {
        let mut candidates = Vec::new();
        for (rel, full) in walk(&self.root) {
            let Ok(md) = fs::metadata(&full) else {
                continue;
            };
            if md.len() > MAX_BYTES {
                stats.skipped_large += 1;
                continue;
            }
            let (size, mtime_ns) = stamp(&md);
            if let Some(old) = stored.get(&rel)
                && old.size == size
                && old.mtime_ns == mtime_ns
            {
                stored.remove(&rel);
                stats.unchanged += 1;
                continue;
            }
            candidates.push((rel, full, size, mtime_ns));
        }
        candidates
    }

    async fn stored(&self) -> Result<HashMap<String, Stored>, String> {
        let mut rows = self
            .conn
            .query("SELECT path, id, size, mtime_ns, hash FROM docs", ())
            .await
            .map_err(sql)?;
        let mut out = HashMap::new();
        while let Some(row) = rows.next().await.map_err(sql)? {
            let stored = Stored {
                id: row.get(1).map_err(sql)?,
                size: row.get(2).map_err(sql)?,
                mtime_ns: row.get(3).map_err(sql)?,
                hash: row.get(4).map_err(sql)?,
            };
            out.insert(row.get(0).map_err(sql)?, stored);
        }
        Ok(out)
    }

    /// Counts a live FTS update and merges Tantivy's segments every `OPTIMIZE_EVERY` of them.
    async fn count_live_update(&self) -> Result<(), String> {
        let done: i64 = meta(&self.conn, "live_updates")
            .await
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
            + 1;
        if done >= OPTIMIZE_EVERY {
            self.conn
                .execute("OPTIMIZE INDEX chunk_fts", ())
                .await
                .map_err(sql)?;
            return set_meta(&self.conn, "live_updates", "0").await;
        }
        set_meta(&self.conn, "live_updates", &done.to_string()).await
    }

    /// Number of indexed documents and chunks.
    pub fn counts(&self) -> Result<(i64, i64), String> {
        pollster::block_on(async {
            let docs = count(&self.conn, "docs").await?;
            Ok((docs, count(&self.conn, "chunks").await?))
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// A canonical path for people to read, without the `\\?\` prefix Windows canonicalising adds.
pub fn shown(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => text.into_owned(),
    }
}

/// Lower-case hexadecimal of a digest.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sql(e: turso::Error) -> String {
    format!("index: {e}")
}

/// Opens the database, retrying whilst another process holds it.
async fn connect(path: &str) -> Result<Connection, String> {
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        let opened = Builder::new_local(path)
            .experimental_index_method(true)
            .build()
            .await;
        match opened {
            Ok(db) => return db.connect().map_err(sql),
            // Turso reports a held lock only in its message ("File is locked by another process").
            Err(e) if e.to_string().contains("locked") && Instant::now() < deadline => {
                // pollster has no timer, and this future is the only one on the thread.
                std::thread::sleep(Duration::from_millis(25)); // NOSONAR: see above
            }
            Err(e) => return Err(format!("{path}: {e}")),
        }
    }
}

async fn meta(conn: &Connection, key: &str) -> Option<String> {
    let mut rows = conn
        .query("SELECT value FROM meta WHERE key = ?1", [key])
        .await
        .ok()?;
    rows.next().await.ok()??.get(0).ok()
}

async fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO meta VALUES (?1, ?2)", [key, value])
        .await
        .map_err(sql)?;
    Ok(())
}

async fn count(conn: &Connection, table: &str) -> Result<i64, String> {
    let mut rows = conn
        .query(format!("SELECT count(*) FROM {table}"), ())
        .await
        .map_err(sql)?;
    let row = rows.next().await.map_err(sql)?.ok_or("index: no count")?;
    row.get(0).map_err(sql)
}

async fn has_fts(conn: &Connection) -> Result<bool, String> {
    let mut rows = conn
        .query("SELECT 1 FROM sqlite_schema WHERE name = 'chunk_fts'", ())
        .await
        .map_err(sql)?;
    Ok(rows.next().await.map_err(sql)?.is_some())
}

async fn reset(conn: &Connection, root: &str) -> Result<(), String> {
    conn.execute("DROP INDEX IF EXISTS chunk_fts", ())
        .await
        .map_err(sql)?;
    for table in ["meta", "docs", "chunks"] {
        conn.execute(format!("DROP TABLE IF EXISTS {table}"), ())
            .await
            .map_err(sql)?;
    }
    conn.execute_batch(SCHEMA).await.map_err(sql)?;
    conn.execute(FTS_INDEX, ()).await.map_err(sql)?;
    set_meta(conn, "schema", SCHEMA_VERSION).await?;
    set_meta(conn, "root", root).await
}

/// Writes one refresh's changes: in one transaction for a live update, or committing every
/// `batch` bytes of input for a bulk rebuild. A failed write rolls back the open transaction;
/// earlier batches stay committed and consistent file by file, and the next refresh finishes.
struct Writer<'a> {
    conn: &'a Connection,
    batch: u64,
    written: u64,
    open: bool,
    changed: bool,
}

impl<'a> Writer<'a> {
    fn new(conn: &'a Connection, batch: u64) -> Self {
        Self {
            conn,
            batch,
            written: 0,
            open: false,
            changed: false,
        }
    }

    async fn touch(&mut self, id: i64, size: i64, mtime_ns: i64) -> Result<(), String> {
        let sql_text = "UPDATE docs SET size = ?1, mtime_ns = ?2 WHERE id = ?3";
        self.run(sql_text, (size, mtime_ns, id)).await
    }

    async fn remove(&mut self, id: i64) -> Result<(), String> {
        self.run("DELETE FROM chunks WHERE doc_id = ?1", [id])
            .await?;
        self.run("DELETE FROM docs WHERE id = ?1", [id]).await?;
        self.changed = true;
        Ok(())
    }

    /// Inserts a document, given as (path, size, mtime_ns, hash), and its sections.
    async fn insert(
        &mut self,
        (rel, size, mtime_ns, hash): (&str, i64, i64, &str),
        parsed: &markdown::Parsed,
        bytes: u64,
    ) -> Result<(), String> {
        let title = parsed.title.as_str();
        let doc = "INSERT INTO docs(path, size, mtime_ns, hash, title) VALUES (?1, ?2, ?3, ?4, ?5)";
        self.run(doc, (rel, size, mtime_ns, hash, title)).await?;
        let id = self.conn.last_insert_rowid();
        let chunk = "INSERT INTO chunks(doc_id, line, path, title, heading, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
        for c in &parsed.chunks {
            let line = i64::try_from(c.line).unwrap_or(i64::MAX);
            let row = (id, line, rel, title, c.heading.as_str(), c.body.as_str());
            self.run(chunk, row).await?;
        }
        self.changed = true;
        self.written += bytes;
        if self.written >= self.batch {
            self.written = 0;
            return self.commit().await;
        }
        Ok(())
    }

    /// Commits what is still open; true if any document was added, replaced or removed.
    async fn finish(mut self) -> Result<bool, String> {
        self.commit().await?;
        Ok(self.changed)
    }

    async fn run(&mut self, sql_text: &str, params: impl turso::IntoParams) -> Result<(), String> {
        if !self.open {
            self.conn.execute("BEGIN", ()).await.map_err(sql)?;
            self.open = true;
        }
        let done = match self.conn.prepare_cached(sql_text).await {
            Ok(mut stmt) => stmt.execute(params).await,
            Err(e) => Err(e),
        };
        if let Err(e) = done {
            // The original error matters more than a failed rollback.
            let _ = self.conn.execute("ROLLBACK", ()).await;
            self.open = false;
            return Err(sql(e));
        }
        Ok(())
    }

    async fn commit(&mut self) -> Result<(), String> {
        if self.open {
            self.open = false;
            self.conn.execute("COMMIT", ()).await.map_err(sql)?;
        }
        Ok(())
    }
}

/// Indexable files under `root` as (forward-slash relative path, full path). Honours
/// `.gitignore`, `.ignore` and git excludes, includes dot folders except `.git`, and does not
/// follow symbolic links, so nothing outside `root` is read.
fn walk(root: &Path) -> Vec<(String, PathBuf)> {
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    let mut out: Vec<_> = walker
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter(|e| {
            let ext = e.path().extension().and_then(|x| x.to_str()).unwrap_or("");
            EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        })
        .filter_map(|e| {
            let rel = e
                .path()
                .strip_prefix(root)
                .ok()?
                .to_str()?
                .replace('\\', "/");
            Some((rel, e.into_path()))
        })
        .collect();
    out.sort();
    out
}

/// The file name without its extension, a document's title of last resort.
fn stem(rel: &str) -> &str {
    Path::new(rel)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(rel)
}

/// File size and modification time in nanoseconds, as stored.
fn stamp(md: &fs::Metadata) -> (i64, i64) {
    let size = i64::try_from(md.len()).unwrap_or(i64::MAX);
    let since_epoch = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
    let mtime_ns = since_epoch.map_or(0, |d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX));
    (size, mtime_ns)
}

#[cfg(test)]
mod tests {
    use super::shown;
    use std::path::Path;

    #[test]
    fn shown_drops_only_the_local_verbatim_prefix() {
        assert_eq!(shown(Path::new(r"\\?\C:\docs")), r"C:\docs");
        assert_eq!(
            shown(Path::new(r"\\?\UNC\host\share")),
            r"\\?\UNC\host\share"
        );
        assert_eq!(shown(Path::new("/home/docs")), "/home/docs");
    }
}
