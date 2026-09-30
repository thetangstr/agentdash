"""Read a terminal private Ross ledger under its existing cooperative lock.

No Hermes imports, owner-marker replacement, provider access or database writes.
Unmanaged same-user writers ignoring the lock remain outside this guarantee.
"""
import fcntl
from contextlib import closing
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import uuid


def private(path, directory=False):
    info = path.lstat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise RuntimeError('owner-private ledger required')
    return info


def metadata(path):
    if private(path).st_size > 65536:
        raise RuntimeError('bounded ledger metadata required')
    return json.loads(path.read_text())


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def inspect(binding_path, session_id, start, end):
    if not re.fullmatch(r'[-\w]{1,100}', session_id) or not math.isfinite(start) or not math.isfinite(end) or start > end:
        raise RuntimeError('explicit bounded session interval required')
    binding = metadata(Path(binding_path))
    scope = {key: binding[key] for key in ('companyId', 'projectId', 'agentId')}
    for value in scope.values():
        if str(uuid.UUID(value)) != value.lower():
            raise RuntimeError('explicit ledger scope UUID required')
    state = Path(binding['privateStateDir']).resolve()
    workspace = state / 'ross-runtime'
    home = workspace / 'home/.hermes/profiles/ross-pilot'
    for path in (state, workspace, home):
        private(path, True)
    if metadata(workspace / 'scope.json') != scope or metadata(workspace / 'store-provenance.json') != {'version': 1, 'scope': scope, 'journalMode': 'delete', 'freshStore': True}:
        raise RuntimeError('private ledger scope/provenance mismatch')
    if metadata(home / 'config.yaml').get('database', {}).get('journal_mode') != 'delete':
        raise RuntimeError('private rollback ledger required')
    lock = home / '.ross-writer.lock'
    private(lock)
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('private ledger lock already owned') from None
        owner = metadata(workspace / 'private-store-owner.json')
        if owner.get('scope') != scope:
            raise RuntimeError('private ledger owner scope mismatch')
        pid, group = owner.get('pid'), owner.get('group')
        if type(pid) is not int or type(group) is not int or pid <= 0 or group <= 0 or alive(pid) or alive(-group):
            raise RuntimeError('private ledger owner must be terminal')
        database = home / 'state.db'
        private(database)
        if any(os.path.lexists(str(database) + suffix) for suffix in ('-wal', '-shm', '-journal')):
            raise RuntimeError('clean terminal rollback ledger required')
        with database.open('rb') as source:
            header = source.read(100)
        if len(header) != 100 or header[:16] != b'SQLite format 3\x00' or header[18:20] != b'\x01\x01':
            raise RuntimeError('private rollback ledger required')
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            session = connection.execute('SELECT model FROM sessions WHERE id=?', (session_id,)).fetchone()
            if not session or session['model'] != 'glm-5.3-flash':
                raise RuntimeError('exact existing GLM session required')
            connection.execute('BEGIN')
            # octet_length(column) reads stored byte lengths before any message
            # bodies are materialized; keep preflight/fetch in one read snapshot.
            limits = connection.execute('SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(octet_length(content),0) + COALESCE(octet_length(tool_calls),0)),0) AS bytes FROM messages WHERE session_id=? AND timestamp>=? AND timestamp<=?', (session_id, start, end)).fetchone()
            if limits['n'] > 1000 or limits['bytes'] > 4_194_304:
                raise RuntimeError('bounded private ledger read required')
            rows = connection.execute('SELECT id,session_id,role,content,tool_name,tool_call_id,tool_calls,timestamp FROM messages WHERE session_id=? AND timestamp>=? AND timestamp<=? ORDER BY id LIMIT 1001', (session_id, start, end)).fetchall()
            messages = [dict(row) for row in rows]
            if len(messages) > 1000 or sum(len(row.get('content') or '') + len(row.get('tool_calls') or '') for row in messages) > 4_194_304:
                raise RuntimeError('bounded private ledger read required')
        return {'schemaVersion': 1, 'scope': scope, 'sessionId': session_id, 'lockHeldDuringRead': True, 'ownerTerminal': True, 'messages': messages}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise RuntimeError('binding, session and interval required')
        result = inspect(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
        print(json.dumps(result))
    except Exception:
        # Never expose record content or credential-bearing binding JSON.
        print('Ross private ledger inspection refused; check scope, terminal owner, lock and rollback store.', file=sys.stderr)
        sys.exit(1)
