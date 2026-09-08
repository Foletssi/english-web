import re
import tempfile
from email.parser import BytesParser
from pathlib import Path

from contracts import StudioError


MAX_BODY = 2 * 1024 * 1024 * 1024
MAX_FIELD = 1024 * 1024


def boundary_from(content_type):
    match = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', content_type or '', re.I)
    if not match:
        raise StudioError('UPLOAD_CONTENT_TYPE', '上传请求缺少 multipart boundary。')
    return (match.group(1) or match.group(2)).encode('ascii', 'strict')


def parse_multipart(stream, content_type, content_length, temp_root=None):
    if not 0 < content_length <= MAX_BODY:
        raise StudioError('UPLOAD_SIZE_INVALID', '单次上传必须小于 2 GB。')
    boundary = b'--' + boundary_from(content_type)
    remaining = content_length
    fields, files = {}, {}
    root = Path(temp_root or tempfile.mkdtemp(prefix='eastudy-upload-'))
    root.mkdir(parents=True, exist_ok=True)

    def read_line():
        nonlocal remaining
        if remaining <= 0:
            return b''
        data = stream.readline(min(1024 * 1024, remaining) + 1)
        remaining -= len(data)
        return data

    if read_line().rstrip(b'\r\n') != boundary:
        raise StudioError('UPLOAD_MULTIPART_INVALID', '上传内容不是有效的 multipart 数据。')
    while remaining > 0:
        header_lines = []
        while True:
            line = read_line()
            if not line:
                raise StudioError('UPLOAD_MULTIPART_INVALID', '上传内容提前结束。')
            if line in (b'\r\n', b'\n'):
                break
            if sum(map(len, header_lines)) + len(line) > 32 * 1024:
                raise StudioError('UPLOAD_HEADER_TOO_LARGE', '上传字段头信息过大。')
            header_lines.append(line)
        headers = BytesParser().parsebytes(b''.join(header_lines) + b'\r\n')
        name = headers.get_param('name', header='content-disposition')
        filename = headers.get_filename()
        if not name:
            raise StudioError('UPLOAD_FIELD_INVALID', '上传字段缺少名称。')
        target = None
        chunks = []
        size = 0
        if filename:
            safe_name = Path(filename).name or 'upload.bin'
            target = root / f'{len(files)}-{safe_name}'
            output = target.open('wb')
        else:
            output = None
        previous = None
        try:
            while True:
                line = read_line()
                marker = line.rstrip(b'\r\n')
                if marker in (boundary, boundary + b'--'):
                    if previous is not None:
                        payload = previous[:-2] if previous.endswith(b'\r\n') else previous[:-1] if previous.endswith(b'\n') else previous
                        size += len(payload)
                        (output.write(payload) if output else chunks.append(payload))
                    terminal = marker.endswith(b'--')
                    break
                if not line:
                    raise StudioError('UPLOAD_MULTIPART_INVALID', '上传内容缺少结束边界。')
                if previous is not None:
                    size += len(previous)
                    if not output and size > MAX_FIELD:
                        raise StudioError('UPLOAD_FIELD_TOO_LARGE', '上传文本字段超过 1 MB。')
                    (output.write(previous) if output else chunks.append(previous))
                previous = line
        finally:
            if output:
                output.close()
        if filename:
            files[name] = {'path': str(target), 'filename': Path(filename).name, 'size': size}
        else:
            fields[name] = b''.join(chunks).decode('utf-8')
        if terminal:
            break
    return fields, files
