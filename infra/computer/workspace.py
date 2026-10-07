"""Bounded, read-only workspace inspection. No user supplied shell commands."""
from __future__ import annotations
import difflib
import mimetypes
import os
import re
from pathlib import Path, PurePosixPath
import selectors
import stat
import subprocess
import time

MAX_TEXT = 256 * 1024
MAX_DOWNLOAD = 32 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_SCAN = 6000
MAX_PROJECTS = 64
EXCLUDED = {'.git', 'node_modules', '.cache', '__pycache__', '.venv', 'vendor', 'dist', 'build'}
IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon'}
LANGUAGES = {'.py':'python','.js':'javascript','.jsx':'jsx','.ts':'typescript','.tsx':'tsx','.json':'json','.md':'markdown','.css':'css','.html':'html','.xml':'xml','.svg':'xml','.yml':'yaml','.yaml':'yaml','.toml':'toml','.sh':'bash','.sql':'sql','.go':'go','.rs':'rust','.java':'java','.c':'c','.h':'c','.cpp':'cpp','.rb':'ruby','.php':'php','.swift':'swift','.kt':'kotlin','.vue':'vue','.svelte':'svelte','.diff':'diff','.patch':'diff','.txt':'text'}

class WorkspaceInspector:
    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()

    def path(self, relative: str = '.') -> Path:
        if not isinstance(relative, str) or len(relative) > 4096 or '\x00' in relative:
            raise ValueError('Invalid workspace path')
        pure = PurePosixPath(relative)
        if pure.is_absolute() or '..' in pure.parts:
            raise ValueError('Path must remain inside the workspace')
        # Do not follow symlinks, even internal ones. A bot may replace them while
        # this read-only view is open; a link is shown as a link, not traversed.
        current = self.workspace
        for part in pure.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('Symbolic links cannot be opened in the workspace viewer')
        if not current.resolve().is_relative_to(self.workspace):
            raise ValueError('Path must remain inside the workspace')
        return current

    def relative(self, path: Path) -> str:
        return path.relative_to(self.workspace).as_posix()

    def tree(self, path='.'):
        directory = self.path(path)
        if not directory.is_dir():
            raise ValueError('Path is not a directory')
        entries = []
        truncated = False
        with os.scandir(directory) as scan:
            for item in scan:
                if len(entries) >= MAX_ENTRIES:
                    truncated = True
                    break
                info = item.stat(follow_symlinks=False)
                kind = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file'
                entries.append({'name':item.name, 'path':self.relative(Path(item.path)), 'kind':kind, 'size':info.st_size, 'modifiedAt':info.st_mtime * 1000, 'accessible':kind != 'symlink' and (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))})
        entries.sort(key=lambda e:(e['kind'] != 'directory', e['name'].casefold()))
        return {'path':self.relative(directory), 'entries':entries, 'truncated':truncated}

    def file(self, path):
        target = self.path(path)
        info = target.stat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Only regular files can be opened')
        mime = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        with target.open('rb') as stream:
            data = stream.read(MAX_TEXT + 1)
        truncated = len(data) > MAX_TEXT
        data = data[:MAX_TEXT]
        result = {'path':self.relative(target), 'name':target.name, 'size':info.st_size, 'mimeType':mime, 'kind':'binary', 'truncated':truncated, 'downloadable':info.st_size <= MAX_DOWNLOAD}
        if mime in IMAGE_TYPES:
            result['kind'] = 'image'
            return result
        try:
            # A partial final UTF-8 sequence is allowed only at the preview limit.
            content = data.decode('utf-8', errors='strict')
        except UnicodeDecodeError as exc:
            if truncated and exc.end == len(data) and exc.reason == 'unexpected end of data':
                content = data[:exc.start].decode('utf-8')
            else:
                return result
        if '\x00' in content or any(ord(char) < 9 or 13 < ord(char) < 32 for char in content[:8192]):
            return result
        result.update(kind='text', content=content, language='dockerfile' if target.name.lower() == 'dockerfile' else LANGUAGES.get(target.suffix.lower(), 'text'))
        return result

    def download(self, path):
        target = self.path(path)
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_DOWNLOAD:
            raise ValueError('Downloads support regular files up to 32 MiB')
        return target, mimetypes.guess_type(target.name)[0] or 'application/octet-stream'

    def repository(self, project):
        root = self.path(project)
        dotgit = root / '.git'
        if dotgit.is_symlink():
            raise ValueError('Symbolic Git directories are not supported')
        if dotgit.is_file():
            text = dotgit.read_text()[:4096]
            if not text.startswith('gitdir: '):
                raise ValueError('Invalid Git directory')
            gitdir = (root / text[8:].strip()).resolve()
        else:
            gitdir = dotgit.resolve()
        if not gitdir.is_relative_to(self.workspace) or not gitdir.is_dir():
            raise ValueError('Git metadata must remain inside the workspace')
        self.path(self.relative(gitdir))
        common = gitdir / 'commondir'
        if common.is_symlink():
            raise ValueError('Symbolic Git metadata is not supported')
        if common.exists():
            destination = (gitdir / common.read_text()[:4096].strip()).resolve()
            if not destination.is_relative_to(self.workspace):
                raise ValueError('Shared Git metadata must remain inside the workspace')
            self.path(self.relative(destination))
        # Disable alternate object stores escaping the workspace.
        for metadata in (gitdir, (gitdir / common.read_text().strip()).resolve() if common.exists() else gitdir):
            for name in ('config', 'config.worktree', 'HEAD', 'index', 'objects', 'objects/info', 'refs', 'info'):
                candidate = metadata / name
                if candidate.is_symlink():
                    raise ValueError('Symbolic Git metadata is not supported')
            if (metadata / 'config.worktree').exists():
                raise ValueError('Custom Git worktree configuration is not supported')
            if (metadata / 'objects/info/alternates').exists():
                raise ValueError('Alternate Git object stores are not supported')
        return root, gitdir

    def git(self, project, *args, limit=MAX_TEXT, allow_missing=False):
        root, gitdir = self.repository(project)
        env = {'PATH':os.environ.get('PATH','/usr/bin:/bin'), 'HOME':'/nonexistent', 'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':'/dev/null', 'GIT_OPTIONAL_LOCKS':'0', 'GIT_TERMINAL_PROMPT':'0', 'GIT_PAGER':'cat', 'LC_ALL':'C'}
        command = ['git', '--no-pager', '--git-dir='+str(gitdir), '--work-tree='+str(root), '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.quotePath=false', *args]
        # Even read-only status/diff can invoke repository clean/process filters.
        # Inspect keys without expanding includes before allowing any operation.
        metadata = [gitdir]
        if (gitdir / 'commondir').exists():
            metadata.append((gitdir / (gitdir / 'commondir').read_text().strip()).resolve())
        safe_keys = re.compile(r'(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.[A-Za-z0-9_-]+\.(?:url|fetch|pushurl)|branch\..+\.(?:remote|merge)|user\.(?:name|email))', re.IGNORECASE)
        for directory in metadata:
            config = directory / 'config'
            if not config.exists():
                continue
            raw, oversized = self._run(root, ['git', 'config', '--file', str(config), '--no-includes', '--name-only', '--list'], env, 65536)
            if oversized or any(not safe_keys.fullmatch(key) for key in raw.decode('utf-8', 'replace').splitlines()):
                raise ValueError('Repository has unsupported Git configuration; custom includes, helpers, filters and hooks cannot run in the read-only viewer')
        return self._run(root, command, env, limit, allow_missing=allow_missing)

    def _run(self, root, command, env, limit, allow_missing=False):
        process = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        result = bytearray()
        started = time.monotonic()
        truncated = False
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while selector.get_map():
                if time.monotonic() - started > 8:
                    raise ValueError('Git inspection timed out; narrow the selected project')
                for key, _ in selector.select(.1):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    room = limit - len(result)
                    result.extend(chunk[:max(room, 0)])
                    if len(chunk) > room:
                        truncated = True
                        process.kill()
                        return bytes(result), truncated
            code = process.wait(timeout=1)
            if code not in (0, 1) and not (allow_missing and code == 128):
                raise ValueError('Git could not inspect this project')
            return bytes(result), truncated
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()

    def changes(self, project='.'):
        raw, truncated = self.git(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all')
        records = raw.split(b'\0')
        changes = []
        i = 0
        while i < len(records):
            record = records[i]
            i += 1
            if len(record) < 4 or (truncated and i == len(records)):
                continue
            state = record[:2].decode('ascii', 'replace')
            item = {'path':record[3:].decode('utf-8','replace'), 'indexStatus':state[0], 'worktreeStatus':state[1], 'staged':state[0] not in ' ?!', 'unstaged':state[1] not in ' ?!', 'untracked':state == '??'}
            if state[0] in 'RC' or state[1] in 'RC':
                if i < len(records):
                    item['previousPath'] = records[i].decode('utf-8','replace')
                    i += 1
            changes.append(item)
            if len(changes) >= MAX_ENTRIES:
                truncated = True
                break
        return {'project':project, 'changes':changes, 'truncated':truncated}

    def projects(self):
        projects = []
        stack = [self.workspace]
        scanned = 0
        truncated = False
        while stack:
            directory = stack.pop()
            if (directory / '.git').exists():
                project = self.relative(directory)
                try:
                    changes = self.changes(project)
                    branch, _ = self.git(project, 'symbolic-ref', '--quiet', '--short', 'HEAD', limit=4096)
                    head, _ = self.git(project, 'rev-parse', '--verify', 'HEAD', limit=4096, allow_missing=True)
                    projects.append({'path':project, 'name':directory.name, 'branch':branch.decode().strip() or None, 'head':head.decode().strip() or None, 'detached':not bool(branch.strip()), 'dirty':bool(changes['changes']), 'staged':sum(c['staged'] for c in changes['changes']), 'unstaged':sum(c['unstaged'] for c in changes['changes']), 'untracked':sum(c['untracked'] for c in changes['changes']), 'truncated':changes['truncated']})
                except (ValueError, OSError, subprocess.SubprocessError):
                    projects.append({'path':project, 'name':directory.name, 'error':'Git metadata could not be read safely'})
                if len(projects) >= MAX_PROJECTS:
                    truncated = bool(stack)
                    break
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        scanned += 1
                        if scanned >= MAX_SCAN:
                            return {'projects':projects, 'truncated':True}
                        if entry.name not in EXCLUDED and entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
            except OSError:
                continue
        return {'projects':sorted(projects,key=lambda p:p['path']), 'truncated':truncated}

    def diff(self, project, path, mode='unstaged'):
        if mode not in ('staged', 'unstaged'):
            raise ValueError('Diff mode must be staged or unstaged')
        root, _ = self.repository(project)
        pure = PurePosixPath(path)
        if not isinstance(path, str) or '\x00' in path or pure.is_absolute() or '..' in pure.parts or path.startswith(':'):
            raise ValueError('Invalid project file path')
        # Deleted files are allowed, but symlinks and workspace escapes are not.
        relative = self.relative(root / path)
        self.path(relative)
        args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all', '--unified=3']
        if mode == 'staged':
            args.append('--cached')
        raw, truncated = self.git(project, *args, '--', path)
        diff = raw.decode('utf-8','replace')
        binary = 'Binary files ' in diff or 'GIT binary patch' in diff
        if not diff and mode == 'unstaged' and (root / path).is_file():
            tracked, _ = self.git(project, 'ls-files', '-z', '--', path)
            if not tracked:
                preview = self.file(relative)
                binary = preview['kind'] != 'text'
                if binary:
                    diff = 'Binary file (untracked)\n'
                else:
                    lines = preview['content'].splitlines(keepends=True)
                    diff = ''.join(difflib.unified_diff([], lines, fromfile='/dev/null', tofile='b/'+path))
                    truncated = preview['truncated'] or len(diff.encode()) > MAX_TEXT
                    diff = diff.encode()[:MAX_TEXT].decode('utf-8','replace')
        return {'project':project, 'path':path, 'mode':mode, 'diff':diff, 'truncated':truncated, 'binary':binary}
