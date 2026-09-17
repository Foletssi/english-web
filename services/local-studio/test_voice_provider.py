import unittest
from unittest.mock import MagicMock
from voice_provider import FallbackEngine


class ProviderTests(unittest.TestCase):
    def test_cuda_initialization_failure_uses_cpu(self):
        engine = MagicMock()
        calls = []
        def build(cuda):
            calls.append(cuda)
            if cuda:
                raise RuntimeError('driver unavailable')
            return engine, 'CPUExecutionProvider'
        fallback = FallbackEngine(build, True)
        self.assertEqual(calls, [True, False])
        self.assertTrue(fallback.fallback)
        fallback.create('word')
        engine.create.assert_called_once_with('word')

    def test_cuda_runtime_failure_switches_once_cpu_failure_propagates(self):
        cuda, cpu = MagicMock(), MagicMock()
        cuda.create.side_effect = RuntimeError('CUDA memory')
        cpu.create.side_effect = RuntimeError('CPU error')
        build = MagicMock(side_effect=[(cuda, 'CUDAExecutionProvider'), (cpu, 'CPUExecutionProvider')])
        fallback = FallbackEngine(build, True)
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, 'CPU error'):
                fallback.create('word')
        self.assertEqual(build.call_count, 2)


if __name__ == '__main__':
    unittest.main()
