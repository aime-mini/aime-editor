//! Rich text as Markdown.
//!
//! Work trackers keep descriptions as markup: Azure DevOps returns
//! `System.Description` as HTML, Jira answers `renderedFields` the same way, and
//! both the panel and the prompt handed to an agent have to read it. GitHub and
//! ClickUp already speak Markdown, so turning the other two into Markdown puts
//! every connector on one format - one thing for the item view to render, and
//! the format an agent reads best.
//!
//! Markdown rather than bare words because structure is meaning: a description
//! that reads
//!
//! ```text
//! Steps to reproduceOpen /login
//! ```
//!
//! has silently glued a heading to the first step, which is what dropping the
//! markup did before this. Lists stay lists, headings stay headings, and code
//! stays untouched inside a fence.

/// Blocks that stand alone: a blank line before and after, which is how Markdown
/// separates a paragraph from what surrounds it.
const PARAGRAPH_TAGS: [&str; 3] = ["p", "blockquote", "table"];

/// Blocks that only end the line. `div` is here rather than above because markup
/// generators wrap nearly everything in one; a blank line per `div` would tear a
/// description into confetti.
const LINE_TAGS: [&str; 3] = ["div", "tr", "li"];

/// Inline spans and the Markdown that carries them, on both sides.
const SPANS: [(&str, &str); 7] = [
    ("b", "**"),
    ("strong", "**"),
    ("i", "*"),
    ("em", "*"),
    ("code", "`"),
    ("del", "~~"),
    ("s", "~~"),
];

/// How deep one level of list nesting is indented.
const INDENT: &str = "  ";

/// The fence a `<pre>` block is written in.
const FENCE: &str = "```";

/// What a piece of HTML says, as Markdown.
pub fn html_to_markdown(html: &str) -> String {
    let mut writer = Writer::default();
    let mut tag = String::new();
    let mut in_tag = false;

    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                writer.tag(&tag);
            }
            _ if in_tag => tag.push(character),
            _ => writer.text(character),
        }
    }
    tidy(&writer.out)
}

/// What kind of list a `<li>` is inside, and how far an ordered one has counted.
enum List {
    Unordered,
    Ordered(u32),
}

/// Builds the Markdown, keeping the little state the markup implies: how deep
/// the lists are, which link is open, and whether we are inside code that must
/// be copied out exactly as it came in.
#[derive(Default)]
struct Writer {
    out: String,
    lists: Vec<List>,
    /// The destination of each open `<a>`; `None` for an anchor without one.
    links: Vec<Option<String>>,
    /// Inside `<pre>`: whitespace is content, and no markup is inserted.
    verbatim: bool,
}

impl Writer {
    /// One character of text. Outside a code block the whitespace of the source
    /// is layout, not content - it collapses to single spaces, and the line
    /// breaks come from the tags instead.
    fn text(&mut self, character: char) {
        if self.verbatim {
            self.out.push(character);
        } else if character.is_whitespace() {
            if !self.out.ends_with([' ', '\n']) && !self.out.is_empty() {
                self.out.push(' ');
            }
        } else {
            self.out.push(character);
        }
    }

    /// Ends the line, unless nothing has been written or one just ended.
    fn line(&mut self) {
        while self.out.ends_with(' ') {
            self.out.pop();
        }
        if !self.out.is_empty() && !self.out.ends_with('\n') {
            self.out.push('\n');
        }
    }

    /// Leaves one empty line behind, which is what separates Markdown blocks.
    fn blank_line(&mut self) {
        self.line();
        if !self.out.is_empty() && !self.out.ends_with("\n\n") {
            self.out.push('\n');
        }
    }

    fn raw(&mut self, text: &str) {
        self.out.push_str(text);
    }

    /// Acts on one tag, opening or closing.
    fn tag(&mut self, tag: &str) {
        let closing = tag.trim_start().starts_with('/');
        let name = tag_name(tag);

        // Inside a code block only its own end means anything: markup written in
        // a code sample is part of the sample.
        if self.verbatim {
            if closing && name == "pre" {
                self.end_pre();
            }
            return;
        }

        if name == "br" {
            self.line();
        } else if let Some(level) = heading_level(&name) {
            self.blank_line();
            if !closing {
                self.raw(&format!("{} ", "#".repeat(level)));
            }
        } else if name == "ul" || name == "ol" {
            self.list(&name, closing);
        } else if name == "pre" && !closing {
            self.start_pre();
        } else if name == "li" && !closing {
            self.bullet();
        } else if name == "hr" {
            self.blank_line();
            self.raw("---");
            self.blank_line();
        } else if name == "a" {
            self.anchor(tag, closing);
        } else if let Some((_, marker)) = SPANS.iter().find(|(span, _)| *span == name) {
            self.raw(marker);
        } else if PARAGRAPH_TAGS.contains(&name.as_str()) {
            self.blank_line();
        } else if LINE_TAGS.contains(&name.as_str()) {
            self.line();
        }
    }

    /// Opens or closes a list, so the bullets underneath know their shape.
    ///
    /// A list that stands on its own is a block and gets the blank line every
    /// block gets; one nested inside an item belongs to that item, and a blank
    /// line there would cut it loose from the line it is indented under.
    fn list(&mut self, name: &str, closing: bool) {
        if closing {
            self.lists.pop();
        }
        if self.lists.is_empty() {
            self.blank_line();
        } else {
            self.line();
        }
        if !closing {
            self.lists.push(if name == "ol" {
                List::Ordered(0)
            } else {
                List::Unordered
            });
        }
    }

    /// The marker one item of the innermost list is written with. A `<li>` that
    /// arrived outside any list still reads as an item rather than as a
    /// paragraph glued to the one before it.
    fn bullet(&mut self) {
        self.line();
        let depth = self.lists.len().saturating_sub(1);
        self.raw(&INDENT.repeat(depth));
        match self.lists.last_mut() {
            Some(List::Ordered(counted)) => {
                *counted += 1;
                let number = *counted;
                self.raw(&format!("{number}. "));
            }
            _ => self.raw("- "),
        }
    }

    /// A link is only written as one when it leads somewhere.
    fn anchor(&mut self, tag: &str, closing: bool) {
        if closing {
            if let Some(Some(href)) = self.links.pop() {
                self.raw(&format!("]({href})"));
            }
            return;
        }
        let href = attribute(tag, "href").filter(|href| !href.is_empty());
        if href.is_some() {
            self.raw("[");
        }
        self.links.push(href);
    }

    fn start_pre(&mut self) {
        self.blank_line();
        self.raw(FENCE);
        self.raw("\n");
        self.verbatim = true;
    }

    fn end_pre(&mut self) {
        self.verbatim = false;
        self.line();
        self.raw(FENCE);
        self.blank_line();
    }
}

/// `/p`, `br /`, `li class="x"` all name one tag.
fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('/')
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

/// `h1`..`h6` as the number of hashes they are worth.
fn heading_level(name: &str) -> Option<usize> {
    let level = name.strip_prefix('h')?.parse::<usize>().ok()?;
    (1..=6).contains(&level).then_some(level)
}

/// One attribute of a tag, quoted either way. Enough for `href`, which is the
/// only attribute any of this markup is read for.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lowered = tag.to_lowercase();
    let at = lowered.find(&format!("{name}="))? + name.len() + 1;
    let rest = &tag[at..];
    let quote = rest.chars().next()?;
    if quote == '"' || quote == '\'' {
        let end = rest[1..].find(quote)?;
        return Some(decode_entities(&rest[1..=end]));
    }
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some(decode_entities(&rest[..end]))
}

/// The named references this markup actually carries, plus the numeric form.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        // A reference is short; anything longer is a stray ampersand.
        match after.find(';').filter(|end| *end <= 10) {
            Some(end) => {
                match named_or_numeric(&after[..end]) {
                    Some(character) => out.push(character),
                    None => {
                        out.push('&');
                        out.push_str(&after[..end]);
                        out.push(';');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn named_or_numeric(reference: &str) -> Option<char> {
    match reference {
        "nbsp" => return Some(' '),
        "amp" => return Some('&'),
        "lt" => return Some('<'),
        "gt" => return Some('>'),
        "quot" => return Some('"'),
        "apos" | "#39" => return Some('\''),
        _ => {}
    }
    let digits = reference.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse().ok()?,
    };
    char::from_u32(code)
}

/// Markup leaves ragged whitespace behind: trailing spaces on every line, and a
/// run of empty lines wherever a table used to be. A fenced block is left
/// exactly as it arrived - blank lines are part of code.
fn tidy(text: &str) -> String {
    let decoded = decode_entities(text);
    let mut lines: Vec<&str> = Vec::new();
    let mut in_code = false;
    for line in decoded.lines() {
        if line.trim_start().starts_with(FENCE) {
            in_code = !in_code;
            lines.push(line);
            continue;
        }
        if in_code {
            lines.push(line);
            continue;
        }
        let trimmed = line.trim_end();
        // One blank line separates blocks; more is leftover markup.
        if trimmed.is_empty() && lines.last().is_some_and(|last: &&str| last.trim().is_empty()) {
            continue;
        }
        lines.push(trimmed);
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_and_entities_survive_the_markup() {
        assert_eq!(html_to_markdown("<p>One</p><p>Two</p>"), "One\n\nTwo");
        assert_eq!(
            html_to_markdown("<span style=\"color:red\">Red</span> &amp; blue"),
            "Red & blue"
        );
        assert_eq!(
            html_to_markdown("a&nbsp;b &#65; &#x42; &unknown;"),
            "a b A B &unknown;"
        );
        assert_eq!(html_to_markdown(""), "");
        assert_eq!(html_to_markdown("plain & simple"), "plain & simple");
    }

    #[test]
    fn a_heading_never_glues_itself_to_the_list_under_it() {
        // The shape a real Azure DevOps description arrives in, and the one that
        // used to read "Steps to reproduceOpen /login" in the item view.
        assert_eq!(
            html_to_markdown("<b>Steps to reproduce</b><ul><li>Open /login</li><li>Submit</li></ul>"),
            "**Steps to reproduce**\n\n- Open /login\n- Submit",
        );
    }

    #[test]
    fn lists_keep_their_shape() {
        assert_eq!(
            html_to_markdown("<ol><li>First</li><li>Second</li></ol>"),
            "1. First\n2. Second"
        );
        assert_eq!(
            html_to_markdown("<ul><li>Outer<ul><li>Inner</li></ul></li></ul>"),
            "- Outer\n  - Inner"
        );
        // Two lists in a row each count from one.
        assert_eq!(
            html_to_markdown("<ol><li>a</li></ol><ol><li>b</li></ol>"),
            "1. a\n\n1. b"
        );
    }

    #[test]
    fn headings_links_and_emphasis_arrive_as_markdown() {
        assert_eq!(
            html_to_markdown("<h2>Context</h2><p>Body</p>"),
            "## Context\n\nBody"
        );
        assert_eq!(
            html_to_markdown(r#"See <a href="https://x.test/a?b=1&amp;c=2">the ticket</a>."#),
            "See [the ticket](https://x.test/a?b=1&c=2).",
        );
        // An anchor going nowhere is text, not an empty link.
        assert_eq!(html_to_markdown(r#"<a name="top">Top</a>"#), "Top");
        assert_eq!(
            html_to_markdown("<p><b>bold</b> and <i>thin</i> and <code>x=1</code></p>"),
            "**bold** and *thin* and `x=1`",
        );
    }

    #[test]
    fn code_is_copied_out_exactly_as_it_came_in() {
        assert_eq!(
            html_to_markdown("<pre>if (a &lt; b) {\n\n    go();\n}</pre>"),
            "```\nif (a < b) {\n\n    go();\n}\n```",
            "indentation, blank lines and markup written inside code are all content",
        );
    }

    #[test]
    fn the_layout_whitespace_of_the_source_is_not_content() {
        assert_eq!(
            html_to_markdown("<div>\n    Wrapped\n    over lines\n</div>"),
            "Wrapped over lines",
            "newlines and indentation in the markup are layout, and four of them would be a code block",
        );
        assert_eq!(
            html_to_markdown("<div>One</div><div>Two</div>"),
            "One\nTwo",
            "a div ends a line; a blank line for each would tear a description apart",
        );
        assert_eq!(
            html_to_markdown("<table><tr><td>x</td></tr>\n\n\n<tr><td>y</td></tr></table>"),
            "x\ny",
        );
    }
}
