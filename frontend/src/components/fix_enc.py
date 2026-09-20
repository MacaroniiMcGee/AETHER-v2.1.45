#!/usr/bin/env python3
import sys
import os

filepath = sys.argv[1] if len(sys.argv) > 1 else 'IOAccessEmulator.tsx'

if not os.path.exists(filepath):
    print("Error: file not found")
    sys.exit(1)

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace problematic unicode with ASCII equivalents
fixes = [
    # Emojis to ASCII
    ('\u2705', '[OK]'),      # ✅
    ('\u274c', '[X]'),       # ❌  
    ('\U0001F4E5', '[IN]'),  # 📥
    ('\U0001F4E4', '[OUT]'), # 📤
    ('\U0001F4C7', '[CARD]'),# 📇
    ('\U0001F6AA', '[DOOR]'),# 🚪
    ('\U0001F6B6', '[WALK]'),# 🚶
    ('\U0001F550', '[TIME]'),# 🕐
    ('\U0001F4A1', '[TIP]'), # 💡
    ('\U0001F3AC', '[>]'),   # 🎬
    ('\u26A0\uFE0F', '[!]'), # ⚠️
    ('\u26A0', '[!]'),       # ⚠
    ('\u2713', '[OK]'),      # ✓
    ('\u2717', '[X]'),       # ✗
    ('\u2022', '-'),         # •
    ('\u2192', '->'),        # →
]

changes = 0
for bad, good in fixes:
    if bad in content:
        count = content.count(bad)
        content = content.replace(bad, good)
        changes += count
        print("Replaced " + str(count) + "x: " + repr(bad) + " -> " + good)

if changes > 0:
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Done! " + str(changes) + " replacements made")
else:
    print("No unicode found to replace")
