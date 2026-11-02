//! Dangerous sinks: calls that turn data into queries, commands, code, file
//! paths, outbound requests or markup. A sink is a lead, not a finding: it
//! says where to look, and whether its input is fixed in the source.

use serde::{Deserialize, Serialize};

use crate::lang::Family;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SinkKind {
    Sql,
    Nosql,
    Command,
    CodeEval,
    Path,
    Ssrf,
    Deserialization,
    Xxe,
    Xss,
    Template,
    Redirect,
    WeakCrypto,
    Jwt,
}

impl SinkKind {
    pub fn parse(name: &str) -> Option<SinkKind> {
        serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
    }
}

/// How much of a sink's input comes from runtime values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Input {
    /// Fixed in the source.
    Literal,
    /// A variable or call result: may or may not be attacker-controlled.
    Variable,
    /// Assembled from parts at runtime (concatenation, interpolation, formatting): the classic injection shape.
    Built,
}

/// Which arguments decide whether a call is interesting.
#[derive(Clone, Copy)]
enum Check {
    /// Report whatever the input, e.g. a weak hash or a disabled verification.
    Always,
    /// Report when any non-collection argument is not a literal.
    Dynamic,
}

struct Rule {
    kind: SinkKind,
    family: Family,
    /// Callee patterns, matched against the normalised dotted callee:
    /// `name` matches the last segment, `a.b` the last two, `=name` a bare call.
    callees: &'static [&'static str],
    check: Check,
    /// The file must import this module (or one of its subpaths).
    import: Option<&'static str>,
    /// The call's argument text must contain one of these (case-insensitive).
    args_contain: &'static [&'static str],
    /// ...and none of these.
    args_lack: &'static [&'static str],
}

const fn rule(kind: SinkKind, family: Family, callees: &'static [&'static str], check: Check) -> Rule {
    Rule { kind, family, callees, check, import: None, args_contain: &[], args_lack: &[] }
}

const fn imported(kind: SinkKind, family: Family, import: &'static str, callees: &'static [&'static str]) -> Rule {
    Rule { kind, family, callees, check: Check::Dynamic, import: Some(import), args_contain: &[], args_lack: &[] }
}

use Check::{Always, Dynamic};
use Family::{Go, Java, Js, Php, Python, Ruby, Rust};
use SinkKind::*;

static RULES: &[Rule] = &[
    // JavaScript and TypeScript
    rule(
        Sql,
        Js,
        &[
            ".query",
            ".execute",
            ".raw",
            ".whereRaw",
            ".orderByRaw",
            ".havingRaw",
            ".joinRaw",
            "$queryRawUnsafe",
            "$executeRawUnsafe",
            "sql.unsafe",
            ".unsafe",
            "sequelize.literal",
        ],
        Dynamic,
    ),
    Rule {
        args_contain: &["$where", "mapreduce", "$function", "$accumulator"],
        ..rule(
            Nosql,
            Js,
            &[
                ".find",
                ".findOne",
                ".update",
                ".updateOne",
                ".updateMany",
                ".remove",
                ".deleteMany",
                ".count",
                ".aggregate",
                ".mapReduce",
                ".where",
            ],
            Always,
        )
    },
    imported(Command, Js, "child_process", &["exec", "execSync", "spawn", "spawnSync", "execFile", "execFileSync", "fork"]),
    rule(Command, Js, &["shelljs.exec", "shell.exec", "execa", "execaSync", "execaCommand"], Dynamic),
    rule(
        CodeEval,
        Js,
        &[
            "=eval",
            "window.eval",
            "=Function",
            "vm.runInContext",
            "vm.runInNewContext",
            "vm.runInThisContext",
            "vm.compileFunction",
            "vm.Script",
            "safeEval",
            "notevil",
        ],
        Dynamic,
    ),
    imported(
        Path,
        Js,
        "fs",
        &[
            "readFile",
            "readFileSync",
            "writeFile",
            "writeFileSync",
            "appendFile",
            "appendFileSync",
            "createReadStream",
            "createWriteStream",
            "unlink",
            "unlinkSync",
            "rm",
            "rmSync",
            "readdir",
            "readdirSync",
            "open",
            "openSync",
            "copyFile",
            "rename",
            "access",
            "stat",
        ],
    ),
    rule(Path, Js, &[".sendFile", ".download", "res.attachment", "send.send", "serveStatic"], Dynamic),
    rule(
        Ssrf,
        Js,
        &[
            "=fetch",
            "axios",
            "axios.get",
            "axios.post",
            "axios.put",
            "axios.request",
            "axios.head",
            "got",
            "got.get",
            "got.post",
            "=request",
            "request.get",
            "request.post",
            "needle",
            "superagent.get",
            "undici.request",
            "ky",
        ],
        Dynamic,
    ),
    imported(Ssrf, Js, "http", &["http.get", "http.request"]),
    imported(Ssrf, Js, "https", &["https.get", "https.request"]),
    imported(Deserialization, Js, "node-serialize", &["unserialize"]),
    Rule { args_lack: &["safe", "json_schema", "core_schema"], ..imported(Deserialization, Js, "js-yaml", &["load", "loadAll"]) },
    Rule {
        args_contain: &["noent", "dtdload", "xinclude"],
        ..rule(Xxe, Js, &["parseXml", "parseXmlString", "libxmljs.parseXml", "libxml.parseXml", "parseXmlAsync"], Always)
    },
    rule(
        Xss,
        Js,
        &[
            "bypassSecurityTrustHtml",
            "bypassSecurityTrustScript",
            "bypassSecurityTrustStyle",
            "bypassSecurityTrustUrl",
            "bypassSecurityTrustResourceUrl",
            "trustAsHtml",
            "document.write",
            "document.writeln",
            "insertAdjacentHTML",
            ".html",
            "$.parseHTML",
        ],
        Dynamic,
    ),
    rule(
        Template,
        Js,
        &[
            "ejs.render",
            "pug.render",
            "pug.compile",
            "handlebars.compile",
            "Handlebars.compile",
            "_.template",
            "lodash.template",
            "nunjucks.renderString",
            "mustache.render",
        ],
        Dynamic,
    ),
    rule(
        Redirect,
        Js,
        &[
            "res.redirect",
            "reply.redirect",
            "ctx.redirect",
            "=redirect",
            "NextResponse.redirect",
            "Response.redirect",
            "location.assign",
            "location.replace",
            "window.open",
        ],
        Dynamic,
    ),
    Rule {
        args_contain: &["md5", "sha1", "'des", "\"des", "rc4", "ecb"],
        ..rule(WeakCrypto, Js, &["createHash", "createHmac", "createCipher", "createCipheriv", "createDecipheriv"], Always)
    },
    rule(WeakCrypto, Js, &["=md5", "=sha1"], Always),
    rule(Jwt, Js, &["jwt.decode", "jsonwebtoken.decode", "jose.decodeJwt", "=jwtDecode", "jwt_decode"], Always),
    Rule {
        args_contain: &["none", "ignoreexpiration", "ignorenotbefore"],
        ..rule(Jwt, Js, &["jwt.verify", "jsonwebtoken.verify", "expressJwt", "=expressjwt", "jwt.sign"], Always)
    },
    // Python
    rule(
        Sql,
        Python,
        &[".execute", ".executemany", ".executescript", ".raw", ".extra", "=text", "sqlalchemy.text", "RawSQL", ".mogrify"],
        Dynamic,
    ),
    Rule {
        args_contain: &["$where", "mapreduce", "$function"],
        ..rule(Nosql, Python, &[".find", ".find_one", ".update_one", ".update_many", ".delete_many", ".aggregate"], Always)
    },
    rule(
        Command,
        Python,
        &[
            "os.system",
            "os.popen",
            "os.spawnl",
            "os.spawnv",
            "os.execl",
            "os.execv",
            "os.execvp",
            "subprocess.call",
            "subprocess.run",
            "subprocess.Popen",
            "subprocess.check_output",
            "subprocess.check_call",
            "subprocess.getoutput",
            "subprocess.getstatusoutput",
            "commands.getoutput",
            "=Popen",
            "=check_output",
        ],
        Dynamic,
    ),
    rule(CodeEval, Python, &["=eval", "=exec", "=compile", "=execfile", "__import__", "importlib.import_module"], Dynamic),
    rule(
        Path,
        Python,
        &[
            "=open",
            "io.open",
            "send_file",
            "send_from_directory",
            "FileResponse",
            "os.remove",
            "os.unlink",
            "shutil.rmtree",
            "shutil.copy",
            "shutil.move",
            "tarfile.open",
            "zipfile.ZipFile",
        ],
        Dynamic,
    ),
    rule(Path, Python, &[".extractall"], Always),
    rule(
        Ssrf,
        Python,
        &[
            "requests.get",
            "requests.post",
            "requests.put",
            "requests.request",
            "requests.head",
            "urlopen",
            "urllib.request.urlopen",
            "httpx.get",
            "httpx.post",
            "httpx.request",
            "aiohttp.request",
            "urllib.request.Request",
        ],
        Dynamic,
    ),
    rule(
        Deserialization,
        Python,
        &[
            "pickle.loads",
            "pickle.load",
            "cPickle.loads",
            "dill.loads",
            "marshal.loads",
            "shelve.open",
            "jsonpickle.decode",
            "yaml.unsafe_load",
            "yaml.full_load",
            "torch.load",
            "joblib.load",
        ],
        Always,
    ),
    Rule {
        args_lack: &["safeloader", "csafeloader", "safe_load"],
        ..rule(Deserialization, Python, &["yaml.load", "yaml.load_all"], Always)
    },
    Rule {
        args_lack: &["resolve_entities=false"],
        ..rule(
            Xxe,
            Python,
            &[
                "etree.parse",
                "etree.fromstring",
                "etree.XML",
                "lxml.etree.parse",
                "xml.dom.minidom.parseString",
                "minidom.parseString",
                "xml.sax.parseString",
                "XMLParser",
            ],
            Always,
        )
    },
    rule(
        Template,
        Python,
        &["render_template_string", "jinja2.Template", "Environment.from_string", ".from_string", "mako.template.Template"],
        Dynamic,
    ),
    rule(Xss, Python, &["mark_safe", "Markup", "SafeString", "format_html"], Dynamic),
    rule(Redirect, Python, &["=redirect", "HttpResponseRedirect", "RedirectResponse", "flask.redirect"], Dynamic),
    rule(WeakCrypto, Python, &["hashlib.md5", "hashlib.sha1", "=md5", "DES.new", "ARC4.new"], Always),
    Rule {
        args_contain: &[
            "verify_signature\": false",
            "verify_signature': false",
            "verify=false",
            "algorithms=[\"none\"]",
            "algorithms=['none']",
        ],
        ..rule(Jwt, Python, &["jwt.decode"], Always)
    },
    // Go
    rule(
        Sql,
        Go,
        &[".Query", ".QueryRow", ".QueryContext", ".QueryRowContext", ".Exec", ".ExecContext", ".Raw", ".Prepare", ".PrepareContext"],
        Dynamic,
    ),
    rule(Command, Go, &["exec.Command", "exec.CommandContext", "syscall.Exec"], Dynamic),
    rule(
        Path,
        Go,
        &[
            "os.Open",
            "os.OpenFile",
            "os.ReadFile",
            "ioutil.ReadFile",
            "os.WriteFile",
            "ioutil.WriteFile",
            "os.Create",
            "os.Remove",
            "os.RemoveAll",
            "http.ServeFile",
            ".File",
            ".FileAttachment",
        ],
        Dynamic,
    ),
    rule(Ssrf, Go, &["http.Get", "http.Post", "http.Head", "http.PostForm", "http.NewRequest", "http.NewRequestWithContext"], Dynamic),
    rule(Template, Go, &["template.HTML", "template.JS", "template.URL"], Dynamic),
    rule(Redirect, Go, &["http.Redirect", ".Redirect"], Dynamic),
    rule(WeakCrypto, Go, &["md5.New", "md5.Sum", "sha1.New", "sha1.Sum", "des.NewCipher", "rc4.NewCipher"], Always),
    Rule { args_contain: &["insecureskipverify"], ..rule(WeakCrypto, Go, &["tls.Config"], Always) },
    rule(Jwt, Go, &["ParseUnverified", "jwt.ParseUnverified"], Always),
    // Java
    rule(
        Sql,
        Java,
        &[
            ".executeQuery",
            ".executeUpdate",
            ".execute",
            ".addBatch",
            ".prepareStatement",
            ".createQuery",
            ".createNativeQuery",
            ".createSQLQuery",
            ".queryForObject",
            ".queryForList",
            ".query",
            ".batchUpdate",
        ],
        Dynamic,
    ),
    rule(Command, Java, &[".exec", "ProcessBuilder"], Dynamic),
    rule(
        Path,
        Java,
        &[
            "File",
            "FileInputStream",
            "FileOutputStream",
            "FileReader",
            "FileWriter",
            "Paths.get",
            "Path.of",
            "Files.readAllBytes",
            "Files.readString",
            "Files.newInputStream",
            "Files.write",
            "Files.delete",
            "Files.copy",
            "getResourceAsStream",
        ],
        Dynamic,
    ),
    rule(
        Ssrf,
        Java,
        &[
            "URL",
            "URI.create",
            ".openConnection",
            ".getForObject",
            ".getForEntity",
            ".postForObject",
            ".exchange",
            "HttpRequest.newBuilder",
            "HttpGet",
            "HttpPost",
        ],
        Dynamic,
    ),
    rule(
        Deserialization,
        Java,
        &[
            "ObjectInputStream",
            ".readObject",
            ".readUnshared",
            "XMLDecoder",
            ".fromXML",
            "Yaml.load",
            ".enableDefaultTyping",
            ".activateDefaultTyping",
        ],
        Always,
    ),
    rule(
        Xxe,
        Java,
        &[
            "DocumentBuilderFactory.newInstance",
            "SAXParserFactory.newInstance",
            "XMLInputFactory.newInstance",
            "XMLInputFactory.newFactory",
            "TransformerFactory.newInstance",
            "SAXReader",
            "SAXBuilder",
        ],
        Always,
    ),
    rule(
        CodeEval,
        Java,
        &["ScriptEngineManager", ".getEngineByName", "SpelExpressionParser", ".parseExpression", "Ognl.getValue", "GroovyShell"],
        Dynamic,
    ),
    rule(Redirect, Java, &[".sendRedirect", "RedirectView"], Dynamic),
    Rule {
        args_contain: &["md5", "sha1", "sha-1", "\"des", "rc4", "ecb"],
        ..rule(WeakCrypto, Java, &["MessageDigest.getInstance", "Cipher.getInstance"], Always)
    },
    rule(Jwt, Java, &[".parseUnsecuredClaims", ".parseClaimsJwt", "JWT.decode"], Always),
    // Rust
    rule(
        Sql,
        Rust,
        &[
            "sqlx.query",
            "sqlx.query_as",
            "sqlx.query_scalar",
            "sql_query",
            ".batch_execute",
            ".simple_query",
            ".execute",
            ".query",
            ".query_one",
            ".query_opt",
        ],
        Dynamic,
    ),
    rule(Command, Rust, &["Command.new", "Command.new.arg", "Command.new.args"], Dynamic),
    rule(
        Path,
        Rust,
        &[
            "File.open",
            "File.create",
            "fs.read",
            "fs.read_to_string",
            "fs.write",
            "fs.remove_file",
            "fs.remove_dir_all",
            "fs.copy",
            "fs.rename",
            "NamedFile.open",
        ],
        Dynamic,
    ),
    rule(Ssrf, Rust, &["reqwest.get", "ureq.get", "ureq.post", "surf.get", "surf.post"], Dynamic),
    rule(Deserialization, Rust, &["bincode.deserialize", "serde_pickle.from_slice", "serde_pickle.from_reader"], Dynamic),
    rule(Xss, Rust, &["=Html", "PreEscaped"], Dynamic),
    rule(Redirect, Rust, &["Redirect.to", "Redirect.temporary", "Redirect.permanent", "Redirect.see_other"], Dynamic),
    rule(WeakCrypto, Rust, &["md5.compute", "Md5.new", "Sha1.new", "Md5.digest", "Sha1.digest"], Always),
    // Ruby: Active Record query methods are only injectable with a string built by interpolation.
    Rule {
        args_contain: &["#{"],
        ..rule(
            Sql,
            Ruby,
            &[
                ".where",
                ".not",
                ".order",
                ".reorder",
                ".group",
                ".having",
                ".joins",
                ".select",
                ".pluck",
                ".from",
                ".lock",
                ".exists?",
                ".calculate",
                ".delete_all",
                ".update_all",
                ".find_by",
            ],
            Dynamic,
        )
    },
    rule(
        Sql,
        Ruby,
        &[".find_by_sql", ".execute", ".exec_query", ".select_all", ".select_value", ".select_values", ".select_rows"],
        Dynamic,
    ),
    rule(
        Command,
        Ruby,
        &[
            "=system",
            "=exec",
            "=spawn",
            "=subshell",
            "=open",
            "Kernel.system",
            "Kernel.exec",
            "Kernel.spawn",
            "Kernel.open",
            "Open3.capture2",
            "Open3.capture2e",
            "Open3.capture3",
            "Open3.popen2",
            "Open3.popen3",
            "IO.popen",
            "PTY.spawn",
        ],
        Dynamic,
    ),
    rule(
        CodeEval,
        Ruby,
        &["=eval", "Kernel.eval", ".instance_eval", ".class_eval", ".module_eval", ".constantize", ".safe_constantize"],
        Dynamic,
    ),
    // Dynamic dispatch is everywhere in Ruby; it is a sink when the method name comes from the request.
    Rule { args_contain: &["params"], ..rule(CodeEval, Ruby, &["=send", ".send", "=public_send", ".public_send", ".__send__"], Dynamic) },
    rule(
        Path,
        Ruby,
        &[
            "File.read",
            "File.open",
            "File.write",
            "File.delete",
            "File.readlines",
            "IO.read",
            "IO.readlines",
            "FileUtils.rm",
            "FileUtils.rm_rf",
            "FileUtils.mv",
            "FileUtils.cp",
            "=send_file",
            "=send_data",
        ],
        Dynamic,
    ),
    rule(
        Ssrf,
        Ruby,
        &[
            "Net.HTTP.get",
            "Net.HTTP.get_response",
            "Net.HTTP.post",
            "Net.HTTP.post_form",
            "Net.HTTP.start",
            "URI.open",
            "HTTParty.get",
            "HTTParty.post",
            "Faraday.get",
            "Faraday.post",
            "Faraday.new",
            "RestClient.get",
            "RestClient.post",
            "Excon.get",
            "Typhoeus.get",
            "HTTP.get",
        ],
        Dynamic,
    ),
    rule(
        Deserialization,
        Ruby,
        &["Marshal.load", "Marshal.restore", "YAML.load", "YAML.unsafe_load", "Psych.load", "Psych.unsafe_load", "Oj.load"],
        Dynamic,
    ),
    rule(Xss, Ruby, &[".html_safe"], Always),
    rule(Xss, Ruby, &["=raw"], Dynamic),
    Rule { args_contain: &["inline:"], ..rule(Template, Ruby, &["=render"], Always) },
    rule(Template, Ruby, &["ERB.new"], Dynamic),
    Rule { args_contain: &["params", "request."], ..rule(Redirect, Ruby, &["=redirect_to", "=redirect"], Dynamic) },
    rule(WeakCrypto, Ruby, &["Digest.MD5.hexdigest", "Digest.MD5.digest", "Digest.SHA1.hexdigest", "Digest.SHA1.digest"], Always),
    // PHP
    rule(
        Sql,
        Php,
        &[
            "mysqli_query",
            "mysql_query",
            "mysqli_multi_query",
            "pg_query",
            "sqlite_query",
            ".query",
            ".exec",
            ".prepare",
            ".multi_query",
            "DB.raw",
            "DB.select",
            "DB.statement",
            ".whereRaw",
            ".selectRaw",
            ".orderByRaw",
        ],
        Dynamic,
    ),
    rule(Command, Php, &["=exec", "=system", "=shell_exec", "=passthru", "=popen", "=proc_open", "=pcntl_exec", "shell_exec"], Dynamic),
    rule(CodeEval, Php, &["=eval", "=assert", "=create_function", "=call_user_func", "=call_user_func_array", "=preg_replace"], Dynamic),
    rule(
        Path,
        Php,
        &[
            "=include",
            "=include_once",
            "=require",
            "=require_once",
            "=file_get_contents",
            "=fopen",
            "=readfile",
            "=file",
            "=file_put_contents",
            "=unlink",
            "=move_uploaded_file",
            "=copy",
            "=opendir",
            "=scandir",
        ],
        Dynamic,
    ),
    rule(Ssrf, Php, &["=curl_init", "=curl_setopt", "=fsockopen"], Dynamic),
    rule(Deserialization, Php, &["=unserialize", "=yaml_parse"], Dynamic),
    rule(Xxe, Php, &["=simplexml_load_string", "=simplexml_load_file", ".loadXML", "=libxml_disable_entity_loader"], Dynamic),
    Rule { args_contain: &["location"], ..rule(Redirect, Php, &["=header"], Dynamic) },
    rule(WeakCrypto, Php, &["=md5", "=sha1", "=crypt"], Always),
];

/// Matches a call against the rules. Returns the first matching kind.
pub fn classify_call(family: Family, callee: &str, imports: &[String], args_text: &str) -> Option<(SinkKind, bool)> {
    // Regex literals (`/x/.exec(s)`) are not command runners.
    if callee.contains('/') {
        return None;
    }
    let mut lowered: Option<String> = None;
    for rule in RULES.iter().filter(|rule| rule.family == family) {
        if !rule.callees.iter().any(|pattern| matches_callee(pattern, callee)) {
            continue;
        }
        if let Some(module) = rule.import {
            if !imports.iter().any(|spec| imports_module(spec, module)) {
                continue;
            }
        }
        if !rule.args_contain.is_empty() || !rule.args_lack.is_empty() {
            let text = lowered.get_or_insert_with(|| args_text.to_ascii_lowercase().replace(' ', ""));
            if !rule.args_contain.is_empty() && !rule.args_contain.iter().any(|needle| text.contains(needle)) {
                continue;
            }
            if rule.args_lack.iter().any(|needle| text.contains(needle)) {
                continue;
            }
        }
        return Some((rule.kind, matches!(rule.check, Check::Always)));
    }
    None
}

/// `fs`, `node:fs` and `fs/promises` all import `fs`.
fn imports_module(spec: &str, module: &str) -> bool {
    let spec = spec.strip_prefix("node:").unwrap_or(spec);
    spec == module || spec.strip_prefix(module).is_some_and(|rest| rest.starts_with('/'))
}

fn matches_callee(pattern: &str, callee: &str) -> bool {
    if let Some(exact) = pattern.strip_prefix('=') {
        return callee == exact;
    }
    if let Some(name) = pattern.strip_prefix('.') {
        return callee.len() > name.len() && callee.ends_with(name) && callee.as_bytes()[callee.len() - name.len() - 1] == b'.';
    }
    callee == pattern
        || callee.len() > pattern.len() && callee.ends_with(pattern) && callee.as_bytes()[callee.len() - pattern.len() - 1] == b'.'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callee_patterns() {
        assert!(matches_callee("exec", "cp.exec"));
        assert!(matches_callee("exec", "exec"));
        assert!(!matches_callee("exec", "cp.myexec"));
        assert!(matches_callee(".query", "db.query"));
        assert!(!matches_callee(".query", "query"));
        assert!(matches_callee("=eval", "eval"));
        assert!(!matches_callee("=eval", "x.eval"));
        assert!(matches_callee("os.system", "os.system"));
        assert!(!matches_callee("os.system", "myos.system"));
    }

    #[test]
    fn imports_gate_ambiguous_names() {
        assert_eq!(classify_call(Family::Js, "exec", &[], "(cmd)"), None);
        assert_eq!(classify_call(Family::Js, "exec", &["child_process".into()], "(cmd)"), Some((SinkKind::Command, false)));
        assert_eq!(classify_call(Family::Js, "http.get", &["@angular/common/http".into()], "(url)"), None);
        assert!(classify_call(Family::Js, "readFile", &["node:fs/promises".into()], "(p)").is_some());
        assert_eq!(classify_call(Family::Js, "/^Pages:/m.exec", &["child_process".into()], "(out)"), None);
    }

    #[test]
    fn argument_text_filters() {
        assert_eq!(classify_call(Family::Python, "yaml.load", &[], "(data, Loader=yaml.SafeLoader)"), None);
        assert!(classify_call(Family::Python, "yaml.load", &[], "(data)").is_some());
    }
}
