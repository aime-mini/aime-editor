//! Applying LSP text edits to files that are not open in the editor.
//!
//! A rename touches every file that uses the symbol, and most of them are not
//! on screen. Monaco can only edit buffers it holds, so those files are
//! rewritten here instead - which makes the offset arithmetic worth testing
//! rather than trusting: LSP counts lines and UTF-16 code units from zero, and
//! getting that wrong silently corrupts source files.

use serde::Deserialize;

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub range: Range,
    pub new_text: String,
}

/// Byte offset of an LSP position, clamped so a stale edit can only be a
/// no-op at the end of the file rather than a panic.
fn offset_of(text: &str, position: Position) -> usize {
    let mut offset = 0;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if index == position.line {
            // LSP counts UTF-16 code units; walking them keeps multibyte
            // identifiers from shifting every edit after them.
            let mut utf16 = 0;
            for (byte_index, character) in line.char_indices() {
                if utf16 >= position.character {
                    return offset + byte_index;
                }
                utf16 += character.len_utf16();
            }
            return offset + line.trim_end_matches(['\n', '\r']).len();
        }
        offset += line.len();
    }
    text.len()
}

/// Applies edits to `text`. Edits are applied last-first so that earlier
/// offsets stay valid, which is what the specification expects of a client.
pub fn apply(text: &str, edits: &[TextEdit]) -> String {
    let mut ordered: Vec<&TextEdit> = edits.iter().collect();
    ordered.sort_by_key(|edit| (edit.range.start.line, edit.range.start.character));

    let mut result = text.to_string();
    for edit in ordered.into_iter().rev() {
        let start = offset_of(&result, edit.range.start);
        let end = offset_of(&result, edit.range.end).max(start);
        result.replace_range(start..end, &edit.new_text);
    }
    result
}

/// Rewrites one file that the editor does not have open.
#[tauri::command]
pub fn apply_text_edits(path: String, edits: Vec<TextEdit>) -> Result<(), String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    std::fs::write(&path, apply(&text, &edits)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{apply, Position, Range, TextEdit};

    fn edit(line: usize, from: usize, to: usize, new_text: &str) -> TextEdit {
        TextEdit {
            range: Range {
                start: Position {
                    line,
                    character: from,
                },
                end: Position { line, character: to },
            },
            new_text: new_text.to_string(),
        }
    }

    #[test]
    fn replaces_a_word_in_place() {
        let source = "let total = 1;\nreturn total;\n";
        let renamed = apply(source, &[edit(0, 4, 9, "sum"), edit(1, 7, 12, "sum")]);
        assert_eq!(renamed, "let sum = 1;\nreturn sum;\n");
    }

    #[test]
    fn several_edits_on_one_line_do_not_shift_each_other() {
        // Applying front-first would corrupt the second range.
        let renamed = apply("a = a + a;\n", &[edit(0, 0, 1, "value"), edit(0, 4, 5, "value")]);
        assert_eq!(renamed, "value = value + a;\n");
    }

    #[test]
    fn multibyte_text_before_an_edit_does_not_shift_it() {
        let source = "const tên = 1;\n";
        let renamed = apply(source, &[edit(0, 6, 9, "name")]);
        assert_eq!(renamed, "const name = 1;\n");
    }

    #[test]
    fn an_insertion_is_an_empty_range() {
        assert_eq!(apply("ab\n", &[edit(0, 1, 1, "X")]), "aXb\n");
    }

    #[test]
    fn a_range_past_the_end_cannot_panic() {
        assert_eq!(apply("short\n", &[edit(9, 0, 5, "x")]), "short\nx");
    }

    #[test]
    fn no_edits_leave_the_file_untouched() {
        assert_eq!(apply("unchanged\n", &[]), "unchanged\n");
    }
}
