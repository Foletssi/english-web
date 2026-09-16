"""Check that each measured inline space has a continuous semantic-color underline."""
import json
import math
import sys
from PIL import Image

image = Image.open(sys.argv[1]).convert('RGB')
for gap in json.loads(sys.argv[2]):
    left = math.ceil(gap['x'])
    right = math.floor(gap['x'] + gap['width'])
    bottom = round(gap['y'] + gap['height'])
    if right < left:
        continue
    rows = range(max(0, bottom - 4), min(image.height, bottom + 4))
    def matches(x, y):
        return max(abs(a-b) for a, b in zip(image.getpixel((x, y)), gap['color'])) < 45
    assert any(all(matches(x, y) for x in range(left, right + 1)) for y in rows), (
        'Underline is missing across a phrase space', gap)
print('Continuous phrase-space pixels verified')
