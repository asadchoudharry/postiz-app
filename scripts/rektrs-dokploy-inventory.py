#!/usr/bin/env python3
"""Read-only, allowlisted inventory. Never emit compose contents, env or logs."""
import argparse
import datetime
import json
import re
import socket
import subprocess
import sys

PROJECT = "rektrs-private-limited-postiz-gekzbw"
DOMAIN = "social.rektrs.com"
EXPECTED_HOST = "srv1322702"
SAFE_LABELS = (
    "com.docker.compose.project",
    "com.docker.compose.service",
    "org.opencontainers.image.revision",
    "org.opencontainers.image.version",
    "org.opencontainers.image.source",
)


def run_json(arguments):
    try:
        result = subprocess.run(
            ["docker", *arguments], check=True, capture_output=True,
            text=True, timeout=20,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        # Raw stderr can include credentials; emit only a fixed message.
        raise RuntimeError("docker_read_failed") from None


def sanitize_container(data):
    labels = data.get("Config", {}).get("Labels") or {}
    state = data.get("State") or {}
    routes = []
    for key, value in labels.items():
        # Emit a boolean domain match, never arbitrary label values.
        if re.fullmatch(r"traefik\.http\.routers\.[\w-]+\.rule", key):
            if re.search(r"Host\(\s*`" + re.escape(DOMAIN) + r"`\s*\)", str(value)):
                routes.append(DOMAIN)
    return {
        "name": data.get("Name", "").lstrip("/"),
        "image_id": data.get("Image"),
        "image_reference": data.get("Config", {}).get("Image"),
        "state": state.get("Status"),
        "health": (state.get("Health") or {}).get("Status", "not_configured"),
        "restart_count": data.get("RestartCount"),
        "labels": {key: labels[key] for key in SAFE_LABELS if key in labels},
        "domain_match": bool(routes),
        "mounts": [
            {"type": item.get("Type"), "destination": item.get("Destination"),
             "read_write": item.get("RW")}
            for item in data.get("Mounts", [])
        ],
    }


def assess(hostname, containers):
    checks = []
    def check(name, ok):
        checks.append({"check": name, "outcome": "PASS" if ok else "BLOCKED"})
    check("expected_host", hostname.split(".")[0] == EXPECTED_HOST)
    apps = [item for item in containers
            if item["labels"].get("com.docker.compose.service") == "postiz-app"]
    check("single_app", len(apps) == 1)
    check("domain_route", len(apps) == 1 and apps[0]["domain_match"])
    check("services_running", bool(containers) and all(c["state"] == "running" for c in containers))
    check("no_known_unhealthy_services", bool(containers) and not any(c["health"] == "unhealthy" for c in containers))
    check("source_revision", len(apps) == 1 and bool(re.fullmatch(
        r"[0-9a-f]{40}", apps[0]["labels"].get("org.opencontainers.image.revision") or "")))
    return checks


def collect():
    # Ask Docker to emit only fields needed for discovery. Config.Env and full
    # labels never enter this process, even transiently.
    ids = subprocess.run(
        ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT],
        check=True, capture_output=True, text=True, timeout=20,
    ).stdout.split()
    if not ids or any(not re.fullmatch(r"[0-9a-f]{12,64}", item) for item in ids):
        raise RuntimeError("target_project_not_found")
    template = '{"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Image":{{json .Config.Image}},"Labels":{'
    template += ",".join(json.dumps(key) + ':{{json (index .Config.Labels ' + json.dumps(key) + ')}}' for key in SAFE_LABELS)
    template += '}},"State":{"Status":{{json .State.Status}},"Health":'
    template += '{{if .State.Health}}{"Status":{{json .State.Health.Status}}}{{else}}{}{{end}}'
    template += '},"RestartCount":{{json .RestartCount}},"Mounts":['
    template += '{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"Type":{{json $m.Type}},"Destination":{{json $m.Destination}},"RW":{{json $m.RW}}}{{end}}]'
    template += '}'
    containers = []
    for item in ids:
        selected = run_json(["inspect", "--format", template, item])
        route = subprocess.run(
            ["docker", "inspect", "--format", '{{range $k,$v := .Config.Labels}}{{if eq $v "Host(`social.rektrs.com`)"}}{{$k}}{{"\\n"}}{{end}}{{end}}', item],
            check=True, capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        safe = sanitize_container(selected)
        safe["domain_match"] = any(re.fullmatch(r"traefik\.http\.routers\.[\w-]+\.rule", key) for key in route.splitlines())
        containers.append(safe)
    hostname = socket.gethostname()
    checks = assess(hostname, containers)
    return {
        "kind": "rektrs_social_dokploy_inventory", "version": 1,
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "hostname": hostname, "project": PROJECT, "domain": DOMAIN,
        "containers": containers, "checks": checks,
        "overall": "IDENTIFIED" if all(x["outcome"] == "PASS" for x in checks) else "BLOCKED",
        "release_ready": False,
        "note": "Inventory only. Does not prove backups, restore, OAuth, API access, build compatibility or release readiness.",
    }


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        report = collect()
        print(json.dumps(report, indent=2))
        return 0 if report["overall"] == "IDENTIFIED" else 2
    except (RuntimeError, OSError, subprocess.SubprocessError):
        print(json.dumps({"overall": "BLOCKED", "reason": "inventory_unavailable", "release_ready": False}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
