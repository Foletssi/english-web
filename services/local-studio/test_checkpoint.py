import tempfile
import unittest
from pathlib import Path

from checkpoint import atomic_json, canonical_hash, file_sha256, read_valid_json, save_json_checkpoint


class CheckpointTests(unittest.TestCase):
    def test_atomic_checkpoint_round_trip_and_key_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            save_json_checkpoint(path, 'key-one', {'done': True})
            self.assertEqual(read_valid_json(path, 'key-one', lambda value: value), {'done': True})
            self.assertIsNone(read_valid_json(path, 'key-two', lambda value: value))
            self.assertEqual(list(path.parent.glob('*.tmp')), [])

    def test_corrupt_checkpoint_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'state.json'
            path.write_text('{broken', encoding='utf-8')
            self.assertIsNone(read_valid_json(path, 'key', lambda value: value))

    def test_hashes_are_stable(self):
        self.assertEqual(canonical_hash({'a': 1, 'b': 2}), canonical_hash({'b': 2, 'a': 1}))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'sample.bin'
            path.write_bytes(b'eastudy')
            self.assertEqual(len(file_sha256(path)), 64)


if __name__ == '__main__':
    unittest.main()
