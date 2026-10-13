"""Browser reconciliation observes actual effects and fences only unaccepted work."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parents[1]))
import server

class BrowserReceiptTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory()
  self.computer=server.Computer(Path(self.tmp.name)/'workspace',Path(self.tmp.name)/'state')
 def tearDown(self):
  self.computer.close();self.tmp.cleanup()
 def test_missing_request_is_fenced_and_late_delivery_cannot_execute_it(self):
  with patch.object(self.computer,'action') as action:
   self.assertEqual(self.computer.browser_receipt('late-click',fence_missing=True)['state'],'not_executed')
   late=self.computer.execute('late-click',{'type':'click','x':1,'y':1})
   self.assertEqual(late['status'],'interrupted');self.assertIn('fenced',late['error'])
   action.assert_not_called()
 def test_pending_action_is_observable_without_interrupting_or_repeating_it(self):
  started=threading.Event();release=threading.Event();results=[]
  def work(*args):
   started.set();release.wait(3);return {'status':'completed','output':'private-result-canary'}
  with patch.object(self.computer,'action',side_effect=work) as action:
   thread=threading.Thread(target=lambda:results.append(self.computer.execute('active-click',{'type':'click','x':1,'y':1})))
   thread.start();self.assertTrue(started.wait(2))
   try:
    self.assertEqual(self.computer.browser_receipt('active-click',fence_missing=True)['state'],'pending')
    self.assertTrue(thread.is_alive())
   finally:release.set();thread.join(3)
   receipt=self.computer.browser_receipt('active-click',fence_missing=True)
   self.assertEqual(receipt,{'operationId':'active-click','state':'settled','status':'completed'})
   self.assertNotIn('private-result-canary',json.dumps(receipt));self.assertEqual(action.call_count,1)
 def test_invalid_identity_is_rejected_without_journaling(self):
  with self.assertRaises(ValueError):self.computer.browser_receipt('../another-operation',fence_missing=True)
  self.assertIsNone(self.computer.db.execute('SELECT 1 FROM operations').fetchone())
