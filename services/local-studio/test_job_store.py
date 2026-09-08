import tempfile
import unittest
from pathlib import Path
from job_store import JobStore


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = JobStore(Path(self.temp.name) / 'jobs')

    def tearDown(self):
        self.temp.cleanup()

    def test_create_update_and_list(self):
        created = self.store.create({'title': 'Morning'}, 'morning.mp4')
        self.assertNotIn('apiKey', created['metadata'])
        updated = self.store.update(created['id'], status='PROCESSING', progress=40)
        self.assertEqual(updated['status'], 'PROCESSING')
        self.assertEqual(self.store.get(created['id'])['progress'], 40)
        self.assertEqual(self.store.list()[0]['id'], created['id'])

    def test_rejects_path_traversal(self):
        with self.assertRaises(KeyError):
            self.store.get('../secret')


if __name__ == '__main__':
    unittest.main()
