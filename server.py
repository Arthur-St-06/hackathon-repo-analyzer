#!/usr/bin/env python3
"""Dev server — static files from public/ + POST /api/run/<group_id> pipeline SSE."""
import http.server, json, re, shutil, subprocess, threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT     = Path(__file__).parent
PUBLIC        = REPO_ROOT / 'public'
PORT          = 8080
CACHE_VERSION = "v1"

_state = {'running': False}
_lock  = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, fmt, *args): pass

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith('/api/run/'):
            group_id = path.removeprefix('/api/run/').strip('/')
            self._stream(group_id)
        else:
            self.send_error(404)

    def _emit(self, event, data):
        try:
            self.wfile.write(f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode())
            self.wfile.flush()
        except OSError:
            pass

    def _stream(self, group_id):
        with _lock:
            if _state['running']:
                self.send_response(409)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error":"Pipeline already running"}')
                return
            _state['running'] = True

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        try:
            self._surface(group_id)
            cached = self._restore_from_cache()
            self._validate(group_id, skip=cached)
            self._save_to_cache()
            self._emit('done', {'pct': 100, 'msg': 'Complete!'})
        except Exception as e:
            self._emit('error', {'msg': str(e)})
        finally:
            with _lock:
                _state['running'] = False

    def _proc(self, cmd, on_line):
        proc = subprocess.Popen(cmd, shell=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, cwd=str(REPO_ROOT))
        for raw in proc.stdout:
            line = raw.rstrip('\n')
            if line.strip():
                on_line(line)
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f'Script exited with code {proc.returncode}')

    def _surface(self, group_id):
        for f in (REPO_ROOT / 'findings' / 'raw').glob('*.json'):
            f.unlink()
        for f in (REPO_ROOT / 'findings' / 'validated').glob('*.json'):
            f.unlink()

        self._emit('progress', {'pct': 2, 'msg': 'Starting surface scan…', 'log': None})
        pct = [2]

        def on_line(line):
            p, m = pct[0], None
            if 'Scoring issues' in line:
                p, m = 8, 'Scoring issues…'
            elif re.search(r'Scored \d+ issues', line):
                p, m = 20, line.strip()
            elif 'Writing top' in line:
                p, m = 26, 'Writing raw findings…'
            elif 'SURFACE_COMPLETE' in line:
                p = 30
                n = re.search(r'(\d+) findings', line)
                m = f'{n.group(1)} findings surfaced' if n else 'Surface complete'
            pct[0] = p
            self._emit('progress', {'pct': p, 'msg': m, 'log': line})

        self._proc(f'bash tools/02_surface.sh {group_id} 2', on_line)

    def _restore_from_cache(self) -> set:
        """Copy valid cached findings into validated/. Returns set of cached issue numbers."""
        raw_dir   = REPO_ROOT / 'findings' / 'raw'
        val_dir   = REPO_ROOT / 'findings' / 'validated'
        cache_dir = REPO_ROOT / 'findings' / 'cache'

        if not cache_dir.exists():
            return set()

        hits: set[int] = set()
        for raw_path in raw_dir.glob('*.json'):
            cache_path = cache_dir / raw_path.name
            if not cache_path.exists():
                continue
            with open(raw_path) as f:
                raw = json.load(f)
            with open(cache_path) as f:
                cached = json.load(f)
            if cached.get('_cache_version') != CACHE_VERSION:
                continue
            if sorted(raw.get('issue_labels', [])) != sorted(cached.get('issue_labels', [])):
                continue
            cached.pop('_cache_version', None)
            with open(val_dir / raw_path.name, 'w') as f:
                json.dump(cached, f, indent=2); f.write('\n')
            hits.add(raw['issue_number'])

        if hits:
            self._emit('progress', {'pct': 31, 'msg': f'{len(hits)} finding(s) from cache', 'log': f'Cache: {len(hits)} hit(s), skipping re-validation'})
        return hits

    def _validate(self, group_id: str, skip: set = None):
        raw_dir = REPO_ROOT / 'findings' / 'raw'

        to_validate = []
        for raw_path in sorted(raw_dir.glob('*.json')):
            with open(raw_path) as f:
                num = json.load(f).get('issue_number')
            if skip and num in skip:
                continue
            to_validate.append(str(num))

        if not to_validate:
            self._emit('progress', {'pct': 92, 'msg': 'All findings from cache — aggregating…', 'log': 'Skipping validation (all cached)'})
            self._aggregate(group_id)
            return

        self._emit('progress', {'pct': 31, 'msg': f'Validating {len(to_validate)} finding(s)…', 'log': None})
        total, done = [len(to_validate)], [0]

        def on_line(line):
            m = re.search(r'(\d+) finding\(s\) to process', line)
            if m:
                total[0] = max(int(m.group(1)), 1)
                self._emit('progress', {'pct': 33, 'msg': f'Validating {total[0]} findings…', 'log': line})
                return
            if re.search(r'(VALIDATED|SKIP|PRECHECK_REJECT):', line):
                done[0] += 1
                p = 33 + int(done[0] / total[0] * 57)
                self._emit('progress', {'pct': p, 'msg': f'Validated {done[0]} / {total[0]}', 'log': line})
                return
            if 'Aggregating results' in line:
                self._emit('progress', {'pct': 92, 'msg': 'Aggregating results…', 'log': line})
                return
            if 'findings.json' in line and 'Wrote' in line:
                self._emit('progress', {'pct': 97, 'msg': line.strip(), 'log': line})
                return
            self._emit('progress', {'pct': None, 'msg': None, 'log': line})

        self._proc(f'bash tools/03_validate.sh {" ".join(to_validate)}', on_line)
        # 03_validate.sh wrote public/data/findings.json — publish as per-group file
        self._publish(group_id)

    def _aggregate(self, group_id: str):
        """Regenerate findings when all results came from cache."""
        val_dir = REPO_ROOT / 'findings' / 'validated'
        now     = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        findings = []
        for fp in sorted(val_dir.glob('*.json')):
            with open(fp) as f:
                d = json.load(f)
            d.pop('_cache_version', None)
            findings.append(d)
        findings.sort(key=lambda x: (x.get('confidence') or 0), reverse=True)

        try:
            with open(REPO_ROOT / 'data' / 'selected_topics.json') as f:
                sel = json.load(f)
            group_name      = sel.get('selected_group', {}).get('display_name', '')
            selected_labels = [t['label'] for t in sel.get('selected_topics', [])]
        except Exception:
            group_name, selected_labels = '', []

        pub_dir = REPO_ROOT / 'public' / 'data'
        pub_dir.mkdir(exist_ok=True)
        payload = {'metadata': {'generated_at': now, 'group': group_name,
                                'selected_topics': selected_labels,
                                'corpus_version': 'full_v1'},
                   'findings': findings}

        with open(pub_dir / 'findings.json', 'w') as f:
            json.dump(payload, f, indent=2); f.write('\n')
        with open(pub_dir / f'findings_{group_id}.json', 'w') as f:
            json.dump(payload, f, indent=2); f.write('\n')

        self._update_index(group_id, len(findings), now)
        self._emit('progress', {'pct': 97, 'msg': f'Wrote findings ({len(findings)} findings)', 'log': f'Aggregated {len(findings)} cached finding(s)'})

    def _publish(self, group_id: str):
        """Copy findings.json → findings_<group_id>.json and update index."""
        pub_dir  = REPO_ROOT / 'public' / 'data'
        src      = pub_dir / 'findings.json'
        if not src.exists():
            return
        shutil.copy2(str(src), str(pub_dir / f'findings_{group_id}.json'))
        with open(src) as f:
            data = json.load(f)
        self._update_index(group_id, len(data.get('findings', [])),
                           data.get('metadata', {}).get('generated_at', ''))

    def _update_index(self, group_id: str, count: int, generated_at: str):
        pub_dir  = REPO_ROOT / 'public' / 'data'
        pub_dir.mkdir(exist_ok=True)
        idx_path = pub_dir / 'findings_index.json'
        idx = {}
        if idx_path.exists():
            with open(idx_path) as f:
                idx = json.load(f)
        idx[group_id] = {'count': count, 'generated_at': generated_at}
        with open(idx_path, 'w') as f:
            json.dump(idx, f, indent=2); f.write('\n')

    def _save_to_cache(self):
        """Save validated findings to cache for future runs."""
        val_dir   = REPO_ROOT / 'findings' / 'validated'
        cache_dir = REPO_ROOT / 'findings' / 'cache'
        cache_dir.mkdir(exist_ok=True)
        for val_path in val_dir.glob('*.json'):
            with open(val_path) as f:
                finding = json.load(f)
            finding['_cache_version'] = CACHE_VERSION
            with open(cache_dir / val_path.name, 'w') as f:
                json.dump(finding, f, indent=2); f.write('\n')


def _migrate_legacy():
    """If findings.json exists but findings_index.json doesn't, create per-group file."""
    pub_dir  = REPO_ROOT / 'public' / 'data'
    idx_path = pub_dir / 'findings_index.json'
    src      = pub_dir / 'findings.json'

    if idx_path.exists() or not src.exists():
        return

    try:
        with open(src) as f:
            data = json.load(f)
        group_name   = data.get('metadata', {}).get('group', '')
        generated_at = data.get('metadata', {}).get('generated_at', '')
        count        = len(data.get('findings', []))

        if not group_name:
            return

        tg_path = pub_dir / 'topic_groups.json'
        if not tg_path.exists():
            tg_path = REPO_ROOT / 'data' / 'topic_groups.json'
        if not tg_path.exists():
            return

        with open(tg_path) as f:
            tg = json.load(f)

        group_id = next(
            (g['group_id'] for g in tg.get('groups', []) if g.get('display_name') == group_name),
            None,
        )
        if not group_id:
            return

        shutil.copy2(str(src), str(pub_dir / f'findings_{group_id}.json'))
        with open(idx_path, 'w') as f:
            json.dump({group_id: {'count': count, 'generated_at': generated_at}}, f, indent=2)
            f.write('\n')
        print(f'Migrated findings.json → findings_{group_id}.json')
    except Exception as e:
        print(f'Migration warning: {e}')


if __name__ == '__main__':
    _migrate_legacy()
    server = http.server.ThreadingHTTPServer(('', PORT), Handler)
    print(f'Serving at http://localhost:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
