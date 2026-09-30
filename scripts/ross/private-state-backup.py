"""Bounded owner-private Ross state backup/restore.

This snapshots local rollback SQLite stores only. It does not copy credentials,
profiles, prompts, provider config, or rebind any live runtime.
"""
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile
import time
import uuid

MAX_TOTAL = 100 * 1024 * 1024
MAX_EACH = 32 * 1024 * 1024
MAX_SECONDS = 30
MAX_METADATA = 64 * 1024
MAX_PROJECTIONS = 10
MAX_TAR_MEMBERS = 2 + (MAX_PROJECTIONS * 2)
MAX_TAR_BYTES = MAX_TOTAL + ((MAX_TAR_MEMBERS + 2) * 1024)


def refuse(message="Ross private backup refused."):
    print(message, file=sys.stderr)
    sys.exit(1)


def is_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except Exception:
        return False


def private_path(path, directory=False):
    path = Path(path)
    st = path.lstat()
    if st.st_uid != os.getuid() or st.st_mode & 0o077 or (not directory and st.st_size > MAX_EACH):
        raise RuntimeError("owner-private path required")
    if directory:
        if not stat.S_ISDIR(st.st_mode):
            raise RuntimeError("owner-private directory required")
    elif not stat.S_ISREG(st.st_mode):
        raise RuntimeError("owner-private file required")
    return st


def private_directory_chain(paths):
    for path in paths:
        private_path(path, True)


def load_json(path, limit=MAX_METADATA):
    if private_path(path).st_size > limit:
        raise RuntimeError("bounded JSON marker required")
    return json.loads(Path(path).read_text(encoding="utf-8"))


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def validate_positive_int(value):
    if type(value) is not int or value <= 0:
        raise RuntimeError("positive terminal integer required")
    return value


def clean_sqlite(path):
    path = Path(path)
    private_path(path)
    for suffix in ("-wal", "-shm", "-journal"):
        if os.path.lexists(str(path) + suffix):
            raise RuntimeError("rollback sidecar refused")
    with path.open("rb") as source:
        header = source.read(100)
    if len(header) != 100 or header[:16] != b"SQLite format 3\x00" or header[18:20] != b"\x01\x01":
        raise RuntimeError("rollback sqlite required")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.1) as db:
        db.execute("PRAGMA busy_timeout=100")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("sqlite integrity required")


def sqlite_backup(src, dst):
    src = Path(src)
    dst = Path(dst)
    clean_sqlite(src)
    if dst.exists() or dst.is_symlink():
        raise RuntimeError("backup target exists")
    deadline = time.monotonic() + MAX_SECONDS

    def progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            raise RuntimeError("sqlite backup deadline exceeded")

    with sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=0.1) as source, sqlite3.connect(dst, timeout=0.1) as target:
        source.execute("PRAGMA busy_timeout=100")
        target.execute("PRAGMA busy_timeout=100")
        source.backup(target, pages=100, progress=progress)
    dst.chmod(0o600)
    clean_sqlite(dst)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def validate_runtime(binding_path):
    binding = load_json(Path(binding_path))
    scope = {key: binding[key] for key in ("companyId", "projectId", "agentId")}
    if not all(is_uuid(value) for value in scope.values()):
        raise RuntimeError("explicit scope UUID required")
    if not isinstance(binding.get("apiUrl"), str) or not binding["apiUrl"]:
        raise RuntimeError("bounded binding api URL required")

    raw_state = Path(binding["privateStateDir"])
    if not raw_state.is_absolute():
        raise RuntimeError("absolute private state directory required")
    private_path(raw_state, True)
    state = raw_state.resolve()
    if state != raw_state:
        raise RuntimeError("canonical private state directory required")
    workspace = state / "ross-runtime"
    home_root = workspace / "home"
    hermes_root = home_root / ".hermes"
    profiles_root = hermes_root / "profiles"
    home = profiles_root / "ross-pilot"
    private_directory_chain((state, workspace, home_root, hermes_root, profiles_root, home))

    if load_json(workspace / "scope.json") != scope:
        raise RuntimeError("runtime scope mismatch")
    if load_json(workspace / "store-provenance.json") != {"version": 1, "scope": scope, "journalMode": "delete", "freshStore": True}:
        raise RuntimeError("runtime provenance mismatch")
    if load_json(home / "config.yaml").get("database", {}).get("journal_mode") != "delete":
        raise RuntimeError("rollback config required")

    owner = load_json(workspace / "private-store-owner.json")
    pid = validate_positive_int(owner.get("pid"))
    group = validate_positive_int(owner.get("group"))
    if owner.get("scope") != scope or alive(pid) or alive(-group):
        raise RuntimeError("terminal owner required")

    lock = home / ".ross-writer.lock"
    private_path(lock)
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError("writer lock held") from None
    except Exception:
        os.close(fd)
        raise

    state_db = home / "state.db"
    try:
        clean_sqlite(state_db)
    except Exception:
        os.close(fd)
        raise
    return {"binding": binding, "scope": scope, "workspace": workspace, "home": home, "state_db": state_db, "lock_fd": fd}


def validate_projection_marker(marker_data, binding, issue_id):
    expected = {
        "apiUrl": binding["apiUrl"],
        "companyId": binding["companyId"],
        "projectId": binding["projectId"],
        "issueId": issue_id,
        "agentId": binding["agentId"],
    }
    marker_binding = marker_data.get("binding")
    if not isinstance(marker_binding, dict):
        raise RuntimeError("projection marker scope mismatch")
    if marker_data.get("schemaVersion") != 1 or any(marker_binding.get(key) != value for key, value in expected.items()):
        raise RuntimeError("projection marker scope mismatch")
    return marker_binding


def validate_projection_db(path, marker_binding):
    clean_sqlite(path)
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.1) as db:
        row = db.execute("SELECT binding FROM ross_meta WHERE id=1").fetchone()
        if not row or json.loads(row[0]) != marker_binding:
            raise RuntimeError("projection database scope mismatch")


def projection_stores(workspace, binding):
    root = workspace / "commitments"
    if not root.exists():
        return []
    company_root = root / binding["companyId"]
    project_root = company_root / binding["projectId"]
    if not project_root.exists():
        return []
    private_directory_chain((root, company_root, project_root))
    entry_names = []
    with os.scandir(project_root) as entries:
        for entry in entries:
            entry_names.append(entry.name)
            if len(entry_names) > MAX_PROJECTIONS:
                raise RuntimeError("projection directory limit reached")
    stores = []
    for issue_name in sorted(entry_names):
        issue_dir = project_root / issue_name
        private_path(issue_dir, True)
        issue_id = issue_dir.name
        if not is_uuid(issue_id):
            raise RuntimeError("projection issue UUID required")
        path = issue_dir / "projection.sqlite"
        marker = issue_dir / "projection.sqlite.ross-scope.json"
        if not path.exists() and not marker.exists():
            continue
        if len(stores) >= MAX_PROJECTIONS:
            raise RuntimeError("projection limit reached")
        private_path(path)
        marker_data = load_json(marker)
        marker_binding = validate_projection_marker(marker_data, binding, issue_id)
        validate_projection_db(path, marker_binding)
        stores.append({"issueId": issue_id, "path": path, "marker_path": marker, "binding": marker_binding})
    return stores


def enforce_total_bound(paths):
    total = 0
    for path in paths:
        total += private_path(path).st_size
    if total > MAX_TOTAL:
        raise RuntimeError("source total size limit")


def add_file_to_tar(tar, arcname, data):
    info = tarfile.TarInfo(arcname)
    info.mode = 0o600
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def make_archive(manifest, files, destination):
    destination = Path(destination)
    private_path(destination.parent, True)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("archive destination exists")
    payload = canonical(manifest).encode("utf-8")
    total = len(payload)
    for _, path in files:
        total += private_path(path).st_size
    if total > MAX_TOTAL:
        raise RuntimeError("backup total size limit")

    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as fileobj:
            fd = None
            with tarfile.open(fileobj=fileobj, mode="w:gz") as tar:
                add_file_to_tar(tar, "manifest.json", payload)
                for arcname, path in files:
                    if private_path(path).st_size > MAX_EACH:
                        raise RuntimeError("backup file size limit")
                    tar.add(path, arcname=arcname, recursive=False)
    except Exception:
        if fd is not None:
            os.close(fd)
        if destination.exists():
            destination.unlink()
        raise
    destination.chmod(0o600)


def backup(binding_path, destination):
    runtime = validate_runtime(binding_path)
    try:
        projections = projection_stores(runtime["workspace"], runtime["binding"])
        enforce_total_bound([runtime["state_db"], *(item for projection in projections for item in (projection["path"], projection["marker_path"]))])
        with tempfile.TemporaryDirectory(prefix="ross-private-backup-work-") as temp:
            temp = Path(temp)
            state_copy = temp / "state.db"
            sqlite_backup(runtime["state_db"], state_copy)
            files = [("state.db", state_copy)]
            manifest = {
                "schemaVersion": 1,
                "kind": "ross-private-state-backup",
                "scope": runtime["scope"],
                "provenance": {"journalMode": "delete", "consistency": "sequential-stores-not-atomic"},
                "sensitivity": "contains owner-private local model/session context and commitment projections; excludes credential files and live binding configuration",
                "projectionCount": len(projections),
                "files": [{"path": "state.db", "sha256": sha256(state_copy), "bytes": state_copy.stat().st_size}],
            }
            for projection in projections:
                target = temp / f"projection-{projection['issueId']}.sqlite"
                sqlite_backup(projection["path"], target)
                arc = f"commitments/{projection['issueId']}/projection.sqlite"
                marker_arc = f"commitments/{projection['issueId']}/projection.sqlite.ross-scope.json"
                marker_path = temp / f"projection-{projection['issueId']}.json"
                marker = {"schemaVersion": 1, "binding": projection["binding"]}
                marker_path.write_text(canonical(marker), encoding="utf-8")
                marker_path.chmod(0o600)
                files.extend([(arc, target), (marker_arc, marker_path)])
                manifest["files"].append({"path": arc, "sha256": sha256(target), "bytes": target.stat().st_size, "issueId": projection["issueId"]})
                manifest["files"].append({"path": marker_arc, "sha256": sha256(marker_path), "bytes": marker_path.stat().st_size, "issueId": projection["issueId"]})
            make_archive(manifest, files, destination)
        return {"status": "ok", "stores": 1 + len(projections), "projectionCount": len(projections), "consistency": "sequential-stores-not-atomic"}
    finally:
        os.close(runtime["lock_fd"])


def safe_member(member):
    path = Path(member.name)
    if member.name.startswith("/") or ".." in path.parts or not member.isfile() or member.size > MAX_EACH:
        raise RuntimeError("unsafe archive member")
    if member.name == "manifest.json" and member.size > MAX_METADATA:
        raise RuntimeError("bounded manifest required")


def expected_archive_path_set(manifest):
    if set(manifest.keys()) != {"schemaVersion", "kind", "scope", "provenance", "sensitivity", "projectionCount", "files"}:
        raise RuntimeError("backup manifest schema required")
    if manifest["schemaVersion"] != 1 or manifest["kind"] != "ross-private-state-backup":
        raise RuntimeError("backup manifest schema required")
    scope = manifest["scope"]
    if not isinstance(scope, dict) or set(scope.keys()) != {"companyId", "projectId", "agentId"} or not all(is_uuid(scope[key]) for key in scope):
        raise RuntimeError("backup manifest scope required")
    if manifest["provenance"] != {"journalMode": "delete", "consistency": "sequential-stores-not-atomic"}:
        raise RuntimeError("backup manifest provenance required")
    count = manifest["projectionCount"]
    if type(count) is not int or count < 0 or count > MAX_PROJECTIONS:
        raise RuntimeError("backup manifest projection count required")
    files = manifest["files"]
    if not isinstance(files, list) or len(files) != 1 + count * 2:
        raise RuntimeError("backup manifest files required")

    expected_paths = {"manifest.json", "state.db"}
    seen_records = set()
    issues = []
    for record in files:
        if not isinstance(record, dict) or set(record.keys()) - {"path", "sha256", "bytes", "issueId"}:
            raise RuntimeError("backup manifest file schema required")
        if not isinstance(record.get("path"), str) or not isinstance(record.get("sha256"), str) or len(record["sha256"]) != 64:
            raise RuntimeError("backup manifest file schema required")
        if type(record.get("bytes")) is not int or record["bytes"] < 0 or record["bytes"] > MAX_EACH:
            raise RuntimeError("backup manifest file size required")
        path = record["path"]
        if path in seen_records:
            raise RuntimeError("duplicate manifest file")
        seen_records.add(path)
        if path == "state.db":
            if "issueId" in record:
                raise RuntimeError("state record issue refused")
            continue
        issue_id = record.get("issueId")
        if not is_uuid(issue_id):
            raise RuntimeError("projection issue UUID required")
        expected_store = f"commitments/{issue_id}/projection.sqlite"
        expected_marker = f"commitments/{issue_id}/projection.sqlite.ross-scope.json"
        if path not in (expected_store, expected_marker):
            raise RuntimeError("projection archive path required")
        expected_paths.add(path)
        issues.append(issue_id)
    if "state.db" not in seen_records:
        raise RuntimeError("state database required")
    unique_issues = set(issues)
    if len(unique_issues) != count or any(issues.count(issue_id) != 2 for issue_id in unique_issues):
        raise RuntimeError("projection manifest pair required")
    for issue_id in unique_issues:
        if f"commitments/{issue_id}/projection.sqlite" not in seen_records or f"commitments/{issue_id}/projection.sqlite.ross-scope.json" not in seen_records:
            raise RuntimeError("projection manifest pair required")
    return expected_paths, scope, unique_issues


def decompressed_tar_path(archive):
    temp = tempfile.NamedTemporaryFile(prefix="ross-private-restore-tar-", delete=False)
    temp_path = Path(temp.name)
    total = 0
    try:
        temp.close()
        temp_path.chmod(0o600)
        with gzip.open(archive, "rb") as source, temp_path.open("wb") as target:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_TAR_BYTES:
                    raise RuntimeError("archive decompressed size limit")
                target.write(chunk)
        return temp_path
    except Exception:
        if temp_path.exists():
            temp_path.unlink()
        raise


def read_archive_members(archive):
    members = {}
    total = 0
    tar_path = decompressed_tar_path(archive)
    try:
        with tarfile.open(tar_path, "r:") as tar:
            while True:
                member = tar.next()
                if member is None:
                    break
                if len(members) >= MAX_TAR_MEMBERS:
                    raise RuntimeError("archive member count limit")
                safe_member(member)
                if member.name in members:
                    raise RuntimeError("duplicate archive member")
                total += member.size
                if total > MAX_TOTAL:
                    raise RuntimeError("archive total size limit")
                source = tar.extractfile(member)
                if source is None:
                    raise RuntimeError("archive member required")
                data = source.read(member.size + 1)
                if len(data) != member.size:
                    raise RuntimeError("archive member size mismatch")
                members[member.name] = data
        return members
    finally:
        if tar_path.exists():
            tar_path.unlink()


def validate_restored_projection(destination, issue_id, scope):
    marker_path = destination / "commitments" / issue_id / "projection.sqlite.ross-scope.json"
    marker = load_json(marker_path)
    binding = marker.get("binding")
    if not isinstance(binding, dict):
        raise RuntimeError("restored marker scope mismatch")
    if marker.get("schemaVersion") != 1:
        raise RuntimeError("restored marker schema mismatch")
    for key in ("companyId", "projectId", "agentId"):
        if binding.get(key) != scope[key]:
            raise RuntimeError("restored marker scope mismatch")
    if binding.get("issueId") != issue_id or not isinstance(binding.get("apiUrl"), str) or not binding["apiUrl"]:
        raise RuntimeError("restored marker scope mismatch")
    validate_projection_db(destination / "commitments" / issue_id / "projection.sqlite", binding)


def make_restore_parents(destination, relative_path):
    current = destination
    for part in Path(relative_path).parent.parts:
        current = current / part
        current.mkdir(exist_ok=True)
        current.chmod(0o700)


def restore(archive, destination):
    archive = Path(archive)
    if archive.is_symlink():
        raise RuntimeError("archive symlink refused")
    private_path(archive)
    destination = Path(destination)
    private_path(destination.parent, True)
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("fresh restore destination required")

    members = read_archive_members(archive)
    if "manifest.json" not in members:
        raise RuntimeError("backup manifest required")
    manifest = json.loads(members["manifest.json"].decode("utf-8"))
    expected_paths, scope, issue_ids = expected_archive_path_set(manifest)
    if set(members.keys()) != expected_paths:
        raise RuntimeError("unexpected archive member")
    for record in manifest["files"]:
        data = members[record["path"]]
        if sha256_bytes(data) != record["sha256"] or len(data) != record["bytes"]:
            raise RuntimeError("backup manifest hash mismatch")

    destination.mkdir(mode=0o700)
    try:
        for record in manifest["files"]:
            target = destination / record["path"]
            make_restore_parents(destination, record["path"])
            target.write_bytes(members[record["path"]])
            target.chmod(0o600)
        (destination / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
        (destination / "manifest.json").chmod(0o600)
        clean_sqlite(destination / "state.db")
        for issue_id in issue_ids:
            validate_restored_projection(destination, issue_id, scope)
        return {"status": "ok", "stores": 1 + manifest["projectionCount"], "projectionCount": manifest["projectionCount"]}
    except Exception:
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
        raise


def main(argv):
    if len(argv) != 4 or argv[1] not in ("backup", "restore"):
        raise RuntimeError("usage: backup bindingPath destination | restore archive freshDestination")
    if argv[1] == "backup":
        return backup(argv[2], argv[3])
    return restore(argv[2], argv[3])


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv)))
    except Exception:
        refuse()
