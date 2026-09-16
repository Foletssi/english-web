import json
import tempfile
import threading
import unittest
import urllib.request

from server import build_server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.submitted = []
        self.server = build_server(self.temp.name, 0, self.submitted.append)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def test_health_and_job_upload(self):
        health = json.load(urllib.request.urlopen(self.base + '/health'))
        self.assertTrue(health['ok'])
        boundary = 'eastudy-test'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'
                '{}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="Morning Vlog.mp4"\r\n'
                'Content-Type: video/mp4\r\n\r\nvideo-bytes\r\n'
                f'--{boundary}--\r\n').encode()
        request = urllib.request.Request(self.base + '/jobs', data=body, method='POST',
                                         headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        with urllib.request.urlopen(request) as response:
            job = json.load(response)
            self.assertEqual(response.status, 202)
        self.assertEqual(job['metadata']['title'], 'Morning Vlog')
        self.assertNotIn('sourcePath', job)
        self.assertEqual(self.submitted, [job['id']])

    def test_retry_submission_failure_can_be_retried_again(self):
        job = self.server.store.create({}, 'source.mp4')
        self.server.store.update(job['id'], status='ERROR', currentStep='enrich', progress=82)
        def unavailable(_):
            raise RuntimeError('executor unavailable')
        self.server.submitter = unavailable
        def request():
            return urllib.request.urlopen(urllib.request.Request(
                self.base + '/jobs/' + job['id'] + '/retry', data=b'{}', method='POST'))
        with self.assertRaises(urllib.error.HTTPError):
            request()
        self.assertEqual(self.server.store.get(job['id'])['status'], 'ERROR')
        self.server.submitter = self.submitted.append
        with request() as response:
            saved = json.load(response)
        self.assertEqual(self.submitted, [job['id']])
        self.assertEqual((saved['currentStep'], saved['progress']), ('enrich', 82))


if __name__ == '__main__':
    unittest.main()
