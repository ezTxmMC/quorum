use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Default)]
pub struct CodexParser {
    completed: HashSet<String>,
}

impl CodexParser {
    pub fn push(&mut self, event: &Value) -> Vec<Value> {
        match event["type"].as_str().unwrap_or("") {
            "thread.started" => vec![json!({"type":"session","sessionId":event["thread_id"]})],
            "turn.completed" => vec![
                json!({"type":"usage","inputTokens":event["usage"]["input_tokens"],"outputTokens":event["usage"]["output_tokens"],"cachedTokens":event["usage"]["cached_input_tokens"]}),
            ],
            "turn.failed" | "error" => vec![
                json!({"type":"notice","level":"error","text":event["error"]["message"].as_str().or_else(|| event["message"].as_str()).unwrap_or("Codex request failed")}),
            ],
            "item.started" | "item.updated" | "item.completed" => self.item(event),
            _ => Vec::new(),
        }
    }

    fn item(&mut self, event: &Value) -> Vec<Value> {
        let item = &event["item"];
        let id = item["id"].as_str().unwrap_or("");
        if id.is_empty() || self.completed.contains(id) {
            return Vec::new();
        }
        let finished = event["type"] == "item.completed";
        if finished {
            self.completed.insert(id.to_owned());
        }
        match item["type"].as_str().unwrap_or("") {
            "agent_message" if finished => {
                vec![json!({"type":"text","delta":item["text"].as_str().unwrap_or("")})]
            }
            "reasoning" if finished => {
                vec![json!({"type":"thinking","delta":item["text"].as_str().unwrap_or("")})]
            }
            "command_execution" => {
                let mut events = vec![
                    json!({"type":"tool_start","id":id,"name":"shell","input":item["command"]}),
                ];
                if finished {
                    events.push(json!({"type":"tool_end","id":id,"output":item["aggregated_output"].as_str().unwrap_or(""),"isError":item["exit_code"].as_i64().is_some_and(|code| code != 0)}));
                }
                events
            }
            _ => Vec::new(),
        }
    }
}
