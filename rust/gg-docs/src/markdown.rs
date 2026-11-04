//! Splits a Markdown document into a title and heading-bounded chunks.

/// One section of a document: the text from a heading up to the next heading.
#[derive(Debug, PartialEq, Eq)]
pub struct Chunk {
    /// 1-based line of the section's heading, or 1 for text before the first heading.
    pub line: usize,
    /// The heading path, outermost first, joined with " > ".
    pub heading: String,
    pub body: String,
}

#[derive(Debug)]
pub struct Parsed {
    pub title: String,
    pub chunks: Vec<Chunk>,
}

/// Parses `text`; `stem` is the file name without its extension, the title of last resort.
pub fn parse(text: &str, stem: &str) -> Parsed {
    let (front, body_start) = front_matter(text);
    let field = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| {
                front
                    .iter()
                    .find(|(key, _)| key == k)
                    .map(|(_, v)| v.clone())
            })
            .unwrap_or_default()
    };
    let chunks = chunks(text, body_start);
    let mut title = field(&["title", "name", "task"]);
    if title.is_empty() {
        // The first heading's path is that heading alone.
        title = chunks
            .iter()
            .map(|c| c.heading.as_str())
            .find(|h| !h.is_empty())
            .unwrap_or(stem)
            .to_string();
    }
    Parsed { title, chunks }
}

/// Reads simple `key: value` lines from a leading `---` block. Returns the pairs and the byte
/// offset where the body starts. A block with no closing `---` is treated as body text.
fn front_matter(text: &str) -> (Vec<(String, String)>, usize) {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return (Vec::new(), 0);
    };
    let mut offset = text.len() - rest.len();
    let mut pairs = Vec::new();
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let line = line.trim_end();
        if line == "---" {
            return (pairs, offset);
        }
        if let Some((key, value)) = line.split_once(':')
            && !key.starts_with([' ', '\t', '-'])
        {
            let value = value.trim().trim_matches(['"', '\'']).to_string();
            pairs.push((key.trim().to_lowercase(), value));
        }
    }
    (Vec::new(), 0)
}

/// ATX heading level and text, or `None` for a non-heading line.
fn heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.bytes().take_while(|&b| b == b'#').count();
    let rest = &trimmed[level..];
    if !(1..=6).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((level, rest.trim().trim_end_matches('#').trim_end()))
}

fn chunks(text: &str, body_start: usize) -> Vec<Chunk> {
    let first_line = text[..body_start].matches('\n').count() + 1;
    let mut out = vec![Chunk {
        line: 1,
        heading: String::new(),
        body: text[..body_start].to_string(),
    }];
    let mut path: Vec<(usize, String)> = Vec::new();
    let mut fence: Option<&str> = None;
    for (i, line) in text[body_start..].lines().enumerate() {
        let marker = line.trim_start();
        if let Some(open) = fence {
            if marker.starts_with(open) {
                fence = None;
            }
        } else if marker.starts_with("```") || marker.starts_with("~~~") {
            fence = Some(&marker[..3]);
        } else if let Some((level, title)) = heading(line) {
            path.retain(|(l, _)| *l < level);
            path.push((level, title.to_string()));
            let heading = path
                .iter()
                .map(|(_, t)| t.as_str())
                .collect::<Vec<_>>()
                .join(" > ");
            out.push(Chunk {
                line: first_line + i,
                heading,
                body: String::new(),
            });
            continue;
        }
        let body = &mut out.last_mut().expect("chunks start non-empty").body;
        body.push_str(line);
        body.push('\n');
    }
    out.into_iter()
        .filter(|c| !c.heading.is_empty() || !c.body.trim().is_empty())
        .flat_map(windows)
        .collect()
}

/// Sections longer than this are split at blank lines, so one long section cannot outweigh
/// several short, focused ones.
const MAX_SECTION_BYTES: usize = 1500;

/// Splits a long section into windows of about `MAX_SECTION_BYTES`, breaking at a blank line
/// where one exists and at any line otherwise. Each window keeps the heading and its own line.
fn windows(chunk: Chunk) -> Vec<Chunk> {
    if chunk.body.len() <= MAX_SECTION_BYTES {
        return vec![chunk];
    }
    let body_line = if chunk.heading.is_empty() {
        chunk.line
    } else {
        chunk.line + 1
    };
    let mut out = Vec::new();
    let (mut body, mut start) = (String::new(), 0);
    for (i, line) in chunk.body.lines().enumerate() {
        let full = body.len() >= MAX_SECTION_BYTES;
        if !body.is_empty()
            && (full || (body.len() >= MAX_SECTION_BYTES / 2 && line.trim().is_empty()))
        {
            let line_no = if out.is_empty() {
                chunk.line
            } else {
                body_line + start
            };
            out.push(Chunk {
                line: line_no,
                heading: chunk.heading.clone(),
                body: std::mem::take(&mut body),
            });
            start = i;
        }
        body.push_str(line);
        body.push('\n');
    }
    if !body.trim().is_empty() {
        let line_no = if out.is_empty() {
            chunk.line
        } else {
            body_line + start
        };
        out.push(Chunk {
            line: line_no,
            heading: chunk.heading,
            body,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_title_and_searchable_values() {
        let p = parse(
            "---\ntask: my-task\nnext: \"do the thing\"\n---\n# Heading\nbody\n",
            "f",
        );
        assert_eq!(p.title, "my-task");
        assert!(p.chunks[0].body.contains("next: \"do the thing\""));
        assert_eq!(p.chunks.last().unwrap().line, 5);
    }

    #[test]
    fn unclosed_front_matter_is_body() {
        let p = parse("---\ntitle: x\nno close\n", "stem");
        assert_eq!(p.title, "stem");
        assert!(p.chunks[0].body.contains("no close"));
    }

    #[test]
    fn heading_paths_and_fences() {
        let text = "# A\n## B\n```\n# not a heading\n```\n### C\n## D\n";
        let p = parse(text, "f");
        let heads: Vec<_> = p
            .chunks
            .iter()
            .map(|c| (c.line, c.heading.as_str()))
            .collect();
        assert_eq!(
            heads,
            [(1, "A"), (2, "A > B"), (6, "A > B > C"), (7, "A > D")]
        );
        assert_eq!(p.title, "A");
    }

    #[test]
    fn long_sections_split_at_blank_lines() {
        let para = "word ".repeat(100);
        let text = format!(
            "# Long
{para}

{para}

{para}

{para}
"
        );
        let p = parse(&text, "f");
        let lines: Vec<_> = p.chunks.iter().map(|c| c.line).collect();
        assert_eq!(lines, [1, 5]);
        assert!(
            p.chunks
                .iter()
                .all(|c| c.heading == "Long" && c.body.len() <= 1500)
        );
        let rejoined: String = p.chunks.iter().map(|c| c.body.as_str()).collect();
        assert_eq!(
            rejoined,
            text["# Long
"
            .len()..]
        );
    }

    #[test]
    fn not_headings() {
        assert_eq!(heading("#tag"), None);
        assert_eq!(heading("    # indented code"), None);
        assert_eq!(heading("####### seven"), None);
        assert_eq!(heading("## Closed ##"), Some((2, "Closed")));
    }
}
