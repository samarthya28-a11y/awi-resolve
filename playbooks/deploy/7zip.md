---
product: 7-Zip
aliases: 7zip, 7 zip, 7-zip, zip tool, archive tool
version: latest (24.x)
---

# Deploying 7-Zip (file archive tool)

A simple, safe example manual used to demonstrate guided deployment.

## Prerequisites
- Windows 10 or 11, 64-bit (almost all modern PCs).
- About 5 MB of free disk space.
- No licence key needed — 7-Zip is free software.

## Where to get the installer
- Official site: https://www.7-zip.org/download.html
- Choose the **64-bit x64 .exe** installer (e.g. `7z2408-x64.exe`).

## Steps
1. Download the 64-bit installer from the link above.
2. To install normally: double-click the installer and click **Install**, then **Close**.
3. To install silently (no clicks — useful across many PCs): open the folder where
   it downloaded and run the installer with the `/S` switch, e.g.
   `7z2408-x64.exe /S`. It installs to `C:\Program Files\7-Zip` with no prompts.

## Required settings
- None. Default options are fine for almost everyone.

## Verify it worked
- The file `C:\Program Files\7-Zip\7zFM.exe` exists, and "7-Zip File Manager"
  appears in the Start menu.
- Right-clicking a file now shows a **7-Zip** option in the menu.

## Common problems
- "Windows protected your PC" (SmartScreen) → click **More info → Run anyway**
  (only because it came from the official 7-zip.org site).
- Nothing happens after the silent `/S` install → check you ran the **x64** file on
  a 64-bit PC, and that you have permission to write to Program Files (may need admin).
