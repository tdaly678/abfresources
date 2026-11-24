#!/usr/bin/env python3
"""
Re-seed feedback templates from feedback/templates_export.json into Airtable.

Idempotent: looks up each template by Name. If found, PATCHes Description /
Active / Questions in place. If not found, POSTs a new record.

Use this when the Airtable Feedback Templates table needs to be restored to
the canonical state captured in templates_export.json, e.g. after a bad
edit, accidental delete, to bootstrap a fresh base, or after adding a
question to the export.

Usage:
    python3 feedback/seed_templates.py              # admin PIN via the API proxy
    python3 feedback/seed_templates.py --dry-run    # compare live vs export, write nothing

Auth (pick one):
    - Default: the admin PIN (same one as the site's admin override). It is
      prompted for with getpass, traded for an admin session token at
      POST /api/admin, and every write goes through /api/proxy. No Airtable
      token ever touches this machine. Only templates that carry an
      airtable_id in the export are PATCHed in this mode (no creates).
    - AIRTABLE_TOKEN in the environment: talks to Airtable directly, as
      before. Never hardcode, print, or commit the PAT.

Prereqs: Python 3.7+ (stdlib only, no pip installs).
"""
import getpass
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

TOKEN = os.environ.get("AIRTABLE_TOKEN", "")
BASE  = "appTpp1agJQqoId07"
TBL   = "tblFuma2qufToaLV2"
API   = "https://abf-email-worker.tdaly678.workers.dev/api"
UA    = "abf-seed-templates/1.0"

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


def api_request(path, body, bearer=None):
    """POST JSON to the worker API. The bearer token is never printed."""
    headers = {"Content-Type": "application/json", "User-Agent": UA}
    if bearer:
        headers["Authorization"] = "Bearer " + bearer
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                 method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API {path} -> {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from e


def live_templates():
    """Public bootstrap read: {record_id: fields} for every template."""
    req = urllib.request.Request(API + "/bootstrap", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        d = json.loads(resp.read())
    return {r["id"]: r.get("fields", {}) for r in d.get("feedbackTemplates", [])}


def show_diff(templates):
    """Print live vs export question ids so nothing gets silently clobbered."""
    live = live_templates()
    for tpl in templates:
        rid = tpl.get("airtable_id")
        f = live.get(rid)
        if not f:
            print(f"  ??  {tpl['name']}: no live record {rid}")
            continue
        try:
            lq = json.loads(f.get("Questions") or "[]")
        except ValueError:
            lq = []
        eq = tpl.get("questions", [])
        li, ei = [q.get("id") for q in lq], [q.get("id") for q in eq]
        added = [i for i in ei if i not in li]
        removed = [i for i in li if i not in ei]
        changed = [q["id"] for q in eq if q.get("id") in li and q != lq[li.index(q["id"])]]
        print(f"  {tpl['name']}: live {len(lq)} -> export {len(eq)}"
              f"  added={added} removed={removed} changed={changed}")


def seed_via_proxy(templates):
    pin = getpass.getpass("Admin PIN: ")
    tok = api_request("/admin", {"pin": pin}).get("token")
    if not tok:
        sys.exit("Admin sign-in failed.")
    for tpl in templates:
        rid = tpl.get("airtable_id")
        if not rid:
            print(f"  --  skipped (no airtable_id) -> {tpl['name']}")
            continue
        fields = {
            "Description": tpl.get("description") or "",
            "Active":      bool(tpl.get("active", False)),
            "Questions":   json.dumps(tpl.get("questions", [])),
        }
        api_request("/proxy", {"method": "PATCH", "table": "feedbackTemplates",
                               "recordId": rid, "body": {"fields": fields}}, bearer=tok)
        print(f"  OK  updated -> {tpl['name']}  ({rid})")
    print("Done.")


def main():
    if not os.path.exists(EXPORT_PATH):
        print(f"  X  {EXPORT_PATH} not found - nothing to seed.", file=sys.stderr)
        sys.exit(1)
    with open(EXPORT_PATH) as f:
        export = json.load(f)

    templates = export.get("templates", [])
    print(f"Loading {len(templates)} templates from templates_export.json ...")

    if "--dry-run" in sys.argv[1:]:
        show_diff(templates)
        return
    if not TOKEN:
        show_diff(templates)
        seed_via_proxy(templates)
        return

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
