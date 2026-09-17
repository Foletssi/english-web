import hashlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlencode
from unittest.mock import patch

import worker  # Sets up the shared local-studio module path.
from local_source import PART_BYTES, SourceCache, start_intake

KEY = 'videos/12345678-1234-1234-1234-123456789abc/source.mp4'


def etag(data):
    parts = [hashlib.md5(data[i:i+PART_BYTES]).digest() for i in range(0, len(data), PART_BYTES)]
    return hashlib.md5(b''.join(parts)).hexdigest() + '-' + str(len(parts))


class LocalSourceTests(unittest.TestCase):
    def test_multipart_match_restore_independent_copy_and_corruption_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = SourceCache(Path(folder) / 'cache')
            data = b'a' * PART_BYTES + b'last-part'
            cache.save(KEY, len(data), etag(data), io.BytesIO(data))
            target = Path(folder) / 'copy.mp4'
            self.assertTrue(cache.restore(KEY, len(data), etag(data), target))
            self.assertEqual(target.read_bytes(), data)
            source, receipt = cache.paths(KEY)
            source.write_bytes(b'b' * len(data))
            self.assertFalse(cache.restore(KEY, len(data), etag(data), target))
            self.assertEqual(target.read_bytes(), data)
            for invalid in ('null', '[]', '{}', 'broken-json'):
                receipt.write_text(invalid)
                self.assertFalse(cache.restore(KEY, len(data), etag(data), target))

    def test_reject_truncated_wrong_etag_and_unsafe_key(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = SourceCache(folder)
            for key, size, tag, data in [(KEY, 4, etag(b'abcd'), b'ab'),
                    (KEY, 2, etag(b'xy'), b'ab'), ('../source.mp4', 2, etag(b'ab'), b'ab')]:
                with self.assertRaises(ValueError):
                    cache.save(key, size, tag, io.BytesIO(data))
            self.assertEqual(list(Path(folder).glob('*.part')), [])

    def test_cache_hit_uses_only_authorized_head_and_cache_failure_downloads(self):
        for hit, failure in [(True, False), (False, True)]:
            with tempfile.TemporaryDirectory() as folder:
                data = b'source'
                def request(req, **kwargs):
                    result = io.BytesIO(data)
                    result.headers = {'Content-Length': str(len(data)), 'ETag': etag(data)}
                    result.status = 200
                    return result
                with patch('worker.worker_root', return_value=Path(folder)), \
                     patch('worker.SourceCache') as constructor, \
                     patch('worker.urllib.request.urlopen', side_effect=request) as urlopen:
                    if failure:
                        constructor.side_effect = PermissionError('disk unavailable')
                    else:
                        constructor.return_value.restore.return_value = hit
                    worker.download('https://example.test/source', Path(folder) / 'source.mp4', source_key=KEY)
                    self.assertEqual(urlopen.call_count, 1 if hit else 2)
                    self.assertEqual(urlopen.call_args_list[0].args[0].method, 'HEAD')

    def test_loopback_origin_nonce_single_use_and_complete_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = SourceCache(folder)
            server = start_intake(cache, 0)
            origin = 'https://english-web-lce.pages.dev'
            def request(method, path, data=None, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    connection.request(method, path, body=data, headers=headers or {})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()
            try:
                self.assertEqual(request('GET', '/capability', headers={'Origin': 'https://other.test'})[0], 403)
                status, info = request('GET', '/capability', headers={'Origin': origin})
                self.assertEqual(status, 200)
                data = b'real local video bytes'
                path = '/source?' + urlencode({'key': KEY, 'size': len(data), 'etag': etag(data)})
                headers = {'Origin': origin, 'X-Eastudy-Intake': info['token']}
                self.assertEqual(request('PUT', path, data, headers)[0], 200)
                self.assertEqual(request('PUT', path, data, headers)[0], 403)
                self.assertTrue(cache.restore(KEY, len(data), etag(data), Path(folder) / 'restored'))
            finally:
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
