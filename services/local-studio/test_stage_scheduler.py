import threading
import unittest
from unittest.mock import patch
from contextvars import ContextVar

from stage_scheduler import Stage, active_stage, run_stages, parallel_workers


class StageSchedulerTests(unittest.TestCase):
    def test_low_or_unknown_gpu_memory_falls_back_to_serial(self):
        with patch.dict('os.environ', {'EASTUDY_SERIAL_PIPELINE': '0'}), patch('os.cpu_count', return_value=8), patch('stage_scheduler.subprocess.run') as gpu:
            for memory, expected in [('2048\n', 1), ('8192\n', 3), ('8192\n1024\n', 1), ('unknown', 1)]:
                gpu.return_value.stdout = memory
                self.assertEqual(parallel_workers(), expected)
            gpu.side_effect = OSError('unavailable')
            self.assertEqual(parallel_workers(), 1)

    def test_dependencies_resources_and_context_are_preserved(self):
        context = ContextVar('test_context')
        context.set('original-context')
        barrier = threading.Barrier(2, timeout=3)
        occupied = set()
        lock = threading.Lock()
        def stage(name, resource, synchronize=False):
            def execute(deps):
                with lock:
                    self.assertNotIn(resource, occupied)
                    occupied.add(resource)
                try:
                    self.assertEqual(active_stage.get(), name)
                    self.assertEqual(context.get(), 'original-context')
                    if synchronize:
                        barrier.wait()
                    return name
                finally:
                    with lock:
                        occupied.remove(resource)
            return execute
        result = run_stages([
            Stage('media', (), 'cpu', stage('media', 'cpu', True)),
            Stage('asr', (), 'gpu', stage('asr', 'gpu', True)),
            Stage('voice', ('asr',), 'gpu', stage('voice', 'gpu')),
            Stage('join', ('media', 'voice'), 'io', lambda deps: sorted(deps)),
        ], workers=3)
        self.assertEqual(result['join'], ['media', 'voice'])
        self.assertIsNone(active_stage.get())

    def test_failed_stage_blocks_only_its_dependents(self):
        events, completed = [], []
        def fail(_):
            raise ValueError('ASR failed')
        with self.assertRaisesRegex(ValueError, 'ASR failed'):
            run_stages([
                Stage('asr', (), 'gpu', fail),
                Stage('teaching', ('asr',), 'api', lambda _: self.fail('blocked stage ran')),
                Stage('media', (), 'cpu', lambda _: completed.append('media')),
            ], observe=lambda name, state: events.append((name, state['state'])), workers=2)
        self.assertEqual(completed, ['media'])
        self.assertIn(('teaching', 'BLOCKED'), events)
        self.assertIn(('media', 'DONE'), events)

    def test_cancellation_does_not_start_next_stage(self):
        cancelled = threading.Event()
        with self.assertRaisesRegex(RuntimeError, 'CANCELLED'):
            run_stages([
                Stage('first', (), 'cpu', lambda _: cancelled.set()),
                Stage('next', ('first',), 'gpu', lambda _: self.fail('cancelled stage ran')),
            ], cancelled=cancelled, workers=1)

    def test_observer_failure_does_not_relabel_completed_work_as_failed(self):
        events = []
        def observe(name, state):
            events.append(state['state'])
            if state['state'] == 'DONE':
                raise OSError('status store unavailable')
        with self.assertRaisesRegex(OSError, 'status store unavailable'):
            run_stages([Stage('media', (), 'cpu', lambda _: 'complete')], observe=observe)
        self.assertEqual(events, ['RUNNING', 'DONE'])


if __name__ == '__main__':
    unittest.main()
