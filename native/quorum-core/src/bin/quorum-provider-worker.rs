use quorum_core::worker;
use serde_json::json;

fn main() {
    if let Err(error) = worker::run() {
        let _ = worker::emit(json!({"type":"done","ok":false,"error":error.to_string()}));
        std::process::exit(1);
    }
}
