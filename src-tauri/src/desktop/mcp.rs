use super::Channel;
use serde_json::{json, Value};
use std::io::{Cursor, Read};
use tauri::AppHandle;
use tiny_http::{Header, Request, Response, Server, StatusCode};

const MAX_BODY: u64 = 4 * 1024 * 1024;

pub fn serve(app: &AppHandle, token: String) -> Result<u16, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("no pude abrir el servidor MCP: {}", e))?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("el servidor MCP no tiene puerto")?;
    let app = app.clone();
    std::thread::Builder::new()
        .name("guillecode-mcp".into())
        .spawn(move || {
            for req in server.incoming_requests() {
                let app = app.clone();
                let token = token.clone();
                std::thread::spawn(move || handle(&app, req, &token));
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(port)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn reply(req: Request, status: u16, body: Option<&Value>) {
    let data = body.map(|b| serde_json::to_vec(b).unwrap_or_default()).unwrap_or_default();
    let mut headers = vec![header("Cache-Control", "no-store")];
    if body.is_some() {
        headers.push(header("Content-Type", "application/json"));
    }
    if status == 405 {
        headers.push(header("Allow", "POST, DELETE"));
    }
    let len = data.len();
    let _ = req.respond(Response::new(StatusCode(status), headers, Cursor::new(data), Some(len), None));
}

fn handle(app: &AppHandle, mut req: Request, token: &str) {
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let channel = match path.as_str() {
        "/mcp/desktop" => Channel::Desktop,
        "/mcp/browser" => Channel::Browser,
        "/mcp/routines" => Channel::Routines,
        "/mcp/terminal" => Channel::Terminal,
        "/mcp/worktrees" => Channel::Worktrees,
        _ => return reply(req, 404, Some(&json!({ "error": "no existe" }))),
    };
    let expected = format!("Bearer {}", token);
    let authorized = req.headers().iter().any(|h| h.field.equiv("Authorization") && h.value.as_str() == expected);
    if !authorized {
        return reply(req, 401, Some(&json!({ "error": "token inválido" })));
    }
    match req.method().as_str() {
        "POST" => {}
        "DELETE" => return reply(req, 200, None),
        _ => return reply(req, 405, None),
    }
    let mut body = String::new();
    let _ = Read::take(req.as_reader(), MAX_BODY).read_to_string(&mut body);
    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return reply(req, 400, Some(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "JSON inválido" } }))),
    };
    if let Some(batch) = parsed.as_array() {
        let answers: Vec<Value> = batch.iter().filter_map(|m| dispatch(app, channel, m)).collect();
        if answers.is_empty() {
            return reply(req, 202, None);
        }
        return reply(req, 200, Some(&Value::Array(answers)));
    }
    match dispatch(app, channel, &parsed) {
        Some(answer) => reply(req, 200, Some(&answer)),
        None => reply(req, 202, None),
    }
}

fn dispatch(app: &AppHandle, channel: Channel, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().filter(|v| !v.is_null())?;
    let method = message["method"].as_str().unwrap_or_default();
    let params = &message["params"];
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": format!("guillecode-{}", channel.name()), "version": env!("CARGO_PKG_VERSION") },
            "instructions": super::instructions(channel),
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": super::tool_list(channel) })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default().to_string();
            let args = if params["arguments"].is_object() { params["arguments"].clone() } else { json!({}) };
            Ok(super::call_tool(app, channel, &name, &args))
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        other => Err((-32601, format!("método no soportado: {}", other))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, text)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } }),
    })
}
