"""Minimalny serwer MCP (stdio) na potrzeby gate'u fazy 5 — jeden tool `echo`.

Zero zależności: `mcp`/`fastmcp` nie ma w venv (`tools/mcp_tool._MCP_AVAILABLE`
= False), więc protokół piszemy ręcznie. Transport stdio MCP = JSON-RPC 2.0
linia-po-linii (NIE framing Content-Length — to LSP). Odpowiadamy tylko na to,
czego wymaga handshake + wywołanie narzędzia; reszta metod dostaje -32601.

Uruchamiany dokładnie tak, jak wpis w `plugins.json`:
`command: <python>, args: [<ścieżka do tego pliku>]`.
"""

import json
import sys

_PROTOCOL = "2024-11-05"
_ECHO = {
    "name": "echo",
    "description": "Zwraca z powrotem przekazany tekst.",
    "inputSchema": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    },
}


def _send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def _result(req_id, result: dict) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _handle(msg: dict) -> None:
    method, req_id = msg.get("method"), msg.get("id")
    if method == "initialize":
        client_proto = (msg.get("params") or {}).get("protocolVersion") or _PROTOCOL
        _result(req_id, {
            "protocolVersion": client_proto,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-echo", "version": "0.1.0"},
        })
    elif method == "notifications/initialized":
        return  # notyfikacja — bez id, bez odpowiedzi
    elif method == "tools/list":
        _result(req_id, {"tools": [_ECHO]})
    elif method == "tools/call":
        params = msg.get("params") or {}
        text = (params.get("arguments") or {}).get("text", "")
        if params.get("name") == "echo":
            _result(req_id, {"content": [{"type": "text", "text": text}], "isError": False})
        else:
            _send({"jsonrpc": "2.0", "id": req_id,
                   "error": {"code": -32602, "message": "unknown tool"}})
    elif req_id is not None:
        _send({"jsonrpc": "2.0", "id": req_id,
               "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    for line in sys.stdin:  # EOF na stdin = koniec
        line = line.strip()
        if line:
            _handle(json.loads(line))


if __name__ == "__main__":
    main()
