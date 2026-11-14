import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("inventory", Path(__file__).with_name("rektrs-dokploy-inventory.py"))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def fixture():
    return {
        "Name": "/rektrs-private-limited-postiz-gekzbw-postiz-app-1",
        "Image": "sha256:" + "a" * 64,
        "Config": {"Image": "ghcr.io/gitroomhq/postiz-app:latest", "Env": ["SECRET=do-not-emit"],
                   "Labels": {"com.docker.compose.project": inventory.PROJECT,
                              "com.docker.compose.service": "postiz-app",
                              "org.opencontainers.image.revision": "b" * 40,
                              "traefik.http.routers.postiz.rule": "Host(`social.rektrs.com`)",
                              "private.label": "do-not-emit"}},
        "State": {"Status": "running", "Health": {"Status": "healthy", "Log": ["do-not-emit"]}},
        "Mounts": [{"Type": "volume", "Source": "/private/do-not-emit", "Destination": "/uploads", "RW": True}],
    }


class InventoryTests(unittest.TestCase):
    def test_allowlist_removes_secrets_logs_and_host_mount_paths(self):
        data = fixture()
        result = inventory.sanitize_container(data)
        self.assertNotIn("do-not-emit", json.dumps(result))
        self.assertNotIn("Env", json.dumps(result))
        self.assertTrue(result["domain_match"])
        self.assertEqual(data, fixture())  # no mutation

    def test_similar_domain_does_not_match(self):
        data = fixture()
        data["Config"]["Labels"]["traefik.http.routers.postiz.rule"] = "Host(`social.rektrs.com.evil.test`)"
        self.assertFalse(inventory.sanitize_container(data)["domain_match"])

    def test_verified_inventory_is_not_release_approval(self):
        checks = inventory.assess("srv1322702", [inventory.sanitize_container(fixture())])
        self.assertTrue(all(item["outcome"] == "PASS" for item in checks))

    def test_wrong_host_empty_project_and_duplicate_app_are_blocked(self):
        item = inventory.sanitize_container(fixture())
        for host, containers in [("srv2107420", [item]), ("srv1322702", []), ("srv1322702", [item, item])]:
            with self.subTest(host=host, count=len(containers)):
                self.assertIn("BLOCKED", [c["outcome"] for c in inventory.assess(host, containers)])

    def test_unhealthy_dependency_blocks_inventory(self):
        app = inventory.sanitize_container(fixture())
        dependency = copy.deepcopy(app)
        dependency["labels"]["com.docker.compose.service"] = "temporal"
        dependency["health"] = "unhealthy"
        checks = inventory.assess("srv1322702", [app, dependency])
        self.assertEqual(next(c for c in checks if c["check"] == "no_known_unhealthy_services")["outcome"], "BLOCKED")

    def test_missing_or_malformed_revision_is_blocked(self):
        for revision in [None, "", "latest", "a" * 7]:
            item = inventory.sanitize_container(fixture())
            item["labels"]["org.opencontainers.image.revision"] = revision
            checks = inventory.assess("srv1322702", [item])
            self.assertEqual(checks[-1]["outcome"], "BLOCKED")

    @patch.object(inventory.subprocess, "run")
    def test_collect_invokes_only_docker_reads_and_never_selects_env(self, runner):
        safe_input = fixture()
        safe_input["Config"].pop("Env")
        calls = []
        def fake_run(args, **kwargs):
            calls.append(args)
            if args[1] == "ps":
                return subprocess.CompletedProcess(args, 0, "a" * 12 + "\n", "")
            if args[3].startswith("{{range"):
                return subprocess.CompletedProcess(args, 0, "traefik.http.routers.postiz.rule\n", "")
            return subprocess.CompletedProcess(args, 0, json.dumps(safe_input), "")
        runner.side_effect = fake_run
        with patch.object(inventory.socket, "gethostname", return_value="srv1322702"):
            report = inventory.collect()
        self.assertEqual(report["overall"], "IDENTIFIED")
        self.assertFalse(report["release_ready"])
        self.assertTrue(all(c[1] in ("ps", "inspect") for c in calls))
        self.assertTrue(all("Config.Env" not in " ".join(c) and "json .Config.Labels" not in " ".join(c) for c in calls))
        self.assertNotIn("do-not-emit", json.dumps(report))

    @patch.object(inventory.subprocess, "run", side_effect=OSError("do-not-emit"))
    def test_docker_failure_never_prints_raw_error(self, _):
        with self.assertRaisesRegex(RuntimeError, "^docker_read_failed$"):
            inventory.run_json(["inspect"])


if __name__ == "__main__":
    unittest.main()
