"""Own one cooperative private Ross store through actual Hermes process exit.

The pilot's interpreter retains its own native orphan checks, replacing global
same-user coverage with this lifetime boundary. Unmanaged writers ignoring the
lock are outside that guarantee. Shared Hermes files are never changed.
"""
import fcntl
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys

_writer_lock_fd = None  # Deliberately kept open through Python's atexit teardown.


def _hermes_agent_root():
    # The runner invokes <hermes-agent>/venv/bin/python with a synthetic HOME,
    # so derive the install from the interpreter path; env overrides per host.
    if os.environ.get('ROSS_HERMES_AGENT_ROOT'):
        return Path(os.environ['ROSS_HERMES_AGENT_ROOT'])
    interpreter = Path(sys.executable)
    if interpreter.parent.name == 'bin' and interpreter.parent.parent.name == 'venv':
        return interpreter.parent.parent.parent
    return Path.home() / '.hermes/hermes-agent'


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # Unknown ownership is not proof of terminal cleanup.


def own_private_store(binding_path):
    global _writer_lock_fd
    binding = json.loads(Path(binding_path).read_text())
    workspace = Path(binding['privateStateDir']).resolve() / 'ross-runtime'
    home = workspace / 'home/.hermes/profiles/ross-pilot'
    scope = {key: binding[key] for key in ('companyId', 'projectId', 'agentId')}
    if Path(os.environ.get('HERMES_HOME', '')).resolve() != home.resolve():
        raise RuntimeError('private store home mismatch')
    if json.loads((workspace / 'scope.json').read_text()) != scope:
        raise RuntimeError('private store scope mismatch')
    provenance = json.loads((workspace / 'store-provenance.json').read_text())
    if provenance != {'version': 1, 'scope': scope, 'journalMode': 'delete', 'freshStore': True}:
        raise RuntimeError('private store provenance required')
    config = json.loads((home / 'config.yaml').read_text())
    if config.get('database', {}).get('journal_mode') != 'delete':
        raise RuntimeError('private rollback store required')
    # No unlink, migration or replacement of database/sidecars is permitted.
    if any(os.path.lexists(str(home / ('state.db' + suffix))) for suffix in ('-wal', '-shm')):
        raise RuntimeError('private rollback store required')
    database = home / 'state.db'
    if database.exists():
        with database.open('rb') as source:
            header = source.read(100)
        if header and (len(header) < 100 or header[:16] != b'SQLite format 3\x00' or header[18:20] != b'\x01\x01'):
            raise RuntimeError('private rollback store required')
    fd = os.open(home / '.ross-writer.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    os.set_inheritable(fd, False)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError('private store already owned') from None
    owner_path = workspace / 'private-store-owner.json'
    if owner_path.exists():
        previous = json.loads(owner_path.read_text())
        if previous.get('scope') != scope:
            os.close(fd)
            raise RuntimeError('private store owner scope mismatch')
        pid, group = previous.get('pid'), previous.get('group')
        if not isinstance(pid, int) or not isinstance(group, int) or pid <= 0 or group <= 0 or _alive(pid) or _alive(-group):
            os.close(fd)
            raise RuntimeError('previous private store owner must exit')
    owner = {'scope': scope, 'pid': os.getpid(), 'group': os.getpgrp()}
    with owner_path.open('w') as output:
        os.chmod(owner_path, 0o600)
        json.dump(owner, output)
    _writer_lock_fd = fd
    return home


def install_private_orphan_scan():
    if _writer_lock_fd is None:
        raise RuntimeError('private lifetime ownership required')
    # Only this process is an approved SessionDB writer. MCP children only
    # perform scoped AgentDash reads; the parent reads the ledger after exit.
    # Preserve native FD/identity/refusal logic, replacing only the global PID
    # enumerator in this interpreter. No installed file or shared state changes.
    import hermes_state_dbfile as native
    expected = _hermes_agent_root() / 'hermes_state_dbfile.py'
    if Path(native.__file__).resolve() != expected.resolve() or not callable(native._darwin_all_pids):
        raise RuntimeError('reviewed private native guard required')
    native._darwin_all_pids = lambda _lib: [os.getpid()]


def snapshot_resume(home, chat_args):
    """Read the resume watermark only while the actual writer owns the store."""
    if _writer_lock_fd is None:
        raise RuntimeError('private lifetime ownership required')
    if '--resume' not in chat_args:
        return
    if chat_args.count('--resume') != 1 or chat_args.count('--query-file') != 1:
        raise RuntimeError('one private resume and query required')
    session_id = chat_args[chat_args.index('--resume') + 1]
    query = Path(chat_args[chat_args.index('--query-file') + 1]).resolve()
    workspace = home.resolve().parents[3]
    if query.parent != workspace or not query.is_file():
        raise RuntimeError('private resume query required')
    connection = sqlite3.connect((home / 'state.db').as_uri() + '?mode=ro', uri=True)
    try:
        if not connection.execute('SELECT id FROM sessions WHERE id = ?', (session_id,)).fetchone():
            raise RuntimeError('resume requires an existing private scoped session')
        message_id = connection.execute('SELECT COALESCE(MAX(id), 0) FROM messages WHERE session_id = ?', (session_id,)).fetchone()[0]
    finally:
        connection.close()
    fd = os.open(str(query) + '.resume.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump({'resumeId': session_id, 'lastMessageId': message_id}, output)


def main():
    if len(sys.argv) < 4 or sys.argv[2] != '--' or sys.argv[3] != 'chat':
        raise RuntimeError('bounded private chat required')
    home = own_private_store(sys.argv[1])
    installed = _hermes_agent_root()
    sys.path.insert(0, str(installed))
    install_private_orphan_scan()
    snapshot_resume(home, sys.argv[3:])
    sys.argv = [str(installed / 'venv/bin/hermes'), *sys.argv[3:]]
    runpy.run_path(sys.argv[0], run_name='__main__')


if __name__ == '__main__':
    main()
