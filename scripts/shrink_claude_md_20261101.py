"""Lossless CLAUDE.md shrink (2026-11-01). Moves every entry of Hard rules / Conventions / Collaboration / Where to look VERBATIM into docs/CLAUDE_MD_ARCHIVE/*.md (anchored), and leaves a one-line rule + link in CLAUDE.md.
Usage: python3 scripts/shrink_claude_md_20261101.py --dry   (prints stats and samples, writes nothing)   |   --apply   (writes the archive files and the new CLAUDE.md)"""
import re, sys, os, hashlib
SRC = 'CLAUDE.md'; OUT = 'docs/CLAUDE_MD_ARCHIVE'
CAPS = {'Hard rules': 128, 'Conventions': 84, 'Collaboration': 84}
FILES = {'Hard rules': ('hard_rules.md', 'hr'), 'Conventions': ('conventions.md', 'cv'), 'Collaboration': ('collaboration.md', 'co'), 'Where to look': ('where_to_look.md', 'wl')}
KEEP_POINTERS = ['Conviction/session read logic', 'Opening range / day-type', 'Level fade alpha engine', 'Shared query helpers', 'Risk guardrails', 'Optimal stops/targets', 'Known bugs', 'Pending decisions', 'Database migration protocol', 'Database backup table catalog', 'Standing data-sanity audit', 'Alpha Engine overview', 'Sierra Chart DTC order placement', 'Pipeline freshness', 'Setup Reference page', 'Research Ledger page', 'Standalone "quick-check" page', 'Opus audit prompts']

def split_sections(s):
    parts = re.split(r'(?m)^(## .*)$', s); return parts[0], [(parts[i], parts[i + 1]) for i in range(1, len(parts), 2)]

def split_entries(body):
    """entries start at a line beginning with '- **'; everything up to the next such line belongs to the entry (continuation paragraphs included). Returns (head_text_before_first_entry, [entry_text])."""
    idx = [m.start() for m in re.finditer(r'(?m)^- \*\*', body)]
    if not idx: return body, []
    ents = [body[idx[k]:(idx[k + 1] if k + 1 < len(idx) else len(body))] for k in range(len(idx))]
    return body[:idx[0]], ents

def lead(ent, cap):
    t = ent[2:].strip(); m = re.match(r'\*\*(.+?)\*\*', t, re.S); first = m.group(1).strip() if m else t.split('\n')[0]
    rest = t[m.end():].strip() if m else ''
    first = re.sub(r'\s+', ' ', first).rstrip(':.')
    if len(first) < 90 and rest:
        extra = re.sub(r'\s+', ' ', re.sub(r'\*\*', '', rest.split('\n')[0])).lstrip(':—- ').strip()
        first = first + (': ' if not first.endswith(('—', '-')) else ' ') + extra
    first = re.sub(r'\*\*', '', first)
    if len(first) > cap:
        cut = first[:cap]; k = max(cut.rfind(' — '), cut.rfind('. '), cut.rfind('; '), cut.rfind(', '), cut.rfind(' '))
        first = (cut[:k] if k > cap * 0.5 else cut).rstrip(' ,;:—-') + ' …'
    return first

def fix_links(txt):
    return re.sub(r'\]\((?!https?:|#|\.\./|mailto:)([^)\s]+)\)', r'](../../\1)', txt)

def main(apply):
    s = open(SRC, encoding='utf-8').read(); pre, secs = split_sections(s); out = [pre.rstrip() + '\n']; arch = {}; stats = []
    for head, body in secs:
        name = head[3:].strip()
        if name in FILES:
            fname, pfx = FILES[name]; headtxt, ents = split_entries(body); lines = []; archived = []
            for k, e in enumerate(ents):
                eid = f'{pfx}-{k + 1:03d}'; cap = CAPS.get(name, 120); ld = lead(e, cap) if name != 'Where to look' else lead(e, 140)
                archived.append((eid, ld, e.rstrip('\n')))
                keep = name != 'Where to look' or any(e[2:].lstrip('*').startswith(p) or p in e[:120] for p in KEEP_POINTERS)
                if keep: lines.append(f'- {ld} [→](docs/CLAUDE_MD_ARCHIVE/{fname}#{eid})')
            arch[fname] = (name, archived)
            intro = headtxt.strip('\n')
            if name == 'Where to look':
                intro = (f"Index of {len(ents)} research threads and system notes (one line each, linked): [docs/CLAUDE_MD_ARCHIVE/where_to_look.md](docs/CLAUDE_MD_ARCHIVE/where_to_look.md). The pointers below are the structural entry points; everything else is a grep away in that index. Check `docs/OPEN_THREADS.md` and `node scripts/flag_decision.mjs --list` first.")
            out.append(f'\n{head}\n\n' + (intro + '\n\n' if intro else '') + '\n'.join(lines) + '\n')
            stats.append((name, len(ents), sum(len(x) for x in lines) + len(intro)))
        else: out.append(f'\n{head}{body.rstrip(chr(10))}\n')
    new = ''.join(out)
    note = "\n> **CLAUDE.md is an INDEX (cap 40 KB / 300 lines, test_invariants [14]).** Each line below is the rule in brief; the full verbatim text, incident history and numbers are in `docs/CLAUDE_MD_ARCHIVE/` (arrow links). New rules: add a one-line entry here and the full text in the archive file, never a paragraph here.\n"
    new = new.replace('\n## Dev workflow', note + '\n## Dev workflow', 1)
    print(f'NEW BYTES {len(new.encode())} (cap 40960)'); print(f'ORIGINAL {len(s)} chars ({len(s) // 4} est tokens), {s.count(chr(10))} lines -> NEW {len(new)} chars ({len(new) // 4} est tokens), {new.count(chr(10))} lines')
    for n, c, ch in stats: print(f'  {n:14s} entries {c:3d} -> {ch:7d} chars kept in CLAUDE.md')
    if not apply:
        import random; random.seed(1); allr = [(f, k) for f, (n, a) in arch.items() for k in a if n != 'Where to look']
        for f, (eid, ld, e) in random.sample(allr, 10): print(f'  [{eid}] {ld}')
        return
    os.makedirs(OUT, exist_ok=True)
    for fname, (name, archived) in arch.items():
        buf = [f'# CLAUDE.md archive: {name} (verbatim, moved 2026-11-01)\n\nFull text of every entry that CLAUDE.md now summarises in one line. Nothing was rewritten. Relative links were adjusted for this folder. Back to [CLAUDE.md](../../CLAUDE.md).\n\n## Index\n']
        for eid, ld, e in archived: buf.append(f'- [{eid}](#{eid}) {ld}')
        buf.append('\n---\n')
        for eid, ld, e in archived: buf.append(f'\n<a id="{eid}"></a>\n\n{fix_links(e)}\n')
        open(f'{OUT}/{fname}', 'w', encoding='utf-8').write('\n'.join(buf))
    open(SRC, 'w', encoding='utf-8').write(new)
    # verification: every original entry is present verbatim (after link fix) in its archive file
    ok = True
    for head, body in secs:
        name = head[3:].strip()
        if name not in FILES: continue
        a = open(f'{OUT}/{FILES[name][0]}', encoding='utf-8').read(); _, ents = split_entries(body)
        for e in ents:
            if fix_links(e.rstrip('\n')) not in a: ok = False; print('MISSING ENTRY in', FILES[name][0], e[:80])
    print('VERIFY every original entry present verbatim in the archive:', ok)

main('--apply' in sys.argv)
