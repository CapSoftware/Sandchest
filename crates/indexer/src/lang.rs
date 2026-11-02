//! Supported languages and the syntax-tree shapes the extractor relies on.

use serde::Serialize;
use tree_sitter::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Go,
    Java,
    Php,
    Rust,
    Ruby,
}

impl Lang {
    /// The language of a source file we recognise as code but cannot parse yet. Such files
    /// still count as hand-written source — attack surface, lines of code, test detection —
    /// so a repository in an unparsed language is sized and scoped correctly; they just
    /// contribute no symbols, calls, routes or sinks.
    pub fn unparsed_code(path: &str) -> Option<&'static str> {
        let ext = path.rsplit_once('.')?.1;
        Some(match ext {
            "cs" => "csharp",
            "kt" | "kts" => "kotlin",
            "swift" => "swift",
            "scala" => "scala",
            "c" | "h" => "c",
            "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
            "m" | "mm" => "objective-c",
            "ex" | "exs" => "elixir",
            "erl" | "hrl" => "erlang",
            "dart" => "dart",
            "lua" => "lua",
            "pl" | "pm" => "perl",
            "groovy" => "groovy",
            "clj" | "cljs" => "clojure",
            "hs" => "haskell",
            "fs" => "fsharp",
            "vb" => "visual-basic",
            "zig" => "zig",
            "sol" => "solidity",
            "cr" => "crystal",
            "jl" => "julia",
            "vue" => "vue",
            "svelte" => "svelte",
            _ => return None,
        })
    }

    pub fn from_path(path: &str) -> Option<Lang> {
        let ext = path.rsplit_once('.')?.1;
        Some(match ext {
            "js" | "mjs" | "cjs" | "jsx" => Lang::JavaScript,
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "py" => Lang::Python,
            "go" => Lang::Go,
            "java" => Lang::Java,
            "php" => Lang::Php,
            "rs" => Lang::Rust,
            "rb" | "rake" => Lang::Ruby,
            _ => return None,
        })
    }

    pub fn grammar(self) -> Language {
        match self {
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::Php => tree_sitter_php::LANGUAGE_PHP.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        }
    }

    /// JavaScript, TypeScript and TSX share rules.
    pub fn family(self) -> Family {
        match self {
            Lang::JavaScript | Lang::TypeScript | Lang::Tsx => Family::Js,
            Lang::Python => Family::Python,
            Lang::Go => Family::Go,
            Lang::Java => Family::Java,
            Lang::Php => Family::Php,
            Lang::Rust => Family::Rust,
            Lang::Ruby => Family::Ruby,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Lang::JavaScript => "javascript",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
            Lang::Python => "python",
            Lang::Go => "go",
            Lang::Java => "java",
            Lang::Php => "php",
            Lang::Rust => "rust",
            Lang::Ruby => "ruby",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    Js,
    Python,
    Go,
    Java,
    Php,
    Rust,
    Ruby,
}

impl Family {
    /// Node kinds that define a named function or method.
    pub fn is_function(self, kind: &str) -> bool {
        match self {
            Family::Js => matches!(kind, "function_declaration" | "generator_function_declaration" | "method_definition"),
            Family::Python => kind == "function_definition",
            Family::Go => matches!(kind, "function_declaration" | "method_declaration"),
            Family::Java => matches!(kind, "method_declaration" | "constructor_declaration"),
            Family::Php => matches!(kind, "function_definition" | "method_declaration"),
            Family::Rust => kind == "function_item",
            Family::Ruby => matches!(kind, "method" | "singleton_method"),
        }
    }

    /// Anonymous functions, which take a name from what they are assigned to.
    pub fn is_lambda(self, kind: &str) -> bool {
        match self {
            Family::Js => matches!(kind, "arrow_function" | "function_expression" | "function" | "generator_function"),
            Family::Python => kind == "lambda",
            Family::Go => kind == "func_literal",
            Family::Java => kind == "lambda_expression",
            Family::Php => matches!(kind, "anonymous_function" | "arrow_function" | "anonymous_function_creation_expression"),
            Family::Rust => kind == "closure_expression",
            Family::Ruby => matches!(kind, "do_block" | "block" | "lambda"),
        }
    }

    pub fn is_class(self, kind: &str) -> bool {
        match self {
            Family::Js => matches!(kind, "class_declaration" | "abstract_class_declaration" | "class"),
            Family::Python => kind == "class_definition",
            Family::Go => kind == "type_spec",
            Family::Java => matches!(kind, "class_declaration" | "interface_declaration" | "enum_declaration" | "record_declaration"),
            Family::Php => matches!(kind, "class_declaration" | "trait_declaration" | "interface_declaration"),
            // `impl` blocks give methods their type as container; the type items themselves are classes too.
            Family::Rust => matches!(kind, "impl_item" | "trait_item" | "struct_item" | "enum_item"),
            Family::Ruby => matches!(kind, "class" | "module"),
        }
    }

    pub fn is_call(self, kind: &str) -> bool {
        match self {
            Family::Js => matches!(kind, "call_expression" | "new_expression"),
            Family::Python => kind == "call",
            Family::Go => kind == "call_expression",
            Family::Java => matches!(kind, "method_invocation" | "object_creation_expression"),
            Family::Php => matches!(
                kind,
                "function_call_expression"
                    | "member_call_expression"
                    | "nullsafe_member_call_expression"
                    | "scoped_call_expression"
                    | "object_creation_expression"
                    | "include_expression"
                    | "include_once_expression"
                    | "require_expression"
                    | "require_once_expression"
                    | "shell_command_expression"
            ),
            // Macros (`format!`, `sqlx::query!`) behave like calls for building inputs and the call graph.
            Family::Rust => matches!(kind, "call_expression" | "macro_invocation"),
            // Backticks run a shell command.
            Family::Ruby => matches!(kind, "call" | "subshell"),
        }
    }

    /// Nodes that make an otherwise literal string depend on runtime values.
    pub fn is_interpolation(self, kind: &str) -> bool {
        matches!(kind, "template_substitution" | "interpolation" | "variable_name" | "dynamic_variable_name")
    }
}
