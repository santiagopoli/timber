import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('workspace_inspector', Path(__file__).parents[1] / 'workspace.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'workspace'
        self.root.mkdir()
        self.inspector = module.WorkspaceInspector(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def git(self, path, *args):
        return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.DEVNULL).decode().strip()

    def repo(self, name):
        path = self.root / name
        path.mkdir()
        self.git(path, 'init', '-b', 'main')
        self.git(path, 'config', 'user.email', 'test@example.invalid')
        self.git(path, 'config', 'user.name', 'Test')
        (path / 'code.py').write_text('print("original")\n')
        self.git(path, 'add', '.')
        self.git(path, 'commit', '-m', 'initial')
        return path

    def test_files_types_and_tree(self):
        (self.root / 'source.ts').write_text('const x: string = "hello";\n')
        (self.root / 'asset.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        (self.root / 'data.bin').write_bytes(b'\x00\xff')
        (self.root / 'evil.html').write_text('<script>alert(1)</script>')
        (self.root / 'vector.svg').write_text('<svg onload="alert(1)"></svg>')
        (self.root / 'folder').mkdir()
        self.assertEqual(self.inspector.tree()['entries'][0]['name'], 'folder')
        self.assertEqual(self.inspector.file('source.ts')['language'], 'typescript')
        self.assertEqual(self.inspector.file('source.ts')['kind'], 'text')
        self.assertEqual(self.inspector.file('asset.png')['kind'], 'image')
        self.assertEqual(self.inspector.file('data.bin')['kind'], 'binary')
        self.assertEqual(self.inspector.file('evil.html')['kind'], 'text')
        self.assertEqual(self.inspector.file('vector.svg')['kind'], 'text')
        self.assertEqual(self.inspector.download('data.bin')[0], self.root/'data.bin')

    def test_path_escapes_links_and_special_files(self):
        (self.root / 'outside').symlink_to('/etc/passwd')
        (self.root / 'linkdir').symlink_to('/etc')
        (self.root / 'local.txt').write_text('safe')
        (self.root / 'inside').symlink_to(self.root / 'local.txt')
        for path in ('../anything', '/etc/passwd', 'outside', 'linkdir/passwd', 'inside', 'null\x00'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.inspector.file(path)
        links = [e for e in self.inspector.tree()['entries'] if e['kind']=='symlink']
        self.assertEqual(len(links),3)
        self.assertTrue(all(not e['accessible'] for e in links))
        with self.assertRaises(ValueError): self.inspector.download('.')

    def test_large_preview_and_download_bounds(self):
        (self.root / 'large.txt').write_text('é'*(module.MAX_TEXT//2+20))
        result = self.inspector.file('large.txt')
        self.assertEqual(result['kind'],'text')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['content'].encode()),module.MAX_TEXT)
        with (self.root/'huge.bin').open('wb') as stream: stream.truncate(module.MAX_DOWNLOAD+1)
        self.assertFalse(self.inspector.file('huge.bin')['downloadable'])
        with self.assertRaises(ValueError): self.inspector.download('huge.bin')

    def test_multiple_projects_branches_and_detached(self):
        first = self.repo('frontend')
        second = self.repo('backend')
        self.git(first,'switch','-c','feature/ui')
        (first/'new.ts').write_text('export {}')
        self.git(second,'checkout','--detach')
        projects = {p['name']:p for p in self.inspector.projects()['projects']}
        self.assertEqual(projects['frontend']['branch'],'feature/ui')
        self.assertTrue(projects['frontend']['dirty'])
        self.assertEqual(projects['frontend']['untracked'],1)
        self.assertTrue(projects['backend']['detached'])
        self.assertFalse(projects['backend']['dirty'])

    def test_staged_unstaged_untracked_and_deleted_diff(self):
        repo = self.repo('repo')
        (repo/'code.py').write_text('print("staged")\n')
        self.git(repo,'add','code.py')
        (repo/'code.py').write_text('print("working")\n')
        (repo/'untracked.txt').write_text('new file\n')
        changes = {c['path']:c for c in self.inspector.changes('repo')['changes']}
        self.assertTrue(changes['code.py']['staged'])
        self.assertTrue(changes['code.py']['unstaged'])
        self.assertTrue(changes['untracked.txt']['untracked'])
        self.assertIn('+print("staged")',self.inspector.diff('repo','code.py','staged')['diff'])
        self.assertIn('+print("working")',self.inspector.diff('repo','code.py')['diff'])
        self.assertIn('+new file',self.inspector.diff('repo','untracked.txt')['diff'])
        (repo/'code.py').unlink()
        self.assertIn('-print("staged")',self.inspector.diff('repo','code.py')['diff'])

    def test_binary_diff_and_filename_shell_characters(self):
        repo=self.repo('repo')
        name='file;$(touch injected).txt'
        (repo/name).write_text('literal name\n')
        (repo/'binary.bin').write_bytes(b'\x00\xff')
        self.assertIn('+literal name',self.inspector.diff('repo',name)['diff'])
        self.assertTrue(self.inspector.diff('repo','binary.bin')['binary'])
        self.assertFalse((repo/'injected').exists())
        for path in ('../outside', '/etc/passwd', ':!code.py'):
            with self.assertRaises(ValueError): self.inspector.diff('repo',path)

    def test_git_external_programs_are_disabled(self):
        repo=self.repo('repo')
        marker=self.root/'executed'
        self.git(repo,'config','diff.external',f'touch {marker}')
        self.git(repo,'config','core.fsmonitor',f'touch {marker}')
        self.git(repo,'config','diff.evil.textconv',f'touch {marker}')
        (repo/'.gitattributes').write_text('*.py diff=evil\n')
        (repo/'code.py').write_text('change\n')
        self.inspector.changes('repo')
        self.inspector.diff('repo','code.py')
        self.assertFalse(marker.exists())

    def test_git_metadata_outside_is_rejected(self):
        repo=self.repo('repo')
        evil=self.root/'evil'
        evil.mkdir()
        (evil/'.git').write_text('gitdir: /tmp/outside\n')
        with self.assertRaises(ValueError):self.inspector.changes('evil')
        (repo/'.git/commondir').write_text('/tmp/outside')
        with self.assertRaises(ValueError):self.inspector.changes('repo')

    def test_scan_ignores_dependencies(self):
        dependency=self.root/'node_modules'
        dependency.mkdir()
        hidden=dependency/'package'
        hidden.mkdir()
        self.git(hidden,'init')
        self.assertEqual(self.inspector.projects()['projects'],[])

if __name__ == '__main__': unittest.main()
