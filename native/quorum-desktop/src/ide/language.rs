use super::*;
use quorum_core::workspace::lsp::Server;
use std::sync::Mutex;

fn contents(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    if let Some(text) = value["value"].as_str() {
        return text.into();
    }
    value
        .as_array()
        .map(|items| items.iter().map(contents).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default()
}
impl NativeIde {
    pub(super) fn inspect_language(&mut self, cx: &mut Context<Self>) {
        if self.lsp_busy {
            return;
        }
        let Some(tab) = self
            .tabs
            .iter()
            .find(|tab| Some(&tab.key) == self.selected.as_ref())
        else {
            return;
        };
        let key = tab.key.clone();
        let root = tab.root.clone();
        let path = tab.path.clone();
        let text = tab.editor.read(cx).text().to_owned();
        let expected = text.clone();
        let (line, character) = tab.editor.read(cx).position();
        let extension = Path::new(&path)
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("");
        let language = if ["ts", "tsx", "js", "jsx", "mjs", "cjs"].contains(&extension) {
            "typescript"
        } else {
            extension
        };
        let server_key = format!("{root}\0{language}");
        if self.language_servers.len() >= 8 && !self.language_servers.contains_key(&server_key) {
            self.error =
                "Maximal 8 Sprachserver. Beende ungenutzte Server und versuche es erneut.".into();
            cx.notify();
            return;
        }
        let server = self.language_servers.get(&server_key).cloned();
        let modules = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.parent()
                    .map(|parent| parent.join("language-servers/node_modules"))
            })
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules")
            });
        self.lsp_busy = true;
        self.service_mode = ServiceMode::Language;
        self.lsp_output = "Language Server wird abgefragt …".into();
        let task = cx.background_executor().spawn(async move {
            let server = match server {
                Some(server) => server,
                None => Arc::new(Mutex::new(Server::for_document(
                    Path::new(&root),
                    &path,
                    &modules,
                )?)),
            };
            let analysis = server
                .lock()
                .map_err(|_| std::io::Error::other("LSP lock poisoned"))?
                .inspect(&path, &text, line, character)?;
            Ok::<_, std::io::Error>((server, analysis))
        });
        self.tasks.insert("lsp-inspect".into(),cx.spawn(async move|view,cx|{
            let result=task.await;let _=view.update(cx,|view,cx|{
                view.lsp_busy=false;
                if view.selected.as_deref()!=Some(&key){return;}
                if !view.tabs.iter().any(|tab|tab.key==key&&tab.editor.read(cx).text()==expected){view.lsp_output="Dokument wurde geändert. Erneut prüfen.".into();cx.notify();return;}
                match result{
                    Ok((server,analysis))=>{
                        view.language_servers.insert(server_key,server);
                        let mut output=String::new();
                        for diagnostic in &analysis.diagnostics {
                            output.push_str(&format!("{}:{}  {}\n\n",diagnostic["range"]["start"]["line"].as_u64().unwrap_or(0)+1,diagnostic["range"]["start"]["character"].as_u64().unwrap_or(0)+1,diagnostic["message"].as_str().unwrap_or("Diagnose")));
                        }
                        if output.is_empty(){output=if analysis.diagnostics_ready{"Keine Diagnosen für die aktuelle Dokumentversion.\n\n"}else{"Noch keine Diagnose für die aktuelle Dokumentversion gemeldet.\n\n"}.into();}
                        let hover=contents(&analysis.hover["contents"]);
                        if !hover.is_empty(){output.push_str("Am Cursor:\n");output.push_str(&hover);output.push_str("\n\n");}
                        if !analysis.completions.is_empty(){output.push_str("Vervollständigungen am Cursor:\n");output.push_str(&analysis.completions.join("\n"));}
                        view.lsp_output=output;view.error.clear();
                    }
                    Err(error)=>{view.lsp_output=error.to_string();view.language_servers.remove(&server_key);}
                }
                cx.notify();
            });
        }));
        cx.notify();
    }
}
