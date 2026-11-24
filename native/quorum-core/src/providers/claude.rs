use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct ClaudeParser {
    streamed: HashSet<String>,
    partial_tools: HashMap<String, (String, String, String)>,
    session: Option<String>,
}

impl ClaudeParser {
    pub fn push(&mut self, message: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        let parent = message.get("parent_tool_use_id").and_then(Value::as_str);
        if let Some(session) = message.get("session_id").and_then(Value::as_str)
            && self.session.as_deref() != Some(session)
        {
            self.session = Some(session.to_owned());
            events.push(json!({"type":"session", "sessionId":session}));
        }
        match message["type"].as_str().unwrap_or("") {
            "stream_event" => self.stream(&message["event"], parent, &mut events),
            "assistant" => {
                let id = message["message"]["id"].as_str().unwrap_or("");
                if let Some(content) = message["message"]["content"].as_array() {
                    for block in content {
                        match block["type"].as_str().unwrap_or("") {
                            "text" | "thinking" if parent.is_none() && !self.streamed.contains(id) => {
                                let thinking = block["type"] == "thinking";
                                let text = if thinking { &block["thinking"] } else { &block["text"] };
                                if let Some(text) = text.as_str() {
                                    events.push(json!({"type":if thinking {"thinking"} else {"text"},"delta":text}));
                                }
                            }
                            "tool_use" => events.push(json!({"type":"tool_start","id":block["id"],"name":block["name"],"input":block["input"],"parentId":parent})),
                            _ => {}
                        }
                    }
                }
            }
            "user" => {
                if let Some(content) = message["message"]["content"].as_array() {
                    for block in content {
                        if block["type"] != "tool_result" {
                            continue;
                        }
                        let output = block["content"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| block["content"].to_string());
                        events.push(json!({"type":"tool_end","id":block["tool_use_id"],"output":output,"isError":block["is_error"].as_bool().unwrap_or(false)}));
                    }
                }
            }
            "result" if parent.is_none() => {
                let usage = &message["usage"];
                let input = usage["input_tokens"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0))
                    .saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0));
                events.push(json!({"type":"usage","inputTokens":input,"outputTokens":usage["output_tokens"],"cachedTokens":usage["cache_read_input_tokens"],"costUsd":message["total_cost_usd"],"durationMs":message["duration_ms"]}));
                if message["is_error"] == true {
                    events.push(json!({"type":"notice","level":"error","text":message["result"].as_str().unwrap_or("Claude request failed")}));
                }
            }
            _ => {}
        }
        events
    }

    fn stream(&mut self, event: &Value, parent: Option<&str>, events: &mut Vec<Value>) {
        let key = format!("{}:{}", parent.unwrap_or("main"), event["index"]);
        match event["type"].as_str().unwrap_or("") {
            "message_start" if parent.is_none() => {
                if let Some(id) = event["message"]["id"].as_str() {
                    self.streamed.insert(id.to_owned());
                }
            }
            "content_block_delta" if event["delta"]["type"] == "input_json_delta" => {
                let Some(tool) = self.partial_tools.get_mut(&key) else {
                    return;
                };
                let delta = event["delta"]["partial_json"].as_str().unwrap_or("");
                if tool.2.len() + delta.len() > 262144 {
                    self.partial_tools.remove(&key);
                    return;
                }
                tool.2.push_str(delta);
                if let Ok(input) = serde_json::from_str::<Value>(&tool.2) {
                    events.push(json!({"type":"tool_start","id":tool.0,"name":tool.1,"input":input,"parentId":parent}));
                }
            }
            "content_block_delta" if parent.is_none() => {
                let delta = &event["delta"];
                let (kind, key) = match delta["type"].as_str() {
                    Some("text_delta") => ("text", "text"),
                    Some("thinking_delta") => ("thinking", "thinking"),
                    _ => return,
                };
                if let Some(text) = delta[key].as_str() {
                    events.push(json!({"type":kind,"delta":text}));
                }
            }
            "content_block_start" if event["content_block"]["type"] == "tool_use" => {
                let block = &event["content_block"];
                let id = block["id"].as_str().unwrap_or("").to_owned();
                let name = block["name"].as_str().unwrap_or("").to_owned();
                events.push(json!({"type":"tool_start","id":id,"name":name,"input":block["input"],"parentId":parent}));
                self.partial_tools.insert(key, (id, name, String::new()));
            }
            "content_block_stop" => {
                self.partial_tools.remove(&key);
            }
            _ => {}
        }
    }
}
