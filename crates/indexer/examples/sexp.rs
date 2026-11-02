use tree_sitter::Parser;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let src = std::fs::read_to_string(&args[2]).unwrap();
    let lang: tree_sitter::Language = match args[1].as_str() {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        _ => tree_sitter_ruby::LANGUAGE.into(),
    };
    let mut p = Parser::new();
    p.set_language(&lang).unwrap();
    let tree = p.parse(&src, None).unwrap();
    // print with field names, indented
    fn walk(c: &mut tree_sitter::TreeCursor, src: &str, depth: usize) {
        loop {
            let n = c.node();
            if n.is_named() {
                let field = c.field_name().map(|f| format!("{f}: ")).unwrap_or_default();
                let text = if n.child_count() == 0 { format!(" {:?}", &src[n.byte_range()]) } else { String::new() };
                println!("{}{}{}{}", "  ".repeat(depth), field, n.kind(), text);
            }
            if c.goto_first_child() {
                walk(c, src, depth + 1);
                c.goto_parent();
            }
            if !c.goto_next_sibling() {
                break;
            }
        }
    }
    walk(&mut tree.walk(), &src, 0);
}
