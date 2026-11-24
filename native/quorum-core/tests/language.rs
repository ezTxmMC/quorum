use quorum_core::workspace::{
    lsp::{Server, uri},
    syntax::{self, Language, TokenKind},
};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
#[test]
fn syntax_tokens_keep_unicode_byte_boundaries_and_comments() {
    let text = "pub fn Grüße() { let x = \"🦀 // literal\"; } // comment";
    let tokens = syntax::line(text, Language::Rust);
    assert_eq!(
        tokens
            .iter()
            .map(|token| &text[token.range.clone()])
            .collect::<String>(),
        text
    );
    assert!(tokens.iter().any(|token| token.kind == TokenKind::String
        && &text[token.range.clone()] == "\"🦀 // literal\""));
    assert_eq!(tokens.last().unwrap().kind, TokenKind::Comment);
    let tokens = syntax::line("fn f(x: &'static str)", Language::Rust);
    assert!(!tokens.iter().any(|token| token.kind == TokenKind::String));
    assert!(
        uri(Path::new("/tmp/a b#🦀.ts"))
            .unwrap()
            .contains("a%20b%23%F0%9F%A6%80.ts")
    );
}
#[cfg(unix)]
#[test]
fn native_lsp_frames_unicode_and_filters_stale_diagnostics() {
    let root = std::env::temp_dir().join(format!(
        "quorum-lsp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let script = root.join("server.py");
    fs::write(&script,r#"
import sys,json

def send(value):
    body=json.dumps({'jsonrpc':'2.0',**value},ensure_ascii=False).encode()
    sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n'%len(body)).encode()+body)
    sys.stdout.buffer.flush()

while True:
    headers={}
    while True:
        line=sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line in (b'\r\n',b'\n'): break
        key,value=line.decode().split(':',1);headers[key.lower()]=value.strip()
    message=json.loads(sys.stdin.buffer.read(int(headers['content-length'])))
    method=message.get('method')
    if method=='initialize':
        send({'id':'server-config','method':'workspace/configuration','params':{'items':[{}]}})
        send({'id':message['id'],'result':{'capabilities':{'hoverProvider':True,'completionProvider':{}}}})
    elif method in ('textDocument/didOpen','textDocument/didChange'):
        document=message['params']['textDocument'];version=document['version']
        for current in (version-1,version):
            send({'method':'textDocument/publishDiagnostics','params':{'uri':document['uri'],'version':current,'diagnostics':[{'range':{'start':{'line':0,'character':0},'end':{'line':0,'character':1}},'severity':2,'message':'version '+str(current)}]}})
    elif method=='textDocument/hover': send({'id':message['id'],'result':{'contents':{'kind':'markdown','value':'Grüße 🦀'}}})
    elif method=='textDocument/completion': send({'id':message['id'],'result':[{'label':'native_completion'}]})
"#).unwrap();
    fs::write(root.join("Grüße file.ts"), "const x = 1;").unwrap();
    let mut command = Command::new("python3");
    command.arg(&script);
    let mut server = Server::launch(command, &root, serde_json::Value::Null).unwrap();
    let first = server
        .inspect("Grüße file.ts", "const Grüße = '🦀';", 0, 6)
        .unwrap();
    assert_eq!(first.hover["contents"]["value"], "Grüße 🦀");
    assert_eq!(first.completions, vec!["native_completion"]);
    assert!(first.diagnostics_ready);
    assert_eq!(first.diagnostics[0]["message"], "version 1");
    let second = server
        .inspect("Grüße file.ts", "const Grüße = 'changed';", 0, 6)
        .unwrap();
    assert_eq!(second.diagnostics[0]["message"], "version 2");
    assert!(server.inspect("../outside.ts", "", 0, 0).is_err());
    drop(server);
    fs::remove_dir_all(root).unwrap();
}
