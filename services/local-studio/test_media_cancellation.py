import subprocess
import sys
import threading
import unittest
from unittest.mock import patch
from contracts import StudioError
from media_cancellation import cancellation_scope, check_cancelled
import media_tools


class MediaCancellationTests(unittest.TestCase):
    def test_cancel_terminates_child_and_resets_context(self):
        event = threading.Event()
        processes = []
        real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            event.set()
            return process
        with patch.object(media_tools, 'require_tools'), patch.object(media_tools.subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(StudioError) as result, cancellation_scope(event):
                media_tools.run([sys.executable, '-c', 'import time; time.sleep(30)'])
        self.assertEqual(result.exception.code, 'JOB_LEASE_LOST_OR_CANCELLED')
        self.assertIsNotNone(processes[0].poll())
        check_cancelled()
        with cancellation_scope(threading.Event()):
            check_cancelled()
