#!/usr/bin/python3
"""ACP test peer. It reads synthetic prompts from stdin and uses no network."""
import json
import sys

def send(**fields):
    print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)

if "acp" not in sys.argv:
    raise SystemExit("Expected an ACP request")
for line in sys.stdin:
    req = json.loads(line)
    method = req["method"]
    if method == "initialize":
        result = {"protocolVersion": 1, "authMethods": [{"id": "oauth-personal"}]}
    elif method in ("session/load", "session/new"):
        result = {"sessionId": "demo-session", "models": {"currentModelId": "demo-cli", "availableModels": [{"modelId": "demo-cli"}]}}
    elif method == "session/prompt":
        send(method="session/update", params={"sessionId": req["params"]["sessionId"], "update": {"sessionUpdate": "agent_message_chunk","content": {"type": "text", "text": "Public fixture reply"}}})
        result = {"stopReason": "end_turn"}
    else:
        send(id=req["id"], error={"code": -32601, "message": "Unsupported method"})
        continue
    send(id=req["id"], result=result)
