use std::{ops::Range, path::Path};
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Language {
    Rust,
    JavaScript,
    Python,
    Json,
}
impl Language {
    pub fn for_path(path: &str) -> Option<Self> {
        match Path::new(path).extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "py" => Some(Self::Python),
            "json" | "jsonc" => Some(Self::Json),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Plain,
    Keyword,
    String,
    Number,
    Comment,
}
#[derive(Clone, Debug)]
pub struct Token {
    pub range: Range<usize>,
    pub kind: TokenKind,
}
pub fn line(text: &str, language: Language) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let start = cursor;
        let Some(character) = text[cursor..].chars().next() else {
            break;
        };
        let kind = if (language == Language::Python && character == '#')
            || (language != Language::Python && text[cursor..].starts_with("//"))
        {
            cursor = text.len();
            TokenKind::Comment
        } else if character == '"'
            || (character == '\''
                && (language != Language::Rust
                    || text[cursor + 1..].chars().take(4).any(|next| next == '\'')))
            || (language == Language::JavaScript && character == '`')
        {
            cursor += character.len_utf8();
            let mut escaped = false;
            for next in text[cursor..].chars() {
                cursor += next.len_utf8();
                if escaped {
                    escaped = false;
                    continue;
                }
                if next == '\\' {
                    escaped = true;
                    continue;
                }
                if next == character {
                    break;
                }
            }
            TokenKind::String
        } else if character.is_ascii_digit() {
            cursor += 1;
            while let Some(next) = text[cursor..].chars().next() {
                if !next.is_ascii_alphanumeric() && !matches!(next, '.' | '_') {
                    break;
                }
                cursor += next.len_utf8();
            }
            TokenKind::Number
        } else if character.is_alphabetic() || character == '_' {
            cursor += character.len_utf8();
            while let Some(next) = text[cursor..].chars().next() {
                if !next.is_alphanumeric() && next != '_' {
                    break;
                }
                cursor += next.len_utf8();
            }
            let word = &text[start..cursor];
            let keyword = match language {
                Language::Rust => matches!(
                    word,
                    "fn" | "pub"
                        | "let"
                        | "mut"
                        | "struct"
                        | "enum"
                        | "impl"
                        | "trait"
                        | "use"
                        | "mod"
                        | "match"
                        | "if"
                        | "else"
                        | "return"
                        | "self"
                        | "Self"
                        | "async"
                        | "await"
                        | "move"
                        | "for"
                        | "while"
                        | "loop"
                        | "in"
                        | "where"
                        | "type"
                        | "const"
                        | "static"
                        | "unsafe"
                        | "true"
                        | "false"
                        | "Some"
                        | "None"
                        | "Ok"
                        | "Err"
                ),
                Language::JavaScript => matches!(
                    word,
                    "const"
                        | "let"
                        | "var"
                        | "function"
                        | "return"
                        | "class"
                        | "interface"
                        | "type"
                        | "import"
                        | "from"
                        | "export"
                        | "default"
                        | "if"
                        | "else"
                        | "for"
                        | "while"
                        | "async"
                        | "await"
                        | "new"
                        | "true"
                        | "false"
                        | "null"
                        | "undefined"
                        | "try"
                        | "catch"
                        | "throw"
                        | "extends"
                        | "implements"
                ),
                Language::Python => matches!(
                    word,
                    "def"
                        | "class"
                        | "return"
                        | "import"
                        | "from"
                        | "as"
                        | "if"
                        | "elif"
                        | "else"
                        | "for"
                        | "while"
                        | "in"
                        | "is"
                        | "not"
                        | "and"
                        | "or"
                        | "with"
                        | "try"
                        | "except"
                        | "finally"
                        | "raise"
                        | "pass"
                        | "yield"
                        | "async"
                        | "await"
                        | "True"
                        | "False"
                        | "None"
                        | "lambda"
                ),
                Language::Json => matches!(word, "true" | "false" | "null"),
            };
            if keyword {
                TokenKind::Keyword
            } else {
                TokenKind::Plain
            }
        } else {
            cursor += character.len_utf8();
            TokenKind::Plain
        };
        tokens.push(Token {
            range: start..cursor,
            kind,
        });
    }
    tokens
}
