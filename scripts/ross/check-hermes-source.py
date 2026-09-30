"""Offline installed-source probe; never import/start Hermes or read its config/keys.

Only named function ASTs execute, with auth/state and tool-registry dependencies
replaced by traps/fixtures. This proves source selection logic, not live tooling.
"""
import ast
import hashlib
import json
from pathlib import Path
import os
import sys
import types
from typing import List, Optional

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(os.environ.get('ROSS_HERMES_AGENT_ROOT') or Path.home() / '.hermes/hermes-agent')
evidence = []
# Fail closed before compiling any installed function if its reviewed file moves.
# Updating these pins requires reviewing the selected bodies and their imports.
reviewed_hashes = {
    'hermes_cli/auth_zai_kimi.py': '21b0316e6a9df250343782c0ce65cd42c9f75c5b68fceb444145305bb7bfb4d5',
    'toolsets.py': '7d743a132c00417604313c9832286825771c3da79a82a9c6c0308c82d77236fa',
    'model_tools.py': 'c99620c824ab59f341ac7d0e22cde016b0c469d0643e7a5a5a82e0d63176e4b5',
    'hermes_cli/mcp_startup.py': 'b7332c9452fbb18afd5b768d61f69ccfc831938e9c50ba55c06131fabdb3ef88',
}
# Snapshot and validate every file before executing any selected function.
reviewed_sources = {relative: (root / relative).read_bytes() for relative in reviewed_hashes}
for relative, body in reviewed_sources.items():
    assert hashlib.sha256(body).hexdigest() == reviewed_hashes[relative], 'source drift: review before executing probe'


def load_functions(relative, names, namespace):
    path = root / relative
    body = reviewed_sources[relative]
    tree = ast.parse(body, filename=str(path))
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in selected} == set(names), 'installed function changed'
    evidence.append({'path': str(path), 'sha256': hashlib.sha256(body).hexdigest(),
                     'functions': {node.name: node.lineno for node in selected}})
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), 'exec'), namespace)


def forbidden(*args, **kwargs):
    raise AssertionError('offline probe attempted auth/state/provider access')


auth = types.ModuleType('hermes_cli.auth')
for name in ('_auth_store_lock', '_load_auth_store', '_load_provider_state',
             '_save_auth_store', '_store_provider_state', 'detect_zai_endpoint'):
    setattr(auth, name, forbidden)
package = types.ModuleType('hermes_cli')
package.__path__ = []
sys.modules['hermes_cli'] = package
sys.modules['hermes_cli.auth'] = auth
namespace = {}
load_functions('hermes_cli/auth_zai_kimi.py', ['_resolve_zai_base_url'], namespace)
endpoint = 'https://api.z.ai/api/paas/v4'
assert namespace['_resolve_zai_base_url']('synthetic-not-a-key', 'unused', endpoint) == endpoint
assert namespace['_resolve_zai_base_url']('', endpoint, '') == endpoint

# Preserve installed static names; supply a synthetic dynamic MCP alias only.
tree = ast.parse(reviewed_sources['toolsets.py'])
definition = next(node.value for node in tree.body if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'TOOLSETS' for target in node.targets))
assert isinstance(definition, ast.Dict)
static_names = {ast.literal_eval(key) for key in definition.keys}
toolsets = types.ModuleType('toolsets')
toolsets.get_toolset = lambda name: None
toolsets.bundle_non_core_tools = forbidden
sys.modules['toolsets'] = toolsets
namespace = {'List': List, 'Optional': Optional, 'TOOLSETS': dict.fromkeys(static_names),
             '_get_plugin_toolset_names': lambda: [],
             '_get_registry_toolset_aliases': lambda: ['ross_fixture'],
             'os': types.SimpleNamespace(environ={}), '_LEGACY_TOOLSET_MAP': {},
             'resolve_toolset': lambda name: ['mcp_ross_fixture_read'] if name == 'ross_fixture' else [],
             '_is_delegated_child_context': forbidden, '_is_dispatcher_owned_worker': forbidden}
load_functions('toolsets.py', ['validate_toolset'], namespace)
load_functions('model_tools.py', ['_apply_toolset_selection', '_select_tool_names'], namespace)
assert namespace['validate_toolset']('ross_fixture')
assert not namespace['validate_toolset']('mcp')
assert not namespace['validate_toolset']('none')
assert namespace['_select_tool_names'](['ross_fixture'], [], True) == {'mcp_ross_fixture_read'}
assert namespace['_select_tool_names'](['ross_fixture'], ['ross_fixture'], True) == set()

namespace = {'Optional': Optional}
load_functions('hermes_cli/mcp_startup.py', ['set_mcp_server_filter'], namespace)
assert namespace['set_mcp_server_filter']('ross_fixture') == ['ross_fixture']
assert namespace['set_mcp_server_filter']('all') is None
assert namespace['set_mcp_server_filter']('') is None
print(json.dumps({'mode': 'offline-installed-source', 'hermesStarted': False, 'providerCalls': 0,
                  'standardPinBypassesProbesAndState': True, 'fixtureAliasSelectionOnly': True,
                  'literalMcpAndNoneInvalid': True, 'emptyOrAllClearsMcpSpawnFilter': True,
                  'sources': evidence}, indent=2))
