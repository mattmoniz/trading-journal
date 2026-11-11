"""Add a rule to CLAUDE.md the ONLY sanctioned way (2026-11-01): ONE short line in CLAUDE.md, the full text verbatim in docs/CLAUDE_MD_ARCHIVE/<section>.md with an anchor.
Usage:  python3 scripts/claude_md_add_rule.py <hard_rules|conventions|collaboration|where_to_look> "<one line, <=200 chars>" [--full FILE|-] [--pointer] [--dry]
  --full   the full text (incident, numbers, how to apply); '-' reads stdin; without it the one line is also the archive entry
  --pointer  for where_to_look only: also list the line in CLAUDE.md (default: where_to_look entries are archive-only, indexed in the archive file)
Refuses if the resulting CLAUDE.md would exceed the cap (see scripts/git-hooks/check-claude-md-size.sh)."""
import sys, re, os
SECS = {'hard_rules': ('Hard rules', 'hr'), 'conventions': ('Conventions', 'cv'), 'collaboration': ('Collaboration', 'co'), 'where_to_look': ('Where to look', 'wl')}
MAX_LINE, MAX_BYTES = 200, 40960
def main():
    a = [x for x in sys.argv[1:]]; dry = '--dry' in a; pointer = '--pointer' in a; full = None
    if '--full' in a: i = a.index('--full'); src = a[i + 1]; full = sys.stdin.read() if src == '-' else open(src, encoding='utf-8').read(); del a[i:i + 2]
    a = [x for x in a if not x.startswith('--')]
    if len(a) != 2 or a[0] not in SECS: sys.exit(__doc__)
    key, line = a; line = line.strip()
    if '\n' in line or len(line) > MAX_LINE: sys.exit(f'one-line entry must be a single line of at most {MAX_LINE} chars (got {len(line)}); put the detail in --full')
    name, pfx = SECS[key]; ap = f'docs/CLAUDE_MD_ARCHIVE/{key}.md'; arch = open(ap, encoding='utf-8').read()
    nums = [int(x) for x in re.findall(rf'<a id="{pfx}-(\d+)"></a>', arch)]; eid = f'{pfx}-{max(nums) + 1:03d}'
    body = (full if full is not None else line).strip('\n'); body = re.sub(r'\]\((?!https?:|#|\.\./|mailto:)([^)\s]+)\)', r'](../../\1)', body)
    entry = body if body.lstrip().startswith('- **') else f'- **{line}**\n\n{body}' if full is not None else f'- **{line}**'
    idx_line = f'- [{eid}](#{eid}) {line}'; sep = '\n---\n'; k = arch.index(sep)
    new_arch = arch[:k].rstrip('\n') + '\n' + idx_line + '\n' + arch[k:].rstrip('\n') + f'\n\n<a id="{eid}"></a>\n\n{entry}\n'
    s = open('CLAUDE.md', encoding='utf-8').read(); new_s = s
    if key != 'where_to_look' or pointer:
        m = re.search(rf'(?m)^## {re.escape(name)}\b.*$', s); assert m, f'section {name} not found in CLAUDE.md'
        nxt = re.search(r'(?m)^## ', s[m.end():]); end = m.end() + nxt.start() if nxt else len(s)
        block = s[m.end():end].rstrip('\n'); new_block = block + (f'\n- {line}\n\n' if line.rstrip().endswith(f'({eid})') else f'\n- {line} ({eid})\n\n')   # never print the id twice (Fable audit row 17)
        new_s = s[:m.end()] + new_block + s[end:]
    nb = len(new_s.encode())
    if nb > MAX_BYTES: sys.exit(f'REFUSED: CLAUDE.md would be {nb} bytes (cap {MAX_BYTES}). Archive or shorten existing entries first (the archive keeps the full text).')
    print(f'{eid}: CLAUDE.md {len(s.encode())} -> {nb} bytes' + (' (dry run, nothing written)' if dry else ''))
    if not dry: open(ap, 'w', encoding='utf-8').write(new_arch); open('CLAUDE.md', 'w', encoding='utf-8').write(new_s)
main()
