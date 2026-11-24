use serde_json::Value;
use std::io;
use std::process::Command;

pub fn build(bootstrap: &Value) -> io::Result<Command> {
    let request = &bootstrap["request"];
    let options = &request["options"];
    let provider = request["provider"]
        .as_str()
        .ok_or_else(|| io::Error::other("Missing provider"))?;
    if !matches!(provider, "claude" | "codex") {
        return Err(io::Error::other("Native provider is not implemented yet"));
    }
    if request["attachments"]
        .as_array()
        .is_some_and(|items| !items.is_empty())
        || request
            .get("imageGen")
            .is_some_and(|value| !value.is_null())
    {
        return Err(io::Error::other(
            "Native image/attachment transport is not implemented yet",
        ));
    }
    if options["chatMode"]
        .as_str()
        .is_some_and(|mode| !matches!(mode, "coding" | "text"))
    {
        return Err(io::Error::other(
            "Native worker currently supports text and coding modes only",
        ));
    }
    if let Some(values) = options.as_object() {
        let allowed = [
            "chatMode",
            "model",
            "effort",
            "fullAccess",
            "permission",
            "systemPrompt",
            "sandbox",
            "liveInput",
        ];
        for (key, value) in values {
            if !allowed.contains(&key.as_str()) && !value.is_null() {
                return Err(io::Error::other(format!(
                    "Native option '{key}' is not implemented; launch refused"
                )));
            }
        }
    }
    if request["live"] == true
        || request["resume"]["fork"] == true
        || request.get("review").is_some_and(|value| !value.is_null())
    {
        return Err(io::Error::other(
            "Native live-input, fork and review commands are not implemented yet",
        ));
    }
    let binary = bootstrap["settings"]["binaries"][provider]
        .as_str()
        .unwrap_or(provider);
    let cwd = request["cwd"]
        .as_str()
        .ok_or_else(|| io::Error::other("Missing workspace"))?;
    if !std::path::Path::new(cwd).is_dir() {
        return Err(io::Error::other("Workspace does not exist"));
    }
    let mut command = Command::new(binary);
    command
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0");
    let model = options["model"]
        .as_str()
        .filter(|model| !model.trim().is_empty());
    let text_only = options["chatMode"] == "text";
    let full_access = options["fullAccess"] == true && !text_only;
    if provider == "claude" {
        if request["images"]
            .as_array()
            .is_some_and(|images| !images.is_empty())
        {
            command.args(["--input-format", "stream-json"]);
        }
        command.args([
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]);
        if text_only {
            command.args([
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
            ]);
        }
        if let Some(model) = model {
            command.args([
                "--model",
                match model {
                    "fable" => "claude-fable-5-2",
                    "opus" => "claude-opus-5-5",
                    "sonnet" => "claude-sonnet-5-5",
                    "haiku" => "claude-haiku-5-5",
                    model => model,
                },
            ]);
        }
        if let Some(effort) = options["effort"].as_str() {
            command.args(["--effort", effort]);
        }
        if full_access {
            command.arg("--dangerously-skip-permissions");
        }
        if !full_access {
            command.args([
                "--permission-mode",
                options["permission"].as_str().unwrap_or("plan"),
            ]);
        }
        if let Some(system) = options["systemPrompt"].as_str() {
            command.args(["--append-system-prompt", system]);
        }
        if let Some(session) = request["resume"]["sessionId"].as_str() {
            command.args(["--resume", session]);
        }
        if request["resume"]["continueLast"] == true {
            command.arg("--continue");
        }
    }
    if provider == "codex" {
        command.args(["exec", "-C", cwd]);
        if !full_access {
            command.args([
                "-s",
                if text_only {
                    "read-only"
                } else {
                    options["sandbox"].as_str().unwrap_or("read-only")
                },
            ]);
        }
        let resume = request["resume"]["sessionId"].as_str();
        let last = request["resume"]["continueLast"] == true;
        if resume.is_some() || last {
            command.arg("resume");
        }
        command.args(["--json", "--skip-git-repo-check"]);
        if let Some(model) = model {
            command.args(["-m", model]);
        }
        if full_access {
            command.arg("--dangerously-bypass-approvals-and-sandbox");
        }
        for (field, key) in [
            ("effort", "model_reasoning_effort"),
            ("systemPrompt", "developer_instructions"),
        ] {
            if let Some(value) = options[field].as_str() {
                command
                    .arg("-c")
                    .arg(format!("{key}={}", serde_json::to_string(value)?));
            }
        }
        if let Some(images) = request["images"].as_array() {
            for image in images {
                if let Some(path) = image.as_str() {
                    command.args(["-i", path]);
                }
            }
        }
        if let Some(session) = resume {
            command.arg(session);
        }
        if resume.is_none() && last {
            command.arg("--last");
        }
        command.arg("-");
    }
    Ok(command)
}

pub(super) fn prompt(bootstrap: &Value) -> io::Result<Vec<u8>> {
    use base64::Engine;
    let request = &bootstrap["request"];
    let mut text = request["prompt"]
        .as_str()
        .ok_or_else(|| io::Error::other("Missing prompt"))?
        .to_owned();
    if let Some(files) = request["files"].as_array() {
        for file in files {
            let body = file["text"]
                .as_str()
                .ok_or_else(|| io::Error::other("Textanhang fehlt"))?;
            if body.len() > 2 * 1024 * 1024 {
                return Err(io::Error::other("Textanhang zu groß"));
            }
            text.push_str(&format!(
                "\n\nDatei: {}\n<file_content>\n{}\n</file_content>\n",
                file["name"].as_str().unwrap_or("Datei"),
                body
            ));
        }
    }
    let images = request["images"].as_array();
    if request["provider"] != "claude" || images.is_none_or(|images| images.is_empty()) {
        return Ok(text.into_bytes());
    }
    let mut content = vec![serde_json::json!({"type":"text","text":text})];
    if let Some(images) = images {
        if images.len() > 8 {
            return Err(io::Error::other("Zu viele Bilder"));
        }
        for image in images {
            let path = image
                .as_str()
                .ok_or_else(|| io::Error::other("Bildpfad fehlt"))?;
            use std::io::Read;
            let mut bytes = Vec::new();
            std::fs::File::open(path)?
                .take(10 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 10 * 1024 * 1024 {
                return Err(io::Error::other("Bild zu groß"));
            }
            let mime = crate::workspace::attachments::image_mime(&bytes)
                .ok_or_else(|| io::Error::other("Nicht unterstütztes Bildformat"))?;
            content.push(serde_json::json!({"type":"image","source":{"type":"base64","media_type":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
        }
    }
    let mut bytes = serde_json::to_vec(
        &serde_json::json!({"type":"user","message":{"role":"user","content":content}}),
    )?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::build;
    use serde_json::json;

    #[test]
    fn text_mode_cannot_inherit_full_access() {
        let command = build(&json!({"request":{"provider":"codex","cwd":std::env::current_dir().unwrap(),"options":{"chatMode":"text","fullAccess":true}}})).unwrap();
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|argument| argument == "read-only"));
        assert!(!args.iter().any(|argument| argument.contains("dangerously")));
    }

    #[test]
    fn unsupported_tool_restrictions_are_not_silently_dropped() {
        assert!(build(&json!({"request":{"provider":"claude","cwd":std::env::current_dir().unwrap(),"options":{"allowedTools":"Read"}}})).is_err());
    }
}
