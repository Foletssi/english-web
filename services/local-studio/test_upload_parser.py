import io
import tempfile
import unittest
from pathlib import Path

from contracts import StudioError
from upload_parser import parse_multipart


class UploadParserTests(unittest.TestCase):
    def test_reads_fields_and_binary_file(self):
        boundary = 'fixture-boundary'
        binary = b'abc\x00\xff\r\nnot-a-boundary'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'
                '{"title":"Test"}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\n'
                'Content-Type: video/mp4\r\n\r\n').encode() + binary + f'\r\n--{boundary}--\r\n'.encode()
        with tempfile.TemporaryDirectory() as temp:
            fields, files = parse_multipart(io.BytesIO(body),
                f'multipart/form-data; boundary={boundary}', len(body), temp)
            self.assertEqual(fields['metadata'], '{"title":"Test"}')
            self.assertEqual(Path(files['video']['path']).read_bytes(), binary)

    def test_requires_boundary(self):
        with self.assertRaisesRegex(StudioError, 'UPLOAD_CONTENT_TYPE'):
            parse_multipart(io.BytesIO(b'x'), 'text/plain', 1)


if __name__ == '__main__':
    unittest.main()
