#!/bin/sh
# No LuCI in this image. A browser that had a LuCI image before keeps LuCI's cached
# index.html (it redirects here); send it back to the UI past the cache (the UI then refreshes
# the cached copy of /).
printf 'Status: 302 Found\r\nCache-Control: no-store\r\nLocation: /?fresh\r\n\r\n'
