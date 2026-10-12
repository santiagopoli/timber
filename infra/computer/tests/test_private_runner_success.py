"""Real Linux private-runner fixture; synthetic values, no Cloudflare request.

A test-only copy substitutes an immutable fake CLI for the production-pinned
Wrangler. Production has no argument or environment switch for this seam.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).parents[1]

@unittest.skipUnless(os.geteuid() == 0 and shutil.which('setpriv'), 'requires Linux root to create separate test UIDs')
class PrivateRunnerSuccessTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix='timber-runner-fixture-'))
        os.chmod(self.folder, 0o755)
        self.status = self.folder / 'status'
        self.status.mkdir(mode=0o733)
        os.chmod(self.status, 0o733)
        self.marker = self.status / 'pid'
        self.cli = self.folder / 'fixture-cli'
        self.cli.write_text('''#!/usr/bin/python3
import json,os,resource,sys,time
from pathlib import Path
assert os.geteuid()==10002
assert 'BOTSPACE_COMPUTER_TOKEN' not in os.environ
assert 'NODE_OPTIONS' not in os.environ
assert os.environ['WRANGLER_LOG_PATH']=='/opt/timber-secure/wrangler.log'
assert os.environ['WRANGLER_SEND_METRICS']=='false'
assert os.environ['WRANGLER_SEND_ERROR_REPORTS']=='false'
assert os.environ['HOME']==os.getcwd()
assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)
assert sys.argv[1]=='deploy' and '--no-bundle' in sys.argv
config=json.loads(Path(sys.argv[sys.argv.index('--config')+1]).read_text())
assert config['name']=='fixture-worker'
assert 'build' not in config and 'vars' not in config
assert os.stat(os.getcwd()).st_mode & 0o777 == 0o700
values=[v for k,v in os.environ.items() if k in ('CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL')]
assert values
print(json.dumps(values),flush=True)
print(json.dumps(values),file=sys.stderr,flush=True)
Path(MARKER).write_text(str(os.getpid()))
time.sleep(2)
'''.replace('MARKER', repr(str(self.marker))))
        os.chmod(self.cli, 0o755)
        self.runner = self.folder / 'runner.py'
        source = (ROOT / 'secure_deploy_runner.py').read_text()
        self.assertIn('WRANGLER = "/usr/local/bin/wrangler"', source)
        self.runner.write_text(source.replace('WRANGLER = "/usr/local/bin/wrangler"', 'WRANGLER = ' + repr(str(self.cli))))
        os.chmod(self.runner, 0o644)
        self.process = None
        self.cli_pid = None

    def tearDown(self):
        if self.process:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait()
            for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
                if stream is not None and not stream.closed: stream.close()
        if self.cli_pid:
            try:
                os.kill(self.cli_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        shutil.rmtree(self.folder)

    def request(self, legacy=False):
        js = 'export default {fetch(){return new Response("fixture")}}'
        digest = 'sha256:' + hashlib.sha256(js.encode()).hexdigest()
        pin = {'repository':'fixture/repository','commit':'a'*40,'artifactDigest':digest,
               'artifactPath':'dist/worker.js','accountId':'a'*32,'workerName':'fixture-worker',
               'destination':'https://api.cloudflare.com/client/v4/accounts/'+'a'*32+'/workers/scripts/fixture-worker',
               }
        signed_pin = {**pin,'planId':'00000000-0000-4000-8000-000000000001','planRevision':1}
        values = ['synthetic-runner-key-not-real','synthetic-email@example.invalid'] if legacy else ['synthetic-runner-bearer-not-real']
        creds = [{'refId':'00000000-0000-4000-8000-'+str(i+10).zfill(12),'revision':1,'header':(['X-Auth-Key','X-Auth-Email'][i] if legacy else 'Authorization'),
                  'prefix':('' if legacy else 'Bearer '),'value':value} for i,value in enumerate(values)]
        auth = {'version':1,'ownerId':'owner','botId':'00000000-0000-4000-8000-000000000002',
                'runId':'00000000-0000-4000-8000-000000000003','nativeOperationId':'fixture-native-operation',
                'operationId':'fixture-operation','pin':signed_pin,'planId':signed_pin['planId'],'planRevision':1,
                'expiresAt':int(time.time()*1000)+45000,'signature':'fixture-signed-envelope-only-32bytes',
                'refs':[{'id':c['refId'],'revision':1,'permissionEpoch':'fixture-epoch','binding':'fixture-binding'} for c in creds]}
        return {'protocolVersion':1,'operationId':'fixture-operation','authorization':auth,'pin':pin,
                'artifact':{'sha256':digest,'javascript':js},'credentials':creds}, values

    def launch(self, legacy=False):
        payload, values = self.request(legacy)
        args = ['/usr/bin/setpriv','--reuid=10002','--regid=10002','--clear-groups',
                '--bounding-set=-all','--inh-caps=-all','--no-new-privs','--',sys.executable,str(self.runner)]
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                        env={'PATH':'/usr/bin:/bin','BOTSPACE_COMPUTER_TOKEN':'synthetic-controller-token',
                                             'NODE_OPTIONS':'synthetic-inherited-options'},start_new_session=True)
        self.process.stdin.write(json.dumps(payload).encode())
        self.process.stdin.close()
        self.process.stdin = None
        for _ in range(200):
            if self.marker.exists():
                self.cli_pid = int(self.marker.read_text())
                break
            if self.process.poll() is not None:
                out,err=self.process.communicate()
                self.fail('private fixture did not start: '+out.decode()+err.decode())
            time.sleep(0.01)
        self.assertIsNotNone(self.cli_pid, 'trusted fixture child starts')
        return values

    def test_success_child_is_hidden_from_independent_workspace_process_and_output_suppressed(self):
        values = self.launch()
        probe = '''import os,sys
for pid in sys.argv[1:]:
 for name in ('environ','mem','fd/0'):
  try:
   fd=os.open('/proc/'+pid+'/'+name,os.O_RDONLY)
  except PermissionError:
   continue
  except FileNotFoundError:
   sys.exit(4)
  else:
   os.close(fd);sys.exit(3)
sys.exit(0)
'''
        result = subprocess.run(['/usr/bin/setpriv','--reuid=10001','--regid=10001','--clear-groups',
                                 '--bounding-set=-all','--inh-caps=-all','--no-new-privs','--',sys.executable,'-c',probe,
                                 str(self.process.pid),str(self.cli_pid)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                env={'PATH':'/usr/bin:/bin'})
        self.assertEqual(result.returncode,0,'workspace sibling cannot open runner/CLI memory, env or private stdin')
        out,err=self.process.communicate()
        self.assertEqual(self.process.returncode,0)
        self.assertEqual(json.loads(out),{'status':'completed','code':'deploy_accepted'})
        self.assertEqual(err,b'')
        for value in values:
            self.assertNotIn(value.encode(),out+err)
            for file in self.status.rglob('*'):
                if file.is_file(): self.assertNotIn(value.encode(),file.read_bytes())
        self.assertFalse(Path('/proc/'+str(self.cli_pid)).exists(),'trusted child reaped after completion')

    def test_legacy_key_and_email_success_uses_correct_private_environment(self):
        values=self.launch(legacy=True)
        out,err=self.process.communicate()
        self.assertEqual(self.process.returncode,0)
        self.assertEqual(json.loads(out),{'status':'completed','code':'deploy_accepted'})
        self.assertEqual(err,b'')
        for value in values: self.assertNotIn(value.encode(),out+err)

    def test_cancel_group_cannot_leave_credential_bearing_cli_running(self):
        self.launch()
        self.assertEqual(os.getpgid(self.cli_pid), self.process.pid, 'CLI cannot escape the controller cancellation group')
        os.killpg(self.process.pid,signal.SIGKILL)
        self.process.wait()
        # A terminated child may briefly remain a zombie pending the system reaper;
        # it must not be a live process retaining credential memory.
        state=Path('/proc/'+str(self.cli_pid)+'/stat')
        for _ in range(50):
            if not state.exists() or state.read_text().split(') ',1)[1].split()[0]=='Z':
                break
            time.sleep(0.01)
        if state.exists():
            self.assertEqual(state.read_text().split(') ',1)[1].split()[0],'Z')
