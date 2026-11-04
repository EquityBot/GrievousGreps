//! Ranked search: documents ordered by the BM25 score of their best-matching section.

use std::collections::{HashMap, HashSet};

use turso::Connection;

use crate::index::sql;

const STOPWORDS: &str = "a an and are as at be by did do does for from had has have how i in is it its \
    of on or our the to was we were what when where which who why will with";
/// Words a snippet shows, starting a few words before the first matching one.
const SNIPPET_WORDS: usize = 16;
const SNIPPET_LEAD: usize = 4;

#[derive(Debug)]
pub struct Hit {
    pub path: String,
    pub line: i64,
    pub title: String,
    pub heading: String,
    pub snippet: String,
    pub score: f64,
}

/// Lower-cased words of two or more characters, stopwords removed, first occurrence kept.
pub fn terms(query: &str) -> Vec<String> {
    let stop: Vec<&str> = STOPWORDS.split_whitespace().collect();
    let mut out: Vec<String> = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric()) {
        let word = word.to_lowercase();
        if word.chars().count() > 1 && !stop.contains(&word.as_str()) && !out.contains(&word) {
            out.push(word);
        }
    }
    out
}

/// The `limit` best documents for `query`, best first.
pub fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    let terms = terms(query);
    if terms.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    pollster::block_on(async {
        let best = best_sections(conn, &terms.join(" "), limit).await?;
        describe(conn, &terms, best).await
    })
}

/// The best section of each of the `limit` best documents, as (path, section id, score), best
/// first; a higher score is better and ties go to the earlier path.
async fn best_sections(
    conn: &Connection,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<(String, i64, f64)>, String> {
    // Space-separated terms match any of them. Turso's FTS has no grouped aggregate over
    // fts_score, so the best-scoring sections are fetched and reduced to documents here.
    // shortcut: a document whose best section ranks below the cap is missed; on the tuning
    // corpus 1,000 sections always held more than 10 documents. Raise the cap if a folder's
    // documents have many near-identical sections.
    let cap = limit.saturating_mul(50).max(1000);
    let mut rows = conn
        .query(
            format!(
                "SELECT path, id, fts_score(path, title, heading, body, ?1) AS score FROM chunks
                 WHERE fts_match(path, title, heading, body, ?1) ORDER BY score DESC LIMIT {cap}"
            ),
            [fts_query],
        )
        .await
        .map_err(sql)?;
    let mut best: HashMap<String, (i64, f64)> = HashMap::new();
    while let Some(row) = rows.next().await.map_err(sql)? {
        let (id, score): (i64, f64) = (row.get(1).map_err(sql)?, row.get(2).map_err(sql)?);
        best.entry(row.get(0).map_err(sql)?)
            .and_modify(|b| {
                if score > b.1 {
                    *b = (id, score);
                }
            })
            .or_insert((id, score));
    }
    let mut ranked: Vec<_> = best.into_iter().map(|(p, (id, s))| (p, id, s)).collect();
    ranked.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(limit);
    Ok(ranked)
}

/// Hits for the ranked sections, with each section's title, line, heading and snippet.
async fn describe(
    conn: &Connection,
    terms: &[String],
    best: Vec<(String, i64, f64)>,
) -> Result<Vec<Hit>, String> {
    if best.is_empty() {
        return Ok(Vec::new());
    }
    // Section ids are integers from the index, so they are safe to inline.
    let ids: Vec<String> = best.iter().map(|(_, id, _)| id.to_string()).collect();
    let mut rows = conn
        .query(
            format!(
                "SELECT id, title, line, heading, body FROM chunks WHERE id IN ({})",
                ids.join(", ")
            ),
            (),
        )
        .await
        .map_err(sql)?;
    let mut sections: HashMap<i64, (String, i64, String, String)> = HashMap::new();
    while let Some(row) = rows.next().await.map_err(sql)? {
        let body: String = row.get(4).map_err(sql)?;
        let section = (
            row.get(1).map_err(sql)?,
            row.get(2).map_err(sql)?,
            row.get(3).map_err(sql)?,
            snippet(&body, terms),
        );
        sections.insert(row.get(0).map_err(sql)?, section);
    }
    Ok(best
        .into_iter()
        .map(|(path, id, score)| {
            let (title, line, heading, snippet) = sections.remove(&id).unwrap_or_default();
            Hit {
                path,
                line,
                title,
                heading,
                snippet,
                score,
            }
        })
        .collect())
}

/// About `SNIPPET_WORDS` words of `body` around its first word that matches a term, marked
/// with '…' where text was cut. A word matches when it starts with a term, or when a term
/// starts with it and it has four or more characters, which covers most stemmed forms.
fn snippet(body: &str, terms: &[String]) -> String {
    let words: Vec<&str> = body.split_whitespace().collect();
    let terms: HashSet<&str> = terms.iter().map(String::as_str).collect();
    let matches = |word: &str| {
        let word = word
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        terms.iter().any(|t| {
            word.starts_with(t) || (word.chars().count() >= 4 && t.starts_with(word.as_str()))
        })
    };
    let first = words.iter().position(|w| matches(w)).unwrap_or(0);
    let start = first.saturating_sub(SNIPPET_LEAD);
    let end = (start + SNIPPET_WORDS).min(words.len());
    let mut out = words[start..end].join(" ");
    if start > 0 {
        out.insert(0, '…');
    }
    if end < words.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{snippet, terms};

    #[test]
    fn terms_drop_stopwords_and_duplicates() {
        assert_eq!(
            terms("Why did we retire the QMD index? qmd!"),
            ["retire", "qmd", "index"]
        );
        assert_eq!(terms("a I x"), Vec::<String>::new());
        assert_eq!(terms("trail-code 0.28"), ["trail", "code", "28"]);
    }

    #[test]
    fn snippet_centres_on_the_first_match() {
        let body = "one two three four five six seven eight Retired the index nine ten eleven \
                    twelve thirteen fourteen fifteen sixteen seventeen eighteen";
        let terms = ["retire".to_string()];
        assert_eq!(
            snippet(body, &terms),
            "…five six seven eight Retired the index nine ten eleven twelve thirteen fourteen \
             fifteen sixteen seventeen…"
        );
        assert_eq!(snippet("short text", &terms), "short text");
        assert_eq!(snippet("", &terms), "");
    }
}
