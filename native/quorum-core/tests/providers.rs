use quorum_core::providers::{ClaudeParser, CodexParser};
use serde_json::json;

#[test]
fn claude_stream_is_not_repeated_by_completed_assistant_message() {
    let mut parser = ClaudeParser::default();
    parser.push(
        &json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}),
    );
    let events = parser.push(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hallo 🦀"}}}));
    assert_eq!(events[0]["delta"], "Hallo 🦀");
    assert!(parser.push(&json!({"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"Hallo 🦀"}]}})).is_empty());
    assert!(parser.push(&json!({"type":"assistant","parent_tool_use_id":"parent","message":{"id":"child","content":[{"type":"text","text":"child output"}]}})).is_empty());
}

#[test]
fn claude_tracks_tool_input_and_cached_usage() {
    let mut parser = ClaudeParser::default();
    parser.push(&json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool","name":"Read","input":{}}}}));
    let events = parser.push(&json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.rs\"}"}}}));
    assert_eq!(events[0]["input"]["path"], "a.rs");
    let events = parser.push(&json!({"type":"result","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":5}}));
    assert_eq!(events[0]["inputTokens"], 60);
    assert_eq!(events[0]["cachedTokens"], 30);
}

#[test]
fn codex_completed_items_are_emitted_once() {
    let mut parser = CodexParser::default();
    assert!(parser.push(&json!({"type":"item.updated","item":{"id":"m","type":"agent_message","text":"partial"}})).is_empty());
    let message =
        json!({"type":"item.completed","item":{"id":"m","type":"agent_message","text":"final"}});
    assert_eq!(parser.push(&message)[0]["delta"], "final");
    assert!(parser.push(&message).is_empty());
    let failed = parser.push(&json!({"type":"turn.failed","error":{"message":"rate limited"}}));
    assert_eq!(failed[0]["level"], "error");
    assert_eq!(failed[0]["text"], "rate limited");
}
