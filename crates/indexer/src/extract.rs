//! One pass over a file's syntax tree, collecting everything the index needs:
//! symbols, call sites, routes, sinks and imports.

use std::collections::HashMap;

use serde::Serialize;
use tree_sitter::{Node, Parser, Tree};

use crate::files::File;
use crate::lang::{Family, Lang};
use crate::sinks::{self, Input, SinkKind};

static SQL_STATEMENT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?is)\bSELECT\b.+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b.+\bSET\b|\bDELETE\s+FROM\b").unwrap()
});

/// Longest callee text kept; longer chains keep their last segments.
const MAX_CALLEE: usize = 120;
const HTTP_METHODS: &[&str] = &["get", "post", "put", "patch", "delete", "head", "options", "all", "any", "use", "handle", "handlefunc"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    /// An anonymous function registered directly as a route handler.
    Handler,
}

#[derive(Debug, Clone, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub line: u32,
    pub end_line: u32,
}

/// A call site. `caller` indexes the file's symbols; `None` is top-level code.
#[derive(Debug, Clone)]
pub struct Call {
    pub caller: Option<u32>,
    /// Normalised dotted callee, e.g. `models.sequelize.query`.
    pub callee: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Route {
    pub method: String,
    pub path: String,
    pub line: u32,
    /// Middleware and handler names in registration order; the last is the handler.
    pub handlers: Vec<String>,
    pub framework: &'static str,
}

#[derive(Debug, Clone)]
pub struct Sink {
    pub kind: SinkKind,
    pub callee: String,
    pub input: Input,
    pub line: u32,
    pub caller: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct Import {
    pub spec: String,
    pub line: u32,
}

#[derive(Default)]
pub struct Facts {
    pub symbols: Vec<Symbol>,
    pub calls: Vec<Call>,
    pub routes: Vec<Route>,
    pub sinks: Vec<Sink>,
    pub imports: Vec<Import>,
}

thread_local! {
    static PARSERS: std::cell::RefCell<HashMap<Lang, Parser>> = std::cell::RefCell::new(HashMap::new());
}

pub fn parse(file: &File, lang: Lang) -> Option<Tree> {
    PARSERS.with(|parsers| {
        let mut parsers = parsers.borrow_mut();
        let parser = parsers.entry(lang).or_insert_with(|| {
            let mut parser = Parser::new();
            parser.set_language(&lang.grammar()).expect("grammar matches the tree-sitter version");
            parser
        });
        parser.parse(&file.text, None)
    })
}

pub fn extract(file: &File, lang: Lang) -> Facts {
    let Some(tree) = parse(file, lang) else { return Facts::default() };
    let mut extractor = Extractor {
        file,
        src: &file.text,
        family: lang.family(),
        facts: Facts::default(),
        handler_names: HashMap::new(),
        import_specs: Vec::new(),
        aliases: HashMap::new(),
    };

    // Imports first: some sink rules depend on what the file imports.
    extractor.collect_imports(tree.root_node());
    extractor.import_specs = extractor.facts.imports.iter().map(|import| import.spec.clone()).collect();
    extractor.walk(tree.root_node());
    extractor.file_routes();
    extractor.facts
}

struct Scope {
    depth: usize,
    symbol: Option<u32>,
    class: Option<String>,
    route_prefix: Option<String>,
}

struct Extractor<'a> {
    file: &'a File,
    src: &'a str,
    family: Family,
    facts: Facts,
    /// Anonymous functions passed to route registrations, named after their route.
    handler_names: HashMap<usize, String>,
    import_specs: Vec<String>,
    /// `const run = promisify(exec)`: calls to `run` are calls to `exec`.
    aliases: HashMap<String, String>,
}

impl<'a> Extractor<'a> {
    fn text(&self, node: Node) -> &'a str {
        &self.src[node.byte_range()]
    }

    /// Depth-first walk with an explicit cursor, so deeply nested code cannot overflow the stack.
    fn walk(&mut self, root: Node) {
        let mut cursor = root.walk();
        let mut depth = 0usize;
        let mut scopes: Vec<Scope> = Vec::new();

        loop {
            let node = cursor.node();
            if let Some(scope) = self.visit(node, depth, &scopes) {
                scopes.push(scope);
            }
            if cursor.goto_first_child() {
                depth += 1;
                continue;
            }
            loop {
                while scopes.last().is_some_and(|scope| scope.depth >= depth) {
                    scopes.pop();
                }
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    return;
                }
                depth -= 1;
            }
        }
    }

    fn visit(&mut self, node: Node, depth: usize, scopes: &[Scope]) -> Option<Scope> {
        let kind = node.kind();
        let family = self.family;
        let caller = scopes.iter().rev().find_map(|scope| scope.symbol);
        let class = scopes.iter().rev().find_map(|scope| scope.class.as_deref());

        if family.is_call(kind) {
            self.call(node, caller);
            return None;
        }
        if family.is_class(kind) {
            let name = self.class_name(node)?;
            let id = self.add_symbol(&name, SymbolKind::Class, class.map(str::to_owned), node);
            let route_prefix = self.class_route_prefix(node);
            return Some(Scope { depth, symbol: Some(id), class: Some(name), route_prefix });
        }

        let named = family.is_function(kind);
        if !named && !family.is_lambda(kind) {
            return None;
        }
        let (name, kind) = if let Some(handler) = self.handler_names.remove(&node.id()) {
            (handler, SymbolKind::Handler)
        } else if named {
            let name = self.function_name(node)?;
            (name, if class.is_some() || kind.starts_with("method") { SymbolKind::Method } else { SymbolKind::Function })
        } else {
            (self.lambda_name(node)?, SymbolKind::Function)
        };
        let container = if kind == SymbolKind::Handler { None } else { class.map(str::to_owned).or_else(|| self.go_receiver(node)) };
        let id = self.add_symbol(&name, kind, container, node);
        if named {
            let prefix = scopes.iter().rev().find_map(|scope| scope.route_prefix.as_deref());
            self.decorator_routes(node, &name, prefix);
        }
        Some(Scope { depth, symbol: Some(id), class: None, route_prefix: None })
    }

    fn add_symbol(&mut self, name: &str, kind: SymbolKind, container: Option<String>, node: Node) -> u32 {
        self.facts.symbols.push(Symbol {
            name: name.to_owned(),
            kind,
            container,
            line: line_of(node),
            end_line: node.end_position().row as u32 + 1,
        });
        self.facts.symbols.len() as u32 - 1
    }

    fn function_name(&self, node: Node) -> Option<String> {
        if let Some(name) = node.child_by_field_name("name") {
            return Some(self.text(name).to_owned());
        }
        // `export default function () {}`
        node.parent().filter(|parent| parent.kind() == "export_statement").map(|_| "default".to_owned())
    }

    fn class_name(&self, node: Node) -> Option<String> {
        if self.family == Family::Go {
            // Only struct and interface types behave like classes.
            let ty = node.child_by_field_name("type")?;
            if !matches!(ty.kind(), "struct_type" | "interface_type") {
                return None;
            }
        }
        node.child_by_field_name("name").map(|name| self.text(name).to_owned())
    }

    /// Names an anonymous function after whatever it is assigned to.
    fn lambda_name(&self, node: Node) -> Option<String> {
        let parent = node.parent()?;
        let target = match parent.kind() {
            "variable_declarator" | "public_field_definition" | "field_definition" => parent.child_by_field_name("name")?,
            "pair" => parent.child_by_field_name("key")?,
            // Wrapped handlers: `export const GET = withAuth(async (req) => …)`.
            "arguments" => {
                let call = parent.parent().filter(|call| self.family.is_call(call.kind()))?;
                let declarator = call.parent().filter(|d| d.kind() == "variable_declarator")?;
                declarator.child_by_field_name("name")?
            }
            "assignment_expression" | "assignment" | "augmented_assignment" => parent.child_by_field_name("left")?,
            "expression_list" => {
                // Go: `handler := func(...) {...}`
                let assignment = parent.parent().filter(|p| matches!(p.kind(), "short_var_declaration" | "assignment_statement"))?;
                assignment.child_by_field_name("left")?.named_child(0)?
            }
            _ => return None,
        };
        let name = normalize_callee(self.text(target));
        let last = name.rsplit('.').next()?.trim_matches(['"', '\'', '`']);
        (!last.is_empty() && last.len() <= 80).then(|| last.to_owned())
    }

    fn go_receiver(&self, node: Node) -> Option<String> {
        if node.kind() != "method_declaration" {
            return None;
        }
        let receiver = node.child_by_field_name("receiver")?;
        let text = self.text(receiver);
        let ty = text.trim_matches(['(', ')']).split_whitespace().last()?.trim_start_matches('*');
        Some(ty.split('[').next().unwrap_or(ty).to_owned())
    }

    // ---- calls ----------------------------------------------------------

    fn call(&mut self, node: Node, caller: Option<u32>) {
        let Some(callee) = self.callee(node) else { return };
        let line = line_of(node);
        let args = self.arguments(node);

        if let Some(args) = args {
            self.route_from_call(&callee, args, line);
        }

        let args_text = args.map(|args| self.text(args)).unwrap_or("");
        let target = self.aliases.get(&callee).unwrap_or(&callee);
        if let Some((kind, always)) = sinks::classify_call(self.family, target, &self.import_specs, args_text) {
            // Always-reported rules often hinge on an options object (`{ $where: ... }`), so look inside collections too.
            let input = self.input_of(node, args, always);
            if always || input > Input::Literal {
                self.facts.sinks.push(Sink { kind, callee: callee.clone(), input, line, caller });
            }
        } else if self.builds_sql(args) {
            // Query helpers have project-specific names; a SQL statement assembled at runtime is a sink whoever receives it.
            self.facts.sinks.push(Sink { kind: SinkKind::Sql, callee: callee.clone(), input: Input::Built, line, caller });
        }
        self.facts.calls.push(Call { caller, callee, line });
    }

    fn callee(&self, node: Node) -> Option<String> {
        let family = self.family;
        let raw = match (family, node.kind()) {
            (Family::Js, "new_expression") => self.text(node.child_by_field_name("constructor")?).to_owned(),
            (Family::Java, "method_invocation") | (Family::Php, "member_call_expression" | "nullsafe_member_call_expression") => {
                let name = self.text(node.child_by_field_name("name")?);
                match node.child_by_field_name("object") {
                    Some(object) => format!("{}.{name}", self.text(object)),
                    None => name.to_owned(),
                }
            }
            (Family::Php, "scoped_call_expression") => {
                format!("{}.{}", self.text(node.child_by_field_name("scope")?), self.text(node.child_by_field_name("name")?))
            }
            (Family::Java, "object_creation_expression") => self.text(node.child_by_field_name("type")?).to_owned(),
            (Family::Php, "object_creation_expression") => {
                let class = node.named_children(&mut node.walk()).find(|child| matches!(child.kind(), "name" | "qualified_name"))?;
                self.text(class).to_owned()
            }
            (Family::Php, "include_expression") => "include".to_owned(),
            (Family::Php, "include_once_expression") => "include_once".to_owned(),
            (Family::Php, "require_expression") => "require".to_owned(),
            (Family::Php, "require_once_expression") => "require_once".to_owned(),
            (Family::Php, "shell_command_expression") => "shell_exec".to_owned(),
            _ => self.text(node.child_by_field_name("function")?).to_owned(),
        };
        let callee = normalize_callee(&raw);
        (!callee.is_empty()).then_some(callee)
    }

    fn arguments(&self, node: Node<'a>) -> Option<Node<'a>> {
        match node.kind() {
            "include_expression" | "include_once_expression" | "require_expression" | "require_once_expression" => node.named_child(0),
            "shell_command_expression" => Some(node),
            _ => node.child_by_field_name("arguments"),
        }
    }

    /// The most dynamic input among the call's arguments. Collections (option
    /// objects, bound-parameter arrays) are skipped: they rarely carry the payload.
    fn input_of(&self, call: Node, args: Option<Node>, include_collections: bool) -> Input {
        let Some(args) = args else { return Input::Literal };
        if args.id() == call.id() || !matches!(args.kind(), "arguments" | "argument_list" | "annotation_argument_list") {
            return self.input_of_value(args);
        }
        let mut cursor = args.walk();
        args.named_children(&mut cursor)
            .map(|arg| self.unwrap_argument(arg))
            .filter(|arg| (include_collections || !is_collection(arg.kind())) && !arg.kind().contains("comment"))
            .map(|arg| self.input_of_value(arg))
            .max()
            .unwrap_or(Input::Literal)
    }

    fn unwrap_argument(&self, arg: Node<'a>) -> Node<'a> {
        match arg.kind() {
            "argument" | "parenthesized_expression" => arg.named_child(arg.named_child_count().saturating_sub(1) as u32).unwrap_or(arg),
            "keyword_argument" => arg.child_by_field_name("value").unwrap_or(arg),
            _ => arg,
        }
    }

    fn input_of_value(&self, node: Node) -> Input {
        if !self.references_values(node) {
            return Input::Literal;
        }
        let built = match node.kind() {
            "binary_expression"
            | "binary_operator"
            | "template_string"
            | "string"
            | "encapsed_string"
            | "concatenated_string"
            | "heredoc"
            | "shell_command_expression" => true,
            _ if self.family.is_call(node.kind()) => self.callee(node).is_some_and(|callee| {
                let last = callee.rsplit('.').next().unwrap_or(&callee);
                matches!(last, "format" | "sprintf" | "Sprintf" | "concat" | "join" | "replace" | "printf" | "f")
            }),
            _ => false,
        };
        if built { Input::Built } else { Input::Variable }
    }

    /// Whether the first argument is a SQL statement assembled from runtime values.
    fn builds_sql(&self, args: Option<Node>) -> bool {
        let Some(first) = args.and_then(|args| args.named_child(0)).map(|arg| self.unwrap_argument(arg)) else { return false };
        self.input_of_value(first) == Input::Built && SQL_STATEMENT.is_match(self.text(first))
    }

    /// Whether any part of `node` refers to a runtime value.
    fn references_values(&self, node: Node) -> bool {
        let mut cursor = node.walk();
        let mut depth = 0;
        loop {
            let kind = cursor.node().kind();
            if matches!(kind, "identifier" | "variable_name" | "this" | "self" | "shorthand_property_identifier" | "dynamic_variable_name")
                || self.family.is_interpolation(kind)
            {
                return true;
            }
            if cursor.goto_first_child() {
                depth += 1;
                continue;
            }
            loop {
                if depth == 0 {
                    return false;
                }
                if cursor.goto_next_sibling() {
                    break;
                }
                cursor.goto_parent();
                depth -= 1;
            }
        }
    }

    // ---- routes ---------------------------------------------------------

    /// `app.get('/path', auth, handler)`, `http.HandleFunc("/x", h)`, Django `path("x/", view)`.
    fn route_from_call(&mut self, callee: &str, args: Node, line: u32) {
        let mut cursor = args.walk();
        let values: Vec<Node> = args.named_children(&mut cursor).map(|arg| self.unwrap_argument(arg)).collect();
        if values.len() < 2 {
            return;
        }

        let (receiver, method) = match callee.rsplit_once('.') {
            Some((receiver, method)) => (receiver, method),
            None => ("", callee),
        };
        let (framework, method) = match self.family {
            Family::Js | Family::Go if !receiver.is_empty() && HTTP_METHODS.contains(&method.to_ascii_lowercase().as_str()) => {
                // `handle`/`handleFunc` only exist on routers; verbs also exist on HTTP clients.
                let registers_handler = method.eq_ignore_ascii_case("handle") || method.eq_ignore_ascii_case("handlefunc");
                if !registers_handler && is_client_receiver(receiver) {
                    return;
                }
                (if self.family == Family::Js { "express" } else { "go" }, method.to_ascii_uppercase())
            }
            Family::Python if receiver.is_empty() && matches!(method, "path" | "re_path" | "url") => ("django", "ANY".to_owned()),
            _ => return,
        };
        let Some(raw_path) = self.string_value(values[0]) else { return };
        let (method, path) = match raw_path.split_once(' ') {
            // Go 1.22 patterns: "POST /items/{id}".
            Some((verb, path)) if self.family == Family::Go && verb.chars().all(|c| c.is_ascii_uppercase()) => {
                (verb.to_owned(), path.to_owned())
            }
            _ => (method, raw_path),
        };
        let path = if framework == "django" { format!("/{}", path.trim_start_matches('^').trim_start_matches('/')) } else { path };
        if !(path.starts_with('/') || path == "*") {
            return;
        }
        let method = match method.as_str() {
            "HANDLE" | "HANDLEFUNC" | "ALL" => "ANY".to_owned(),
            _ => method,
        };

        let mut handlers = Vec::new();
        for &value in &values[1..] {
            self.handler_chain(value, &format!("{method} {path}"), &mut handlers, 0);
        }
        self.facts.routes.push(Route { method, path, line, handlers, framework });
    }

    /// Names the handlers in one route argument. Wrappers such as
    /// `asyncHandler(searchProducts())` contribute both names.
    fn handler_chain(&mut self, value: Node, route: &str, out: &mut Vec<String>, depth: usize) {
        let kind = value.kind();
        if self.family.is_lambda(kind) || self.family.is_function(kind) {
            self.handler_names.insert(value.id(), route.to_owned());
            out.push(route.to_owned());
        } else if self.family.is_call(kind) {
            if let Some(callee) = self.callee(value) {
                out.push(last_segment(&callee).to_owned());
            }
            if depth < 2 {
                if let Some(args) = self.arguments(value).filter(|args| args.id() != value.id()) {
                    let mut cursor = args.walk();
                    let inner: Vec<Node> = args.named_children(&mut cursor).map(|arg| self.unwrap_argument(arg)).collect();
                    for arg in inner {
                        self.handler_chain(arg, route, out, depth + 1);
                    }
                }
            }
        } else if matches!(kind, "identifier" | "member_expression" | "selector_expression" | "attribute") {
            out.push(last_segment(&normalize_callee(self.text(value))).to_owned());
        }
    }

    /// Routes declared by decorators or annotations on a function.
    fn decorator_routes(&mut self, node: Node, name: &str, prefix: Option<&str>) {
        for decorator in self.decorators(node) {
            let (callee, args) = match decorator.kind() {
                "call" | "call_expression" => (self.callee(decorator), self.arguments(decorator)),
                "annotation" => {
                    (decorator.child_by_field_name("name").map(|n| self.text(n).to_owned()), decorator.child_by_field_name("arguments"))
                }
                "marker_annotation" | "identifier" | "attribute" => (
                    decorator
                        .child_by_field_name("name")
                        .map(|n| self.text(n).to_owned())
                        .or_else(|| Some(self.text(decorator).to_owned())),
                    None,
                ),
                _ => (None, None),
            };
            let Some(callee) = callee else { continue };
            let last = last_segment(&callee);
            let first_string = args.and_then(|args| self.first_string_arg(args));
            let args_text = args.map(|args| self.text(args)).unwrap_or("");

            let (method, path, framework) = match self.family {
                Family::Python if callee.contains('.') => match last {
                    "route" => (python_methods(args_text), first_string, "flask"),
                    "get" | "post" | "put" | "patch" | "delete" | "websocket" | "api_route" => {
                        (last.to_ascii_uppercase(), first_string, "fastapi")
                    }
                    _ => continue,
                },
                Family::Js => match last {
                    "Get" | "Post" | "Put" | "Patch" | "Delete" | "All" | "Head" | "Options" => {
                        (last.to_ascii_uppercase(), Some(first_string.unwrap_or_default()), "nestjs")
                    }
                    _ => continue,
                },
                Family::Java => match last {
                    "GetMapping" | "PostMapping" | "PutMapping" | "PatchMapping" | "DeleteMapping" => {
                        (last.trim_end_matches("Mapping").to_ascii_uppercase(), Some(first_string.unwrap_or_default()), "spring")
                    }
                    "RequestMapping" => (java_request_method(args_text), Some(first_string.unwrap_or_default()), "spring"),
                    "GET" | "POST" | "PUT" | "PATCH" | "DELETE" => {
                        (last.to_owned(), Some(self.jaxrs_path(node).unwrap_or_default()), "jax-rs")
                    }
                    _ => continue,
                },
                _ => continue,
            };
            let Some(path) = path else { continue };
            let path = join_route(prefix.unwrap_or(""), &path);
            self.facts.routes.push(Route { method, path, line: line_of(node), handlers: vec![name.to_owned()], framework });
        }
    }

    fn decorators(&self, node: Node<'a>) -> Vec<Node<'a>> {
        let mut found = Vec::new();
        match self.family {
            Family::Python => {
                if let Some(parent) = node.parent().filter(|p| p.kind() == "decorated_definition") {
                    let mut cursor = parent.walk();
                    found.extend(parent.named_children(&mut cursor).filter(|c| c.kind() == "decorator").filter_map(|d| d.named_child(0)));
                }
            }
            Family::Js => {
                // Method decorators are the preceding siblings in the class body.
                let mut sibling = node.prev_named_sibling();
                while let Some(decorator) = sibling.filter(|s| s.kind() == "decorator") {
                    found.extend(decorator.named_child(0));
                    sibling = decorator.prev_named_sibling();
                }
                let mut cursor = node.walk();
                found.extend(node.children_by_field_name("decorator", &mut cursor).filter_map(|d| d.named_child(0)));
            }
            Family::Java => {
                let mut cursor = node.walk();
                if let Some(modifiers) = node.named_children(&mut cursor).find(|c| c.kind() == "modifiers") {
                    let mut cursor = modifiers.walk();
                    found.extend(modifiers.named_children(&mut cursor).filter(|c| matches!(c.kind(), "annotation" | "marker_annotation")));
                }
            }
            _ => {}
        }
        found
    }

    /// Route prefix from class-level `@Controller('x')`, `@RequestMapping("/x")` or `@Path("/x")`.
    fn class_route_prefix(&self, node: Node<'a>) -> Option<String> {
        let mut decorators = self.decorators(node);
        if self.family == Family::Js {
            if let Some(export) = node.parent().filter(|p| p.kind() == "export_statement") {
                let mut cursor = export.walk();
                decorators.extend(export.children_by_field_name("decorator", &mut cursor).filter_map(|d| d.named_child(0)));
            }
        }
        decorators.into_iter().find_map(|decorator| {
            let name = match decorator.kind() {
                "annotation" | "marker_annotation" => self.text(decorator.child_by_field_name("name")?),
                _ => self.text(decorator.child_by_field_name("function")?),
            };
            matches!(name, "Controller" | "RequestMapping" | "Path").then(|| {
                let args = decorator.child_by_field_name("arguments");
                args.and_then(|args| self.first_string_arg(args)).unwrap_or_default()
            })
        })
    }

    fn jaxrs_path(&self, node: Node<'a>) -> Option<String> {
        self.decorators(node).into_iter().find_map(|decorator| {
            (decorator.kind() == "annotation" && self.text(decorator.child_by_field_name("name")?) == "Path")
                .then(|| self.first_string_arg(decorator.child_by_field_name("arguments")?))
                .flatten()
        })
    }

    /// Next.js file routes and server actions, and PHP scripts that read request input.
    fn file_routes(&mut self) {
        let path = self.file.path.as_str();
        match self.family {
            Family::Js => {
                let file_name = path.rsplit('/').next().unwrap_or(path);
                let stem = file_name.split('.').next().unwrap_or(file_name);
                let start = self.src.trim_start();
                let directive = start.starts_with("\"use server\"") || start.starts_with("'use server'");
                let app_route = stem == "route" && (path.starts_with("app/") || path.contains("/app/"));
                let pages_api = path.contains("pages/api/");
                if !(directive || app_route || pages_api) {
                    return;
                }
                for symbol in &self.facts.symbols {
                    if symbol.container.is_some() || symbol.kind == SymbolKind::Class {
                        continue;
                    }
                    let exported = self.line_text(symbol.line).trim_start().starts_with("export");
                    let route = if app_route
                        && exported
                        && matches!(symbol.name.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS")
                    {
                        Some((symbol.name.clone(), next_route_path(path, "app/"), "nextjs"))
                    } else if pages_api && exported && self.line_text(symbol.line).contains("default") {
                        Some(("ANY".to_owned(), next_route_path(path, "pages/"), "nextjs"))
                    } else if directive && exported {
                        Some(("ACTION".to_owned(), format!("{path}#{}", symbol.name), "server-action"))
                    } else {
                        None
                    };
                    if let Some((method, route_path, framework)) = route {
                        self.facts.routes.push(Route {
                            method,
                            path: route_path,
                            line: symbol.line,
                            handlers: vec![symbol.name.clone()],
                            framework,
                        });
                    }
                }
            }
            Family::Php => {
                const INPUTS: &[&str] = &["$_GET", "$_POST", "$_REQUEST", "$_COOKIE", "$_FILES", "php://input", "$_SERVER['QUERY_STRING']"];
                if let Some(offset) = INPUTS.iter().filter_map(|input| self.src.find(input)).min() {
                    let line = self.src[..offset].bytes().filter(|&b| b == b'\n').count() as u32 + 1;
                    self.facts.routes.push(Route {
                        method: "ANY".to_owned(),
                        path: format!("/{path}"),
                        line,
                        handlers: Vec::new(),
                        framework: "php",
                    });
                }
            }
            _ => {}
        }
    }

    fn line_text(&self, line: u32) -> &'a str {
        self.file.line(line as usize).unwrap_or("")
    }

    fn first_string_arg(&self, args: Node) -> Option<String> {
        let mut cursor = args.walk();
        let found = args.named_children(&mut cursor).find_map(|arg| {
            let arg = self.unwrap_argument(arg);
            match arg.kind() {
                // `value = "/x"` / `path = "/x"` in annotations.
                "element_value_pair" => {
                    let key = self.text(arg.child_by_field_name("key")?);
                    matches!(key, "value" | "path").then(|| self.string_value(arg.child_by_field_name("value")?)).flatten()
                }
                _ => self.string_value(arg),
            }
        });
        found
    }

    /// The value of a plain string literal (no interpolation).
    fn string_value(&self, node: Node) -> Option<String> {
        if !matches!(
            node.kind(),
            "string" | "string_literal" | "interpreted_string_literal" | "raw_string_literal" | "template_string" | "encapsed_string"
        ) {
            // Annotation arrays: `@GetMapping({"/a", "/b"})` take the first.
            if node.kind() == "element_value_array_initializer" {
                return node.named_child(0).and_then(|first| self.string_value(first));
            }
            return None;
        }
        if self.references_values(node) {
            return None;
        }
        let text = self.text(node);
        let text = text.trim_start_matches(|c: char| c.is_ascii_alphabetic() && c != '"' && c != '\'');
        Some(text.trim_matches(['"', '\'', '`']).to_owned())
    }

    // ---- imports --------------------------------------------------------

    fn collect_imports(&mut self, root: Node) {
        let mut cursor = root.walk();
        let mut depth = 0;
        loop {
            let node = cursor.node();
            let mut descend = true;
            match (self.family, node.kind()) {
                (Family::Js, "import_statement" | "export_statement") => {
                    if let Some(source) = node.child_by_field_name("source") {
                        self.add_import(source);
                    }
                    descend = node.kind() == "export_statement";
                }
                (Family::Js, "call_expression") => {
                    let function = node.child_by_field_name("function").map(|f| self.text(f));
                    if matches!(function, Some("require" | "import")) {
                        if let Some(arg) = node.child_by_field_name("arguments").and_then(|a| a.named_child(0)) {
                            self.add_import(arg);
                        }
                    }
                }
                (Family::Js, "variable_declarator") => {
                    if let Some(target) = self.promisified(node) {
                        let name = node.child_by_field_name("name").map(|n| self.text(n).to_owned());
                        self.aliases.extend(name.map(|name| (name, target)));
                    }
                }
                (Family::Python, "import_statement") => {
                    let mut c = node.walk();
                    for name in node.children_by_field_name("name", &mut c) {
                        let module = name.child_by_field_name("name").unwrap_or(name);
                        self.facts.imports.push(Import { spec: self.text(module).to_owned(), line: line_of(node) });
                    }
                    descend = false;
                }
                (Family::Python, "import_from_statement") => {
                    if let Some(module) = node.child_by_field_name("module_name") {
                        self.facts.imports.push(Import { spec: self.text(module).to_owned(), line: line_of(node) });
                    }
                    descend = false;
                }
                (Family::Go, "import_spec") => {
                    if let Some(path) = node.child_by_field_name("path") {
                        self.add_import(path);
                    }
                    descend = false;
                }
                (Family::Java, "import_declaration") => {
                    let text =
                        self.text(node).trim_start_matches("import").trim().trim_start_matches("static ").trim_end_matches(';').trim();
                    self.facts.imports.push(Import { spec: text.to_owned(), line: line_of(node) });
                    descend = false;
                }
                (Family::Php, "namespace_use_clause") => {
                    let text = self.text(node).split_whitespace().next().unwrap_or("").trim_start_matches('\\');
                    self.facts.imports.push(Import { spec: text.to_owned(), line: line_of(node) });
                    descend = false;
                }
                _ => {}
            }
            if descend && cursor.goto_first_child() {
                depth += 1;
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if depth == 0 || !cursor.goto_parent() {
                    return;
                }
                depth -= 1;
            }
        }
    }

    /// The function wrapped by `promisify(fn)` / `util.promisify(fn)` in a declarator's value.
    fn promisified(&self, declarator: Node) -> Option<String> {
        let value = declarator.child_by_field_name("value")?;
        if value.kind() != "call_expression"
            || last_segment(&normalize_callee(self.text(value.child_by_field_name("function")?))) != "promisify"
        {
            return None;
        }
        let wrapped = value.child_by_field_name("arguments")?.named_child(0)?;
        matches!(wrapped.kind(), "identifier" | "member_expression").then(|| normalize_callee(self.text(wrapped)))
    }

    fn add_import(&mut self, node: Node) {
        if let Some(spec) = self.string_value(node) {
            if !spec.is_empty() {
                self.facts.imports.push(Import { spec, line: line_of(node) });
            }
        }
    }
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

fn last_segment(callee: &str) -> &str {
    callee.rsplit('.').next().unwrap_or(callee)
}

fn is_collection(kind: &str) -> bool {
    matches!(
        kind,
        "object"
            | "array"
            | "dictionary"
            | "list"
            | "tuple"
            | "set"
            | "composite_literal"
            | "array_creation_expression"
            | "array_initializer"
            | "list_splat"
            | "dictionary_splat"
    )
}

/// HTTP clients look like routers: `this.http.get('/api/x')`, `axios.post('/y', body)`.
fn is_client_receiver(receiver: &str) -> bool {
    let last = last_segment(receiver).to_ascii_lowercase();
    matches!(
        last.as_str(),
        "http"
            | "https"
            | "axios"
            | "client"
            | "httpclient"
            | "$http"
            | "request"
            | "superagent"
            | "got"
            | "ky"
            | "fetch"
            | "req"
            | "res"
            | "response"
            | "cache"
            | "map"
            | "params"
            | "query"
            | "headers"
            | "searchparams"
            | "store"
            | "localstorage"
            | "sessionstorage"
            | "cookies"
            | "url"
            | "api"
            | "supertest"
            | "agent"
            | "frisby"
            | "set"
            | "weakmap"
            | "redis"
            | "env"
    )
}

/// Normalises callee text to dotted form: `$this->db->query` → `db.query`,
/// `Runtime.getRuntime().exec` → `Runtime.getRuntime.exec`.
pub fn normalize_callee(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_CALLEE));
    let mut depth = 0u32;
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '(' | '[' | '<' if depth > 0 || c != '<' || out.chars().last().is_some_and(|l| l.is_alphanumeric()) => depth += 1,
            ')' | ']' | '>' if depth > 0 => depth -= 1,
            _ if depth > 0 => {}
            '-' if chars.peek() == Some(&'>') => {
                chars.next();
                out.push('.');
            }
            ':' if chars.peek() == Some(&':') => {
                chars.next();
                out.push('.');
            }
            '?' if chars.peek() == Some(&'.') => {}
            '!' => {}
            c if c.is_whitespace() => {}
            '$' if out.is_empty() || out.ends_with('.') => {}
            c => out.push(c),
        }
    }
    let mut out = out.trim_matches('.').to_owned();
    for prefix in ["this.", "self.", "await"] {
        if let Some(rest) = out.strip_prefix(prefix) {
            out = rest.to_owned();
        }
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    if out.len() > MAX_CALLEE {
        let cut = out.ceil_char_boundary(out.len() - MAX_CALLEE);
        let start = out[cut..].find('.').map_or(cut, |i| cut + i + 1);
        out = out[start..].to_owned();
    }
    out
}

fn python_methods(args: &str) -> String {
    let Some(start) = args.find("methods") else { return "GET".to_owned() };
    let list = &args[start..];
    let end = list.find(']').unwrap_or(list.len());
    let methods: Vec<String> = list[..end].split(['"', '\'']).skip(1).step_by(2).map(|method| method.to_ascii_uppercase()).collect();
    if methods.is_empty() { "GET".to_owned() } else { methods.join(",") }
}

fn java_request_method(args: &str) -> String {
    match args.find("RequestMethod.") {
        Some(i) => args[i + 14..].chars().take_while(|c| c.is_ascii_alphabetic()).collect(),
        None => "ANY".to_owned(),
    }
}

fn join_route(prefix: &str, path: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    let joined = match (prefix.is_empty(), path.is_empty()) {
        (true, true) => String::new(),
        (true, false) => path.to_owned(),
        (false, true) => prefix.to_owned(),
        (false, false) => format!("{prefix}/{path}"),
    };
    format!("/{}", joined.trim_start_matches('/'))
}

/// `src/app/(shop)/invoices/[id]/route.ts` → `/invoices/[id]`.
fn next_route_path(path: &str, root: &str) -> String {
    let start = path.find(root).map_or(0, |i| i + root.len());
    let without_root = &path[start..];
    let dir = without_root.rsplit_once('/').map_or("", |(dir, _)| dir);
    let segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty() && !(s.starts_with('(') && s.ends_with(')'))).collect();
    if root == "pages/" {
        let stem = without_root.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("");
        let mut all = segments.clone();
        if stem != "index" {
            all.push(stem);
        }
        return format!("/{}", all.join("/"));
    }
    format!("/{}", segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_callees() {
        assert_eq!(normalize_callee("$this->db->query"), "db.query");
        assert_eq!(normalize_callee("Runtime.getRuntime().exec"), "Runtime.getRuntime.exec");
        assert_eq!(normalize_callee("this.http.get<User[]>"), "http.get");
        assert_eq!(normalize_callee("models.sequelize\n  .query"), "models.sequelize.query");
        assert_eq!(normalize_callee("a?.b!.c"), "a.b.c");
        assert_eq!(normalize_callee("Foo::bar"), "Foo.bar");
        assert_eq!(normalize_callee("require('fs').readFileSync"), "require.readFileSync");
        // Long chains of multi-byte names are cut on a character boundary.
        let long = "ünïcödé.".repeat(30) + "call";
        assert!(normalize_callee(&long).ends_with(".call"));
    }

    #[test]
    fn route_paths() {
        assert_eq!(next_route_path("src/app/(shop)/invoices/[id]/route.ts", "app/"), "/invoices/[id]");
        assert_eq!(next_route_path("pages/api/users/index.ts", "pages/"), "/api/users");
        assert_eq!(join_route("/api/", "/x"), "/api/x");
        assert_eq!(join_route("users", ""), "/users");
        assert_eq!(python_methods("('/x', methods=['GET', 'POST'])"), "GET,POST");
    }
}
