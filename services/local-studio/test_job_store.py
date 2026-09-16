import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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

    def test_retry_reserves_once_and_preserves_checkpoint_progress(self):
        job = self.store.create({}, 'source.mp4')
        self.store.update(job['id'], status='ERROR', currentStep='enrich', progress=82)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.store.queue_retry(job['id']), range(8)))
        self.assertEqual(sum(result is not None for result in results), 1)
        saved = self.store.get(job['id'])
        self.assertEqual((saved['status'], saved['currentStep'], saved['progress']), ('QUEUED', 'enrich', 82))


if __name__ == '__main__':
    unittest.main()
