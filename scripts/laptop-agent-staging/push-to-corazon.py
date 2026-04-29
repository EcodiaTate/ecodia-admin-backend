#!/usr/bin/env python3
"""Push files to Corazon via the laptop agent's filesystem.writeFile tool.

Usage: push-to-corazon.py <local_path> <remote_path>
"""
import json
import sys
import urllib.request
import os

TOKEN_PATH = os.path.expanduser('~/.ecodiaos/laptop-agent.token')
AGENT_URL = 'http://100.114.219.69:7456/api/tool'


def main():
    if len(sys.argv) != 3:
        print('Usage: push-to-corazon.py <local_path> <remote_path>', file=sys.stderr)
        sys.exit(2)
    local, remote = sys.argv[1], sys.argv[2]

    with open(local, 'r', encoding='utf-8') as f:
        content = f.read()
    with open(TOKEN_PATH, 'r') as f:
        token = f.read().strip()

    body = json.dumps({
        'tool': 'filesystem.writeFile',
        'params': {
            'path': remote,
            'content': content,
            'encoding': 'utf8',
        },
    }).encode('utf-8')

    req = urllib.request.Request(
        AGENT_URL,
        data=body,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    print(json.dumps(result, indent=2))
    if not result.get('ok'):
        sys.exit(1)


if __name__ == '__main__':
    main()
