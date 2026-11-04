//! Reads part of a document, refusing any path that resolves outside the searched folder.

use std::fs;
use std::path::Path;

/// Lines `from` (1-based) onwards of `rel` under `root`, at most `count` of them when given.
pub fn slice(root: &Path, rel: &str, from: usize, count: Option<usize>) -> Result<String, String> {
    let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let full = fs::canonicalize(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    if !full.starts_with(&root) {
        return Err(format!("{rel}: outside {}", crate::index::shown(&root)));
    }
    let bytes = fs::read(&full).map_err(|e| format!("{rel}: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let lines = text.lines().skip(from.saturating_sub(1));
    let mut out = String::new();
    for line in lines.take(count.unwrap_or(usize::MAX)) {
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::slice;

    #[test]
    fn slices_lines_and_refuses_escapes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.path().join("secret.md"), "outside\n").unwrap();
        assert_eq!(slice(&root, "a.md", 2, Some(1)).unwrap(), "two\n");
        assert_eq!(slice(&root, "a.md", 1, None).unwrap(), "one\ntwo\nthree\n");
        assert!(
            slice(&root, "../secret.md", 1, None)
                .unwrap_err()
                .contains("outside")
        );
        assert!(slice(&root, "missing.md", 1, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_out_of_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(dir.path().join("secret.md"), "outside\n").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.md"), root.join("link.md")).unwrap();
        assert!(
            slice(&root, "link.md", 1, None)
                .unwrap_err()
                .contains("outside")
        );
    }
}
