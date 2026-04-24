import urllib.request
import re

html = urllib.request.urlopen('https://freeimage.host/i/B6dpcqg').read().decode('utf-8')
match = re.search(r'property="og:image" content="([^"]+)"', html)
if match:
    print(match.group(1))
else:
    print("Not found")
