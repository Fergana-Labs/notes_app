//! Block-level helpers used by the SQLite-first storage layer:
//!
//! - [`hash`] — content hash used for change detection and version dedupe.
//! - [`extract_hashtags`] — pull `#tag` matches out of a block's markdown
//!   content (skips fenced code, ignores tags that look like URLs).
//!
//! The legacy whole-canvas parser (block markers, fence pairs, heading-stack
//! parent_id assignment) lives in [`migration`] — it's only used during the
//! one-shot import from `canvas.md` into the database.

use once_cell::sync::Lazy;
use regex::Regex;
use sha2::{Digest, Sha256};

static TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|\s)#([A-Za-z][A-Za-z0-9_\-/]*)").unwrap());
static URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"https?://\S+").unwrap());

pub fn hash(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

pub fn extract_hashtags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let mut in_code = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let stripped = URL.replace_all(line, "");
        for cap in TAG.captures_iter(&stripped) {
            let t = cap[1].to_lowercase();
            if !tags.contains(&t) {
                tags.push(t);
            }
        }
    }
    tags
}

/// Strip every inline `#hashtag` token from `content`, skipping fenced
/// code blocks and tag-like fragments inside URLs. Mirrors the
/// `extract_hashtags` recognizer (same `(?:^|\s)#[A-Za-z][...]*` shape)
/// so a strip-then-extract round trip is idempotent and consistent.
///
/// Whitespace cleanup: removes the matched `#tag` (preserving the
/// leading whitespace/start-of-line that the recognizer requires),
/// collapses any resulting double spaces, trims trailing line spaces,
/// and squashes runs of blank lines that were created when a tag was
/// the only content on a line.
pub fn strip_inline_hashtags(content: &str) -> String {
    static MULTI_SPACE: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"[ \t]{2,}").unwrap());
    static TRAILING_WS: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"[ \t]+$").unwrap());
    static TRIPLE_NEWLINE: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

    let mut in_code = false;
    let mut out_lines: Vec<String> = Vec::new();
    for line in content.split('\n') {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            out_lines.push(line.to_string());
            continue;
        }
        if in_code {
            out_lines.push(line.to_string());
            continue;
        }
        let url_ranges: Vec<(usize, usize)> =
            URL.find_iter(line).map(|m| (m.start(), m.end())).collect();
        let stripped = strip_line(line, &url_ranges);
        let collapsed = MULTI_SPACE.replace_all(&stripped, " ").to_string();
        let trimmed = TRAILING_WS.replace_all(&collapsed, "").to_string();
        out_lines.push(trimmed);
    }
    let joined = out_lines.join("\n");
    TRIPLE_NEWLINE
        .replace_all(&joined, "\n\n")
        .trim_matches('\n')
        .to_string()
}

/// Strip `#tag` tokens from a single line, leaving byte ranges that
/// fall inside `url_ranges` untouched. The recognizer's leading
/// boundary (group 1: start-of-line or whitespace) is preserved so
/// word separation isn't lost. When a tag matches at start-of-line,
/// any trailing space immediately after the tag is consumed too, so
/// `#tag hello` collapses cleanly to `hello`.
fn strip_line(line: &str, url_ranges: &[(usize, usize)]) -> String {
    static STRIP: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"(^|\s)#[A-Za-z][A-Za-z0-9_\-/]*").unwrap()
    });
    let mut out = String::with_capacity(line.len());
    let mut last = 0usize;
    for m in STRIP.find_iter(line) {
        let inside_url = url_ranges
            .iter()
            .any(|(us, ue)| m.start() < *ue && m.end() > *us);
        if inside_url {
            continue;
        }
        out.push_str(&line[last..m.start()]);
        let matched = &line[m.start()..m.end()];
        let first_char = matched.chars().next();
        let leading_is_ws = matches!(first_char, Some(c) if c.is_whitespace());
        if leading_is_ws {
            out.push(first_char.unwrap());
        }
        let mut end = m.end();
        // Start-of-line strip: also consume the trailing space so we
        // don't leave a phantom leading space on the rewritten line.
        if !leading_is_ws {
            let tail = &line[end..];
            if tail.starts_with(' ') || tail.starts_with('\t') {
                end += 1;
            }
        }
        last = end;
    }
    out.push_str(&line[last..]);
    out
}

pub mod migration {
    //! Legacy `canvas.md` parser. Only used by the one-shot import that
    //! runs when a workspace is opened with `schema_version < 2`.

    use super::{extract_hashtags, hash};
    use once_cell::sync::Lazy;
    use regex::Regex;
    use serde::{Deserialize, Serialize};
    use ulid::Ulid;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ParsedBlock {
        pub id: String,
        pub parent_id: Option<String>,
        pub position: i64,
        pub heading: Option<String>,
        pub heading_level: Option<u8>,
        pub content: String,
        pub content_hash: String,
        pub tags: Vec<String>,
    }

    static ID_COMMENT: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^<!--\s*block:([0-9A-HJKMNP-TV-Z]{26})\s*-->\s*$").unwrap());
    static FENCE_START: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"^<!--\s*block:start(?:\s+id=([0-9A-HJKMNP-TV-Z]{26}))?\s*-->\s*$").unwrap()
    });
    static FENCE_END: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"^<!--\s*block:end\s*-->\s*$").unwrap());
    static HEADING: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*$").unwrap());

    pub fn parse(input: &str) -> Vec<ParsedBlock> {
        let lines: Vec<&str> = input.lines().collect();
        let mut raw_blocks: Vec<(Option<String>, String)> = Vec::new();
        let mut i = 0;

        fn trim_trailing_blank(buf: &mut Vec<&str>) {
            while buf.last().map_or(false, |l| l.trim().is_empty()) {
                buf.pop();
            }
        }

        while i < lines.len() {
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            if i >= lines.len() {
                break;
            }

            if let Some(caps) = FENCE_START.captures(lines[i]) {
                let id = caps.get(1).map(|m| m.as_str().to_string());
                i += 1;
                let mut buf: Vec<&str> = Vec::new();
                while i < lines.len() && !FENCE_END.is_match(lines[i]) {
                    buf.push(lines[i]);
                    i += 1;
                }
                if i < lines.len() {
                    i += 1;
                }
                trim_trailing_blank(&mut buf);
                raw_blocks.push((id, buf.join("\n")));
                continue;
            }

            if let Some(caps) = ID_COMMENT.captures(lines[i]) {
                let id = caps[1].to_string();
                i += 1;
                let mut buf: Vec<&str> = Vec::new();
                while i < lines.len()
                    && !ID_COMMENT.is_match(lines[i])
                    && !FENCE_START.is_match(lines[i])
                {
                    buf.push(lines[i]);
                    i += 1;
                }
                trim_trailing_blank(&mut buf);
                raw_blocks.push((Some(id), buf.join("\n")));
                continue;
            }

            let mut buf: Vec<&str> = Vec::new();
            while i < lines.len()
                && !lines[i].trim().is_empty()
                && !ID_COMMENT.is_match(lines[i])
                && !FENCE_START.is_match(lines[i])
            {
                buf.push(lines[i]);
                i += 1;
            }
            if !buf.is_empty() {
                raw_blocks.push((None, buf.join("\n")));
            }
        }

        let mut out: Vec<ParsedBlock> = Vec::with_capacity(raw_blocks.len());
        let mut stack: Vec<(u8, String)> = Vec::new();

        for (pos, (maybe_id, content)) in raw_blocks.into_iter().enumerate() {
            let id = maybe_id.unwrap_or_else(|| Ulid::new().to_string());

            let first_line = content.lines().next().unwrap_or("");
            let (heading, heading_level) = if let Some(caps) = HEADING.captures(first_line) {
                let lvl = caps[1].len() as u8;
                (Some(caps[2].to_string()), Some(lvl))
            } else {
                (None, None)
            };

            let parent_id = match heading_level {
                Some(lvl) => {
                    while stack.last().map_or(false, |(l, _)| *l >= lvl) {
                        stack.pop();
                    }
                    let p = stack.last().map(|(_, id)| id.clone());
                    stack.push((lvl, id.clone()));
                    p
                }
                None => stack.last().map(|(_, id)| id.clone()),
            };

            let tags = extract_hashtags(&content);
            let content_hash = hash(&content);

            out.push(ParsedBlock {
                id,
                parent_id,
                position: pos as i64,
                heading,
                heading_level,
                content,
                content_hash,
                tags,
            });
        }

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_inline_tags() {
        let tags = extract_hashtags("a #foo and #bar/baz here");
        assert!(tags.contains(&"foo".to_string()));
        assert!(tags.contains(&"bar/baz".to_string()));
    }

    #[test]
    fn skips_tags_inside_fenced_code() {
        let md = "before #yes\n```\n#no\n```\nafter #also";
        let tags = extract_hashtags(md);
        assert!(tags.contains(&"yes".to_string()));
        assert!(tags.contains(&"also".to_string()));
        assert!(!tags.contains(&"no".to_string()));
    }

    #[test]
    fn ignores_tags_in_urls() {
        let tags = extract_hashtags("https://example.com/#frag and #real");
        assert!(tags.contains(&"real".to_string()));
        assert!(!tags.iter().any(|t| t == "frag"));
    }

    #[test]
    fn strips_leading_middle_trailing_tags() {
        assert_eq!(strip_inline_hashtags("#a hello"), "hello");
        assert_eq!(strip_inline_hashtags("hello #middle world"), "hello world");
        assert_eq!(strip_inline_hashtags("hello #trailing"), "hello");
    }

    #[test]
    fn strip_keeps_fenced_code_tags() {
        let md = "before #yes\n```\n#kept\n```\nafter #also";
        let out = strip_inline_hashtags(md);
        assert_eq!(out, "before\n```\n#kept\n```\nafter");
    }

    #[test]
    fn strip_preserves_url_fragments() {
        let out = strip_inline_hashtags("see https://example.com/#frag for #real info");
        assert_eq!(out, "see https://example.com/#frag for info");
    }

    #[test]
    fn strip_squashes_blank_lines_when_tag_only_line() {
        let out = strip_inline_hashtags("line one\n#sololine\nline two");
        assert_eq!(out, "line one\n\nline two");
    }

    #[test]
    fn strip_is_idempotent_with_extract() {
        let src = "first #a then #b and #c";
        let stripped = strip_inline_hashtags(src);
        // Second pass should be a no-op.
        assert_eq!(strip_inline_hashtags(&stripped), stripped);
        // And extraction on the stripped form should yield no tags.
        assert!(extract_hashtags(&stripped).is_empty());
    }

    #[test]
    fn migration_parse_round_trip_keeps_ids() {
        let md = "<!-- block:01J0000000000000000000ABCD -->\nhello\n";
        let blocks = migration::parse(md);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].id, "01J0000000000000000000ABCD");
        assert_eq!(blocks[0].content, "hello");
    }
}
