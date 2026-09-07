#!/usr/bin/env python3
"""Synchronisiert Interaction Model + Manifest eines Alexa-Skills per SMAPI.

Nutzung (lokal, keine GitHub-Secrets noetig):
  1. ask-cli einmal konfigurieren:  ask configure   (oder ~/.ask/ von einem
     bestehenden Rechner uebernehmen)
  2. alexa/skill.local.json anlegen (Vorlage: alexa/skill.local.json.example)
  3. Ausfuehren:  python3 alexa/scripts/sync_skill.py [--model-only|--manifest-only] [--force]

Die Dateien alexa/skill-package/{skill.json,interactionModels/custom/de-DE.json}
im Repo sind die Quelle der Wahrheit; das Skript laedt sie per SMAPI in den
development-Stage des Skills.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

REPO = Path(__file__).resolve().parents[2]
ASK_DIR = Path.home() / ".ask"
LOCAL_CFG = REPO / "alexa" / "skill.local.json"
SKILL_JSON = REPO / "alexa" / "skill-package" / "skill.json"
MODEL_JSON = REPO / "alexa" / "skill-package" / "interactionModels" / "custom" / "de-DE.json"

MODEL_MARKER = "zum thema {query}"  # NEED_SYNC-Marker wie im CI-Workflow


def read_ask_files():
    auth = {}
    for line in (ASK_DIR / "auth_info").read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            auth[k.strip()] = base64.b64decode(v.strip()).decode()
    cli = json.loads((ASK_DIR / "cli_config").read_text())
    refresh = cli["profiles"]["default"]["token"]["refresh_token"]
    return auth, refresh


def lwa_token(auth, refresh):
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": auth["ask_client_id"],
        "client_secret": auth["ask_client_confirmation"],
        "refresh_token": refresh,
    }).encode()
    req = urllib.request.Request(
        auth["ask_lwa_api"].rstrip("/") + "/auth/O2/token", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["access_token"]


def smapi(auth, access, skill_id, path, method="GET", body=None, etag=None) -> tuple[int, Optional[str], Any]:
    url = auth["ask_smapi_api"].rstrip("/") + "/v1/skills/{}/{}".format(skill_id, path)
    headers = {"Authorization": "Bearer " + access}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if etag:
        headers["If-Match"] = etag
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read()
            return r.status, r.headers.get("ETag"), (json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, e.headers.get("ETag"), json.loads(payload)
        except Exception:
            return e.code, None, payload.decode(errors="replace")


def poll_status(auth, access, skill_id, resource, minutes=3):
    deadline = time.monotonic() + minutes * 60
    while time.monotonic() < deadline:
        code, _, body = smapi(auth, access, skill_id, "status?resource=" + resource)
        try:
            state = next(iter(body[resource].values()))["lastUpdateRequest"]["status"]
        except Exception:
            state = "?"
        print("  Build-Status {}: {}".format(resource, state))
        if state in ("SUCCEEDED", "FAILURE"):
            if state == "FAILURE":
                print(json.dumps(body, ensure_ascii=False)[:2000])
            return state
        time.sleep(10)
    return "TIMEOUT"


def sync_model(auth, access, skill_id, force):
    path = "stages/development/interactionModel/locales/de-DE"
    code, etag, body = smapi(auth, access, skill_id, path)
    if code == 200:
        try:
            samples = next(i["samples"] for i in
                           body["interactionModel"]["languageModel"]["intents"]
                           if i["name"] == "GptQueryIntent")
            if not force and any(MODEL_MARKER in s for s in samples):
                print("Modell: Stage bereits aktuell (Marker gefunden), kein PUT.")
                return True
        except Exception:
            pass
    local = json.loads(MODEL_JSON.read_text())
    code, _, body = smapi(auth, access, skill_id, path, "PUT",
                          json.dumps(local, ensure_ascii=False).encode(), etag)
    print("Modell-PUT -> HTTP {}".format(code))
    if code not in (200, 202):
        print(json.dumps(body, ensure_ascii=False)[:1000] if body else body)
        return False
    return poll_status(auth, access, skill_id, "interactionModel") == "SUCCEEDED"


def sync_manifest(auth, access, skill_id, endpoint, force):
    path = "stages/development/manifest"
    code, etag, body = smapi(auth, access, skill_id, path)
    if code == 200 and not force:
        try:
            if body.get("manifest", {}).get("apis", {}).get("custom", {}) \
                   .get("endpoint", {}).get("uri") == endpoint:
                print("Manifest: Endpoint bereits korrekt, kein PUT.")
                return True
        except Exception:
            pass
    manifest = json.loads(SKILL_JSON.read_text())
    raw = json.dumps(manifest, ensure_ascii=False).replace("__ALEXA_ENDPOINT__", endpoint)
    if "__ALEXA_ENDPOINT__" in raw:
        print("FEHLER: __ALEXA_ENDPOINT__ nicht ersetzt - endpoint_url in skill.local.json setzen.")
        return False
    code, _, body = smapi(auth, access, skill_id, path, "PUT", raw.encode(), etag)
    print("Manifest-PUT -> HTTP {}".format(code))
    if code not in (200, 202):
        print(json.dumps(body, ensure_ascii=False)[:1000] if body else body)
        return False
    return poll_status(auth, access, skill_id, "manifest") == "SUCCEEDED"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-only", action="store_true")
    ap.add_argument("--manifest-only", action="store_true")
    ap.add_argument("--force", action="store_true", help="PUT auch ohne erkannte Aenderung")
    args = ap.parse_args()

    if not LOCAL_CFG.exists():
        sys.exit("Fehlt: {} (Vorlage: skill.local.json.example)".format(LOCAL_CFG))
    cfg = json.loads(LOCAL_CFG.read_text())
    skill_id, endpoint = cfg["skill_id"], cfg["endpoint_url"]

    auth, refresh = read_ask_files()
    access = lwa_token(auth, refresh)
    print("SMAPI-Token geholt ({}).".format(auth["ask_smapi_api"]))

    ok = True
    if not args.manifest_only:
        ok &= sync_model(auth, access, skill_id, args.force)
    if not args.model_only:
        ok &= sync_manifest(auth, access, skill_id, endpoint, args.force)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
