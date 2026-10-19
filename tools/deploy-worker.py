#!/usr/bin/env python3
"""SELF-REPAIR: deploy the worker from the repo's canonical source.
Runs in GitHub Actions. Env: CF_TOKEN, CF_ACCOUNT, CF_VIEWS_KV,
FOREMAN_KEY, DEPLOY_PAT, GUMROAD_TOKEN, TELEGRAM_TOKEN, OWNER_CHAT_ID."""
import base64, json, os, sys, urllib.request
API = "https://api.cloudflare.com/client/v4"
NAME = "northbench-foreman"
def call(path, token, payload=None, method="GET"):
    headers = {"Authorization": "Bearer " + token}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())
def main():
    token = os.environ["CF_TOKEN"]; account = os.environ["CF_ACCOUNT"]
    js = open("worker/foreman.js", encoding="utf-8").read()
    payload = {
        "account_id": account, "main_module": "worker.js",
        "compatibility_date": "2024-09-23",
        "bindings": [
            {"type": "ai", "name": "AI"},
            {"type": "kv_namespace", "name": "VIEWS", "namespace_id": os.environ["CF_VIEWS_KV"]},
            {"type": "plain_text", "name": "TELEGRAM_TOKEN", "text": os.environ["TELEGRAM_TOKEN"]},
            {"type": "plain_text", "name": "OWNER_CHAT_ID", "text": os.environ["OWNER_CHAT_ID"]},
            {"type": "plain_text", "name": "FOREMAN_KEY", "text": os.environ["FOREMAN_KEY"]},
            {"type": "plain_text", "name": "GITHUB_TOKEN", "text": os.environ["DEPLOY_PAT"]},
            {"type": "plain_text", "name": "GUMROAD_TOKEN", "text": os.environ["GUMROAD_TOKEN"]},
        ],
        "modules": [{"name": "worker.js", "content_type": "application/javascript+module",
                     "content_base64": base64.b64encode(js.encode()).decode()}],
    }
    res = call(f"/accounts/{account}/workers/workers/{NAME}/versions", token, payload, method="POST")
    vid = res["result"]["id"]
    call(f"/accounts/{account}/workers/scripts/{NAME}/deployments", token,
         {"strategy": "percentage", "versions": [{"percentage": 100, "version_id": vid}]}, method="POST")
    print("self-repair deploy ok, version", vid[:13])
if __name__ == "__main__":
    main()
