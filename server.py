#!/usr/bin/env python3
"""VFD analyzer helper.

Serves the app on http://127.0.0.1:8765/ and exposes what the macOS Music app is playing at
/api/nowplaying (read through AppleScript, so no Apple Developer token is needed).

    python3 server.py            # or double-click start.command

The first time, macOS asks whether Terminal (or your shell app) may control "Music": choose Allow.
Only the standard library is used. The server listens on 127.0.0.1 only.
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = '127.0.0.1'
PORT = int(os.environ.get('PORT', '8765'))
CACHE_SECONDS = 1.0

MUSIC_SCRIPT = '''
tell application "Music"
	set volumeText to (sound volume as integer) as text
	set playerStateText to (player state as text)
	if playerStateText is "stopped" then return playerStateText & tab & tab & tab & tab & tab & tab & volumeText
	try
		set theTrack to current track
		return playerStateText & tab & (name of theTrack) & tab & (artist of theTrack) & tab & (album of theTrack) & tab & (player position as integer) & tab & (duration of theTrack as integer) & tab & volumeText
	on error
		return playerStateText & tab & tab & tab & tab & tab & tab & volumeText
	end try
end tell
'''


# Until one query has succeeded, macOS may be showing its "allow control of Music?" dialog: give the user
# time to answer it instead of killing the script (which also dismisses the dialog).
_authorised = False
FIRST_TIMEOUT = 40
NORMAL_TIMEOUT = 4


def query_music():
    """One AppleScript round-trip. Never launches Music: it is only asked if it is already running."""
    global _authorised
    if subprocess.run(['pgrep', '-x', 'Music'], capture_output=True).returncode != 0:
        return {'running': False, 'state': 'stopped'}
    try:
        r = subprocess.run(['osascript', '-e', MUSIC_SCRIPT], capture_output=True, text=True,
                           encoding='utf-8', timeout=NORMAL_TIMEOUT if _authorised else FIRST_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {'running': True, 'state': 'unknown', 'error': 'timeout'}
    if r.returncode != 0:
        err = r.stderr.strip()
        # -1743: the user has not (yet) allowed this app to control Music
        return {'running': True, 'state': 'unknown', 'error': 'not-authorized' if '-1743' in err else err[:160]}
    _authorised = True
    parts = r.stdout.rstrip('\n').split('\t')
    info = {'running': True, 'state': parts[0] or 'unknown'}
    if len(parts) >= 4:
        info.update(title=parts[1], artist=parts[2], album=parts[3])
    if len(parts) >= 6 and parts[4].lstrip('-').isdigit() and parts[5].lstrip('-').isdigit():
        info.update(position=int(parts[4]), duration=int(parts[5]))
    if len(parts) >= 7 and parts[6].isdigit():
        info['volume'] = int(parts[6])
    return info


# Transport keys of the display, sent to the Music app. Only Music is ever addressed, and only these fixed commands.
CONTROL_SCRIPTS = {
    'playpause': 'tell application "Music" to playpause',
    'next': 'tell application "Music" to next track',
    'prev': 'tell application "Music" to previous track',
    'restart': 'tell application "Music" to set player position to 0',
    'ff': 'tell application "Music" to fast forward',
    'rw': 'tell application "Music" to rewind',
    'resume': 'tell application "Music" to resume',
}


def run_control(action, value=None):
    """One transport command. Never launches Music: it is only addressed if it is already running."""
    global _authorised
    if action == 'volume':
        # the VOL knob: an integer 0..100, nothing else ever reaches the script text
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            return {'ok': False, 'error': 'bad-action'}
        script = 'tell application "Music" to set sound volume to %d' % value
    else:
        script = CONTROL_SCRIPTS.get(action)
    if script is None:
        return {'ok': False, 'error': 'bad-action'}
    if subprocess.run(['pgrep', '-x', 'Music'], capture_output=True).returncode != 0:
        return {'ok': False, 'error': 'not-running'}
    try:
        r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True,
                           encoding='utf-8', timeout=NORMAL_TIMEOUT if _authorised else FIRST_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'timeout'}
    if r.returncode != 0:
        err = r.stderr.strip()
        return {'ok': False, 'error': 'not-authorized' if '-1743' in err else err[:160]}
    _authorised = True
    now_playing.invalidate()
    return {'ok': True}


class NowPlaying:
    """Caches the provider result briefly so several polling clients cost one AppleScript call."""

    def __init__(self, provider):
        self.provider = provider
        self.lock = threading.Lock()
        self.at = 0.0
        self.value = {'running': False, 'state': 'stopped'}

    def invalidate(self):
        with self.lock:
            self.at = 0.0

    def get(self):
        with self.lock:
            if time.time() - self.at > CACHE_SECONDS:
                self.value = self.provider()
                self.at = time.time()
            return dict(self.value, source='Music', available=True)


now_playing = NowPlaying(query_music)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _allowed_origin(self):
        origin = self.headers.get('Origin')
        if origin is None:
            return True, None
        # same-origin pages and file:// pages (Origin: null); never arbitrary websites
        if origin == 'null' or origin.startswith(('http://127.0.0.1:', 'http://localhost:')):
            return True, origin
        return False, None

    def _same_origin(self):
        # a state-changing request must come from this very page (or a non-browser client that sends no Origin)
        origin = self.headers.get('Origin')
        return origin is None or origin in ('http://127.0.0.1:%d' % PORT, 'http://localhost:%d' % PORT)

    def do_POST(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in ('127.0.0.1', 'localhost'):
            self.send_error(403)
            return
        if self.path.split('?', 1)[0] != '/api/control':
            self.send_error(404)
            return
        # custom header: a cross-site page cannot add it without a CORS pre-flight, which this server never answers
        if not self._same_origin() or self.headers.get('X-VFD-Control') != '1':
            self.send_error(403)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if not 0 < length <= 1024:
                raise ValueError('length')
            request = json.loads(self.rfile.read(length).decode('utf-8'))
            action = request.get('action')
            value = request.get('value')
        except (ValueError, AttributeError, UnicodeDecodeError):
            self.send_error(400)
            return
        result = run_control(action, value) if isinstance(action, str) else {'ok': False, 'error': 'bad-action'}
        body = json.dumps(result).encode('utf-8')
        self.send_response(400 if result.get('error') == 'bad-action' else 200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # refuse DNS-rebinding style requests: the Host header must be the loopback name we listen on
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in ('127.0.0.1', 'localhost'):
            self.send_error(403)
            return
        if self.path.split('?', 1)[0] == '/api/nowplaying':
            ok, origin = self._allowed_origin()
            if not ok:
                self.send_error(403)
                return
            body = json.dumps(now_playing.get(), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if origin:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    with Server((HOST, PORT), Handler) as httpd:
        print('VFD analyzer: http://%s:%d/   (Ctrl+C to stop)' % (HOST, PORT))
        print('Now playing (Music app): http://%s:%d/api/nowplaying' % (HOST, PORT))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nbye')


if __name__ == '__main__':
    sys.exit(main())
