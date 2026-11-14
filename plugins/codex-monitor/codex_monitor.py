#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""codex-monitor CLI —— 经 DSH 插件 HTTP API 操作 Codex 会话监控。

红线：本脚本只是 HTTP 客户端，绝不直接读写 Codex SQLite、rollout 或
$DSH_HOME/codex-monitor/running-history.json。

服务地址：默认 http://127.0.0.1:3080（web 生产）；用 --base 或环境变量
CODEX_MONITOR_BASE 覆盖（如试验田 http://127.0.0.1:3090）。

输出契约：成功 = stdout 输出 UTF-8 JSON、退出码 0；
失败 = stderr 输出 JSON 错误、退出码非 0（1 用法/参数，2 连接失败，3 服务端 HTTP 错误）。
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request


DEFAULT_BASE = 'http://127.0.0.1:3080'
DEFAULT_TIMEOUT = 5.0
SESSION_ID_PATTERN = re.compile(r'^(?:(?i:[0-9a-f]{8}-[0-9a-f-]{27})|(?:dsh|kimi|kimi-cli|claude|agy):[a-zA-Z0-9_-]{1,100})$')


for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8')
    except Exception:
        pass


def emit(payload, *, stream=None, quiet=False):
    if not quiet:
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=stream or sys.stdout)


def fail(message, code, *, quiet=False, **extra):
    payload = {'ok': False, 'error': message}
    payload.update(extra)
    emit(payload, stream=sys.stderr, quiet=quiet)
    raise SystemExit(code)


def get_json(base, path, timeout, quiet):
    url = base.rstrip('/') + path
    request = urllib.request.Request(
        url,
        method='GET',
        headers={
            'Accept': 'application/json',
            'Content-Type': 'application/json; charset=utf-8'
        }
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:500]
        fail(f'服务端返回 HTTP {error.code}', 3, quiet=quiet, path=path, detail=detail)
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, 'reason', error)
        fail(f'连接失败：{reason}', 2, quiet=quiet, base=base)
    except (UnicodeError, ValueError):
        fail('服务端返回的内容不是合法 JSON', 3, quiet=quiet, path=path)

    if not isinstance(result, dict):
        fail('服务端返回的 JSON 不是对象', 3, quiet=quiet, path=path)
    return result


def post_json(base, path, payload, timeout, quiet):
    url = base.rstrip('/') + path
    data = json.dumps(payload).encode('utf-8')
    request = urllib.request.Request(
        url,
        data=data,
        method='POST',
        headers={
            'Accept': 'application/json',
            'Content-Type': 'application/json; charset=utf-8'
        }
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', 'replace')[:500]
        fail(f'服务端返回 HTTP {error.code}', 3, quiet=quiet, path=path, detail=detail)
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, 'reason', error)
        fail(f'连接失败：{reason}', 2, quiet=quiet, base=base)
    except (UnicodeError, ValueError):
        fail('服务端返回的内容不是合法 JSON', 3, quiet=quiet, path=path)

    if not isinstance(result, dict):
        fail('服务端返回的 JSON 不是对象', 3, quiet=quiet, path=path)
    return result


def cmd_list(args, base):
    """列出 Codex 会话，支持状态筛选。"""
    result = get_json(base, '/codex-monitor/sessions', args.timeout, args.quiet)
    sessions = result.get('sessions', [])

    def lane(session):
        status = session.get('status')
        if status == 'unknown':
            return 'review' if session.get('reviewable') is True else 'record'
        if status == 'turn_completed':
            return 'review'
        return status

    def keep(session):
        if args.status and lane(session) != args.status:
            return False
        if args.cwd:
            cwd = session.get('cwd', '') or ''
            if args.cwd.lower() not in cwd.lower():
                return False
        if args.keyword:
            keyword = args.keyword.lower()
            title = (session.get('title', '') or '').lower()
            if keyword not in title:
                return False
        return True

    filtered = [s for s in sessions if keep(s)]
    emit({
        'ok': True,
        'count': len(filtered),
        'sessions': filtered,
        'generatedAt': result.get('generatedAt'),
        'refreshing': result.get('refreshing'),
        'window': result.get('window')
    }, quiet=args.quiet)


def cmd_refresh(args, base):
    """触发默认窗口或指定会话刷新。"""
    session_id = (args.session_id or '').strip()
    if session_id and not SESSION_ID_PATTERN.fullmatch(session_id):
        fail('session_id 格式无效', 1, quiet=args.quiet)

    payload = {'sessionId': session_id} if session_id else {}
    result = post_json(base, '/codex-monitor/refresh', payload, args.timeout, args.quiet)
    emit({'ok': True, **result}, quiet=args.quiet)


def main():
    parser = argparse.ArgumentParser(
        prog='codex_monitor',
        description='codex-monitor CLI：经 DSH 插件 HTTP API 操作 Codex 会话监控')
    parser.add_argument(
        '--base',
        default=os.environ.get('CODEX_MONITOR_BASE', DEFAULT_BASE),
        help='DSH 服务地址（默认 %(default)s，可用 CODEX_MONITOR_BASE 覆盖）')
    parser.add_argument(
        '--timeout',
        type=float,
        default=DEFAULT_TIMEOUT,
        help='HTTP 超时秒数（默认 %(default)s）')
    parser.add_argument('--quiet', action='store_true', help=argparse.SUPPRESS)

    subcommands = parser.add_subparsers(dest='command', required=True)

    # list 命令
    list_parser = subcommands.add_parser('list', help='列出 Codex 会话')
    list_parser.add_argument('--status', choices=['running', 'review', 'record'],
                            help='按状态筛选：running（运行中）、review（待审核）、record（记录）')
    list_parser.add_argument('--cwd', help='按工作目录筛选（包含匹配）')
    list_parser.add_argument('--keyword', help='按标题关键词筛选（包含匹配）')

    # refresh 命令
    refresh_parser = subcommands.add_parser('refresh', help='触发默认窗口或指定会话刷新')
    refresh_parser.add_argument('session_id', nargs='?', help='可选 Codex session_id')

    args = parser.parse_args()

    if args.timeout <= 0:
        fail('--timeout 必须大于 0', 1, quiet=args.quiet)

    if args.command == 'list':
        cmd_list(args, args.base)
    elif args.command == 'refresh':
        cmd_refresh(args, args.base)
    else:
        fail(f'未知命令：{args.command}', 1, quiet=args.quiet)


if __name__ == '__main__':
    main()
