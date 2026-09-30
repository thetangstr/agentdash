import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
import uuid
from unittest import mock


SCRIPT = Path(__file__).with_name("private-state-backup.py")
UUIDS = {
    "companyId": "11111111-1111-4111-8111-111111111111",
    "projectId": "22222222-2222-4222-8222-222222222222",
    "agentId": "33333333-3333-4333-8333-333333333333",
    "issueId": "44444444-4444-4444-8444-444444444444",
    "issueId2": "66666666-6666-4666-8666-666666666666",
    "leadId": "55555555-5555-4555-8555-555555555555",
}


def load_module():
    spec = importlib.util.spec_from_file_location("ross_private_state_backup", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    current = path
    while True:
        try:
            current.chmod(0o700)
        except FileNotFoundError:
            pass
        if current == current.parent or current.name.startswith("ross-private-backup-"):
            break
        current = current.parent


def make_sqlite(path, statements):
    connection = sqlite3.connect(path)
    try:
        connection.executescript("PRAGMA journal_mode=DELETE; " + statements)
        connection.commit()
    finally:
        connection.close()
    path.chmod(0o600)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def scalar(path, sql):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchone()[0]
    finally:
        connection.close()


def read_archive(archive):
    with tarfile.open(archive, "r:gz") as tar:
        return [(member.name, tar.extractfile(member).read()) for member in tar.getmembers()]


def write_archive(path, entries):
    with tarfile.open(path, "w:gz") as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(data))
    path.chmod(0o600)


def archive_with(archive, target, transform):
    entries = transform(read_archive(archive))
    write_archive(target, entries)
    return target


class BackupFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ross-private-backup-")).resolve()
        self.tmp.chmod(0o700)
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.scope = {key: UUIDS[key] for key in ("companyId", "projectId", "agentId")}
        self.binding = self.tmp / "binding.json"
        self.workspace = self.tmp / "ross-runtime"
        self.home = self.workspace / "home/.hermes/profiles/ross-pilot"
        private_dir(self.workspace)
        private_dir(self.workspace / "home")
        private_dir(self.workspace / "home/.hermes")
        private_dir(self.workspace / "home/.hermes/profiles")
        private_dir(self.home)
        write_json(self.binding, {"apiUrl": "http://127.0.0.1:3100/api", **self.scope, "privateStateDir": str(self.tmp)})
        write_json(self.workspace / "scope.json", self.scope)
        write_json(self.workspace / "store-provenance.json", {"version": 1, "scope": self.scope, "journalMode": "delete", "freshStore": True})
        write_json(self.workspace / "private-store-owner.json", {"scope": self.scope, "pid": 99999999, "group": 99999999})
        write_json(self.home / "config.yaml", {"database": {"journal_mode": "delete"}})
        (self.home / ".ross-writer.lock").write_text("", encoding="utf-8")
        (self.home / ".ross-writer.lock").chmod(0o600)
        make_sqlite(
            self.home / "state.db",
            "CREATE TABLE sessions(id TEXT PRIMARY KEY, model TEXT);"
            "CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);"
            "INSERT INTO sessions VALUES('s1','glm-5.3-flash');"
            "INSERT INTO messages(session_id,content) VALUES('s1','private message sentinel');",
        )
        self.projection_bindings = {}
        self.projection_paths = {}
        self.add_projection(UUIDS["issueId"])
        self.add_projection(UUIDS["issueId2"])

    def add_projection(self, issue_id):
        projection_binding = {
            "apiUrl": "http://127.0.0.1:3100/api",
            "companyId": UUIDS["companyId"],
            "projectId": UUIDS["projectId"],
            "issueId": issue_id,
            "agentId": UUIDS["agentId"],
            "leadId": UUIDS["leadId"],
        }
        projection = self.workspace / "commitments" / UUIDS["companyId"] / UUIDS["projectId"] / issue_id / "projection.sqlite"
        private_dir(projection.parent)
        write_json(projection.with_suffix(projection.suffix + ".ross-scope.json"), {"schemaVersion": 1, "binding": projection_binding})
        make_sqlite(
            projection,
            "CREATE TABLE ross_meta(id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL);"
            "CREATE TABLE ross_batches(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL);"
        )
        connection = sqlite3.connect(projection)
        try:
            connection.execute("INSERT INTO ross_meta(id,binding) VALUES(1, ?)", (json.dumps(projection_binding, sort_keys=True, separators=(",", ":")),))
            connection.commit()
        finally:
            connection.close()
        self.projection_bindings[issue_id] = projection_binding
        self.projection_paths[issue_id] = projection

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-I", "-B", str(SCRIPT), *map(str, args)], cwd=self.tmp, text=True, capture_output=True, timeout=5)

    def backup(self):
        archive = self.tmp / "backup.rossbackup"
        result = self.run_cli("backup", self.binding, archive)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["stores"], 3)
        self.assertEqual(receipt["projectionCount"], 2)
        self.assertNotIn("sentinel", result.stdout)
        return archive


class PrivateStateBackupTests(BackupFixture):
    def test_roundtrip_backup_restore_preserves_state_and_nested_projection_hashes(self):
        archive = self.backup()
        restored = self.tmp / "restored"
        result = self.run_cli("restore", archive, restored)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["stores"], 3)
        self.assertEqual((restored.stat().st_mode & 0o777), 0o700)
        self.assertEqual(scalar(restored / "state.db", "SELECT model FROM sessions WHERE id='s1'"), "glm-5.3-flash")
        self.assertEqual(scalar(restored / "state.db", "SELECT content FROM messages WHERE session_id='s1'"), "private message sentinel")
        for issue_id, binding in self.projection_bindings.items():
            copied_projection = restored / "commitments" / issue_id / "projection.sqlite"
            copied_marker = restored / "commitments" / issue_id / "projection.sqlite.ross-scope.json"
            self.assertEqual(json.loads(scalar(copied_projection, "SELECT binding FROM ross_meta WHERE id=1")), binding)
            self.assertEqual(json.loads(copied_marker.read_text(encoding="utf-8"))["binding"], binding)
        self.assertEqual(((restored / "commitments").stat().st_mode & 0o777), 0o700)
        for issue_id in self.projection_bindings:
            self.assertEqual(((restored / "commitments" / issue_id).stat().st_mode & 0o777), 0o700)
        manifest = json.loads((restored / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["scope"], self.scope)
        self.assertEqual(manifest["projectionCount"], 2)
        self.assertIn("owner-private", manifest["sensitivity"])
        self.assertEqual(manifest["provenance"]["consistency"], "sequential-stores-not-atomic")
        self.assertNotIn("privateStateDir", json.dumps(manifest))
        self.assertNotIn("private message sentinel", json.dumps(manifest))

    def test_writer_lock_is_held_during_snapshot_reads(self):
        module = load_module()
        original = module.sqlite_backup
        lock_path = self.home / ".ross-writer.lock"
        lock_attempts = []

        def asserting_backup(src, dst):
            fd = os.open(lock_path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lock_attempts.append(True)
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except BlockingIOError:
                    lock_attempts.append(False)
            finally:
                os.close(fd)
            return original(src, dst)

        with mock.patch.object(module, "sqlite_backup", asserting_backup):
            receipt = module.backup(self.binding, self.tmp / "held-during-snapshot.rossbackup")
        self.assertEqual(receipt["stores"], 3)
        self.assertEqual(lock_attempts, [False, False, False])

    def test_refuses_nonprivate_symlink_sidecar_lock_wrong_scope_and_bad_owner(self):
        self.binding.chmod(0o644)
        result = self.run_cli("backup", self.binding, self.tmp / "bad.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.binding.chmod(0o600)

        state_link = self.tmp.parent / f"{self.tmp.name}-link"
        os.symlink(self.tmp, state_link)
        self.addCleanup(lambda: state_link.exists() and state_link.unlink())
        write_json(self.binding, {"apiUrl": "http://127.0.0.1:3100/api", **self.scope, "privateStateDir": str(state_link)})
        result = self.run_cli("backup", self.binding, self.tmp / "state-link.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        write_json(self.binding, {"apiUrl": "http://127.0.0.1:3100/api", **self.scope, "privateStateDir": str(self.tmp)})

        project_root = self.workspace / "commitments" / UUIDS["companyId"] / UUIDS["projectId"]
        os.symlink(self.home / "state.db", project_root / "77777777-7777-4777-8777-777777777777")
        result = self.run_cli("backup", self.binding, self.tmp / "symlink.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        (project_root / "77777777-7777-4777-8777-777777777777").unlink()

        (self.home / "state.db-wal").write_text("orphan", encoding="utf-8")
        result = self.run_cli("backup", self.binding, self.tmp / "wal.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        (self.home / "state.db-wal").unlink()

        lock_file = open(self.home / ".ross-writer.lock", "r")
        self.addCleanup(lock_file.close)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = self.run_cli("backup", self.binding, self.tmp / "locked.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

        write_json(self.workspace / "scope.json", {**self.scope, "agentId": self.scope["companyId"]})
        result = self.run_cli("backup", self.binding, self.tmp / "foreign.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        write_json(self.workspace / "scope.json", self.scope)

        for owner in ({"scope": self.scope, "pid": True, "group": 99999999}, {"scope": self.scope, "pid": 99999999, "group": -1}):
            write_json(self.workspace / "private-store-owner.json", owner)
            result = self.run_cli("backup", self.binding, self.tmp / f"owner-{len(str(owner))}.rossbackup")
            self.assertNotEqual(result.returncode, 0)

    def test_refuses_more_than_ten_selected_project_entries(self):
        for _ in range(9):
            self.add_projection(str(uuid.uuid4()))
        result = self.run_cli("backup", self.binding, self.tmp / "too-many-projections.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_sqlite_busy_refuses_without_stalling(self):
        connection = sqlite3.connect(self.home / "state.db", timeout=0.1, isolation_level=None)
        self.addCleanup(connection.close)
        connection.execute("BEGIN EXCLUSIVE")
        result = self.run_cli("backup", self.binding, self.tmp / "busy.rossbackup")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_restore_refuses_tamper_existing_destination_and_symlink_archive(self):
        archive = self.backup()
        existing = self.tmp / "existing"
        private_dir(existing)
        result = self.run_cli("restore", archive, existing)
        self.assertNotEqual(result.returncode, 0)

        link = self.tmp / "archive-link.rossbackup"
        os.symlink(archive, link)
        result = self.run_cli("restore", link, self.tmp / "from-link")
        self.assertNotEqual(result.returncode, 0)

        tampered = archive_with(
            archive,
            self.tmp / "tampered.rossbackup",
            lambda entries: [(name, (data[:-1] + bytes([data[-1] ^ 1])) if name == "state.db" else data) for name, data in entries],
        )
        result = self.run_cli("restore", tampered, self.tmp / "tampered-restore")
        self.assertNotEqual(result.returncode, 0)

    def test_restore_refuses_forged_missing_duplicate_traversal_unknown_and_member_count(self):
        archive = self.backup()
        entries = read_archive(archive)
        manifest = json.loads(dict(entries)["manifest.json"].decode("utf-8"))

        missing_state = archive_with(archive, self.tmp / "missing-state.rossbackup", lambda items: [(n, d) for n, d in items if n != "state.db"])
        self.assertNotEqual(self.run_cli("restore", missing_state, self.tmp / "missing-state").returncode, 0)

        duplicate_state = archive_with(archive, self.tmp / "duplicate.rossbackup", lambda items: items + [("state.db", dict(items)["state.db"])])
        self.assertNotEqual(self.run_cli("restore", duplicate_state, self.tmp / "duplicate").returncode, 0)

        traversal = archive_with(archive, self.tmp / "traversal.rossbackup", lambda items: items + [("../escape", b"x")])
        self.assertNotEqual(self.run_cli("restore", traversal, self.tmp / "traversal").returncode, 0)

        unknown = archive_with(archive, self.tmp / "unknown.rossbackup", lambda items: items + [("surprise.txt", b"x")])
        self.assertNotEqual(self.run_cli("restore", unknown, self.tmp / "unknown").returncode, 0)

        extra_entries = [(f"extras/{i}.txt", b"x") for i in range(25)]
        too_many = archive_with(archive, self.tmp / "too-many.rossbackup", lambda items: items + extra_entries)
        self.assertNotEqual(self.run_cli("restore", too_many, self.tmp / "too-many").returncode, 0)

        foreign_manifest = json.loads(json.dumps(manifest))
        issue_id = UUIDS["issueId"]
        marker_name = f"commitments/{issue_id}/projection.sqlite.ross-scope.json"
        forged_marker = json.loads(dict(entries)[marker_name].decode("utf-8"))
        forged_marker["binding"]["companyId"] = UUIDS["projectId"]
        forged_marker_data = json.dumps(forged_marker, sort_keys=True, separators=(",", ":")).encode("utf-8")
        for record in foreign_manifest["files"]:
            if record["path"] == marker_name:
                record["sha256"] = sha256_bytes(forged_marker_data)
                record["bytes"] = len(forged_marker_data)
        foreign_entries = []
        for name, data in entries:
            if name == "manifest.json":
                foreign_entries.append((name, json.dumps(foreign_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")))
            elif name == marker_name:
                foreign_entries.append((name, forged_marker_data))
            else:
                foreign_entries.append((name, data))
        foreign = self.tmp / "foreign-marker.rossbackup"
        write_archive(foreign, foreign_entries)
        self.assertNotEqual(self.run_cli("restore", foreign, self.tmp / "foreign-marker").returncode, 0)


if __name__ == "__main__":
    unittest.main()
