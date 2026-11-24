mod rpc;
use rpc::Rpc;
use serde_json::{Value, json};
use std::{collections::HashMap, io, path::Path, process::Command};
pub struct Server {
    rpc: Rpc,
    root: std::path::PathBuf,
    versions: HashMap<String, i64>,
    capabilities: Value,
}
#[derive(Debug)]
pub struct Analysis {
    pub diagnostics: Vec<Value>,
    pub diagnostics_ready: bool,
    pub hover: Value,
    pub completions: Vec<String>,
}
pub fn uri(path: &Path) -> io::Result<String> {
    let path = path
        .to_str()
        .ok_or_else(|| io::Error::other("LSP benötigt einen UTF-8-Dateipfad"))?
        .replace('\\', "/");
    let path = path.strip_prefix("//?/").unwrap_or(&path);
    let path = if path.as_bytes().get(1) == Some(&b':') {
        format!("/{path}")
    } else {
        path.to_owned()
    };
    let mut uri = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(uri)
}
impl Server {
    pub fn for_document(root: &Path, path: &str, modules: &Path) -> io::Result<Self> {
        let extension = Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        let mut command = if extension == "rs" {
            Command::new("rust-analyzer")
        } else {
            let entry = if extension == "py" {
                modules.join("pyright/langserver.index.js")
            } else if ["ts", "tsx", "js", "jsx", "mjs", "cjs"].contains(&extension) {
                modules.join("typescript-language-server/lib/cli.mjs")
            } else {
                return Err(io::Error::other(
                    "Für diesen Dateityp ist kein Language Server eingerichtet",
                ));
            };
            if !entry.is_file() {
                return Err(io::Error::other(
                    "Language Server fehlt. Installiere die Projektabhängigkeiten mit npm install.",
                ));
            }
            let mut command = Command::new("node");
            command.arg(entry).arg("--stdio");
            command
        };
        command.env_clear();
        for key in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "SYSTEMROOT",
            "SystemRoot",
            "TMPDIR",
            "TEMP",
            "TMP",
            "LANG",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let root = root.canonicalize()?;
        command.current_dir(&root);
        let options = if extension == "rs" || extension == "py" {
            Value::Null
        } else {
            json!({"hostInfo":"Quorum","disableAutomaticTypingAcquisition":true,"tsserver":{"path":modules.join("typescript/lib/tsserver.js"),"logVerbosity":"off"}})
        };
        Self::launch(command, &root, options)
    }
    pub fn launch(command: Command, root: &Path, options: Value) -> io::Result<Self> {
        let root = super::Workspace::open(root)?.root;
        let root_uri = uri(&root)?;
        let mut rpc = Rpc::spawn(command, root_uri.clone())?;
        let capabilities=rpc.request("initialize",json!({"processId":std::process::id(),"rootUri":root_uri,"workspaceFolders":[{"uri":root_uri,"name":"Quorum"}],"capabilities":{"workspace":{"applyEdit":false,"workspaceFolders":true},"textDocument":{"hover":{"contentFormat":["markdown","plaintext"]},"completion":{"completionItem":{"snippetSupport":false}},"publishDiagnostics":{"versionSupport":true}}},"initializationOptions":options}))?;
        rpc.notify("initialized", json!({}))?;
        Ok(Self {
            rpc,
            root,
            versions: HashMap::new(),
            capabilities: capabilities["capabilities"].clone(),
        })
    }
    pub fn inspect(
        &mut self,
        path: &str,
        text: &str,
        line: u32,
        character: u32,
    ) -> io::Result<Analysis> {
        if text.len() > 2 * 1024 * 1024 {
            return Err(io::Error::other("Dokument ist für LSP zu groß"));
        }
        let absolute = super::Workspace::open(&self.root)?.resolve(Path::new(path))?;
        let uri = uri(&absolute)?;
        if self.versions.len() >= 32 && !self.versions.contains_key(&uri) {
            return Err(io::Error::other("Maximal 32 LSP-Dokumente pro Server"));
        }
        let first = !self.versions.contains_key(&uri);
        let version = self.versions.entry(uri.clone()).or_default();
        *version += 1;
        let version = *version;
        if let Ok(mut diagnostics) = self.rpc.diagnostics.lock() {
            diagnostics.remove(&uri);
        }
        let language = match Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some("rs") => "rust",
            Some("py") => "python",
            Some("tsx") => "typescriptreact",
            Some("jsx") => "javascriptreact",
            Some("ts") => "typescript",
            _ => "javascript",
        };
        if first {
            self.rpc.notify("textDocument/didOpen",json!({"textDocument":{"uri":uri,"languageId":language,"version":version,"text":text}}))?;
        } else {
            self.rpc.notify("textDocument/didChange",json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}))?;
        }
        let position =
            json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character}});
        let hover = if self.capabilities["hoverProvider"] == false
            || self.capabilities["hoverProvider"].is_null()
        {
            Value::Null
        } else {
            self.rpc.request("textDocument/hover", position.clone())?
        };
        let completions = if self.capabilities["completionProvider"].is_null() {
            Value::Null
        } else {
            self.rpc.request("textDocument/completion", position)?
        };
        let completions = completions
            .as_array()
            .or_else(|| completions["items"].as_array())
            .into_iter()
            .flatten()
            .take(50)
            .filter_map(|item| item["label"].as_str().map(str::to_owned))
            .collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
        let diagnostics = loop {
            let current = self
                .rpc
                .diagnostics
                .lock()
                .map_err(|_| io::Error::other("LSP diagnostics lock poisoned"))?
                .get(&uri)
                .filter(|params| {
                    params["version"]
                        .as_i64()
                        .is_none_or(|value| value == version)
                })
                .cloned();
            if current.is_some() || std::time::Instant::now() >= deadline {
                break current;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        let diagnostics_ready = diagnostics.is_some();
        let diagnostics = diagnostics
            .and_then(|params| params["diagnostics"].as_array().cloned())
            .unwrap_or_default();
        Ok(Analysis {
            diagnostics,
            diagnostics_ready,
            hover,
            completions,
        })
    }
}
