#!/usr/bin/env python3
"""Fix UTF-8 encoding issues in IOAccessEmulator.tsx"""

import sys
import os

# File to fix
filepath = sys.argv[1] if len(sys.argv) > 1 else 'IOAccessEmulator.tsx'

if not os.path.exists(filepath):
    print(f"Error: {filepath} not found")
    sys.exit(1)

# Read file
with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()

# Corrupted -> Correct mappings (mojibake to proper UTF-8)
fixes = [
    # Bullet points
    ('\xe2\x80\xa2'.encode().decode('utf-8', errors='replace'), '\u2022'),  # •
    ('â€¢', '\u2022'),  # • bullet
    
    # Checkmarks and X marks  
    ('âœ"', '\u2713'),  # ✓
    ('âœ—', '\u2717'),  # ✗
    
    # Arrows
    ('â†'', '\u2192'),  # →
    
    # Emojis - these get double-encoded
    ('ðŸ"¥', '\U0001F4E5'),  # 📥
    ('ðŸ"¤', '\U0001F4E4'),  # 📤
    ('ðŸ"‡', '\U0001F4C7'),  # 📇
    ('ðŸšª', '\U0001F6AA'),  # 🚪
    ('ðŸš¶', '\U0001F6B6'),  # 🚶
    ('ðŸ•', '\U0001F550'),   # 🕐
    ('ðŸ'¡', '\U0001F4A1'),  # 💡
    ('ðŸŽ¬', '\U0001F3AC'),  # 🎬
    
    # Warning emoji
    ('âš ï¸', '\u26A0\uFE0F'),  # ⚠️
]

original_len = len(content)
changes = 0

for bad, good in fixes:
    if bad in content:
        count = content.count(bad)
        content = content.replace(bad, good)
        changes += count
        print(f"  Fixed {count}x: {repr(bad)} -> {repr(good)}")

if changes > 0:
    # Backup original
    backup_path = filepath + '.bak'
    with open(backup_path, 'w', encoding='utf-8') as f:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as orig:
            pass  # backup already exists from earlier
    
    # Write fixed content
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"\n✓ Fixed {changes} encoding issues in {filepath}")
else:
    print(f"No encoding issues found in {filepath}")
