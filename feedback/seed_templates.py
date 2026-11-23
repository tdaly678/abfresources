#!/usr/bin/env python3
"""
Re-seed feedback templates from feedback/templates_export.json into Airtable.

Idempotent: looks up each template by Name. If found, PATCHes Description /
Active / Questions in place. If not found, POSTs a new record.

Use this when the Airtable Feedback Templates table needs to be restored to
the canonical state captured in templates_export.json — e.g. after a bad
edit, accidental delete, or to bootstrap a fresh base.

Usage:
    python3 feedback/seed_templates.py

Prereqs:
    - Python 3.7+ (stdlib only — no pip installs)
    - Airtable PAT with read+write to the feedback templates table
      (it's hardcoded below; same scoped token used elsewhere in this project)
"""
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

# Set AIRTABLE_TOKEN in your environment before running:
#   AIRTABLE_TOKEN=pat... python3 seed_templates.py
TOKEN = os.environ.get("AIRTABLE_TOKEN", "")
if not TOKEN:
    sys.exit("AIRTABLE_TOKEN env var is required (never hardcode the PAT).")
BASE  = "appTpp1agJQqoId07"
TBL   = "tblFuma2qufToaLV2"

EXPORT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates_export.json")


def airtable_request(method, path, body=None):
    url = f"https://api.airtable.com/v0/{BASE}/{TBL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Airtable {method} {path} -> {e.code}: {body_text}") from e


def list_templates_by_name():
    """Returns {name: record_id} for every existing template in Airtable."""
    out = {}
    offset = None
    while True:
        path = "?fields%5B%5D=Name"
        if offset:
            path += "&offset=" + urllib.parse.quote(offset)
        d = airtable_request("GET", path)
        for r in d.get("records", []):
            n = r["fields"].get("Name")
            if n:
                out[n] = r["id"]
        offset = d.get("offset")
        if not offset:
            return out


def main():
    if not os.path.exists(EXPORT_PATH):
        print(f"  X  {EXPORT_PATH} not found - nothing to seed.", file=sys.stderr)
        sys.exit(1)
    with open(EXPORT_PATH) as f:
        export = json.load(f)

    templates = export.get("templates", [])
    print(f"Loading {len(templates)} templates from templates_export.json ...")

    existing = list_templates_by_name()
    print(f"Found {len(existing)} templates already in Airtable.")

    for tpl in templates:
        name = tpl["name"]
        fields = {
            "Name":        name,
            "Description": tpl.get("description") or "",
            "Active":      bool(tpl.get("active", False)),
            "Questions":   json.dumps(tpl.get("questions", [])),
        }
        if name in existing:
            rid = existing[name]
            airtable_request("PATCH", f"/{rid}", {"fields": fields})
            print(f"  OK  updated -> {name}  ({rid})")
        else:
            d = airtable_request("POST", "", {"fields": fields})
            print(f"  OK  created -> {name}  ({d['id']})")

    print("Done.")


if __name__ == "__main__":
    main()
