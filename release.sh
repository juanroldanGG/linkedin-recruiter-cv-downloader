#!/bin/bash
# Repack, refresh the update manifest, and publish. Run after bumping version in manifest.json.
set -e
cd "$(dirname "$0")"

VERSION=$(node -p "require('./manifest.json').version")
ID=$(cat extension-id.txt)
URL="https://juanroldangg.github.io/linkedin-recruiter-cv-downloader"

# Only the files the extension actually runs -- not the test and setup notes.
rm -rf build && mkdir build
cp -r manifest.json background.js icons build/

rm -f build.crx
"/c/Program Files/Google/Chrome/Application/chrome.exe"   --pack-extension="$(pwd -W)\build" --pack-extension-key="$(pwd -W)\build.pem" --no-message-box
sleep 3
cp build.crx linkedin-recruiter-cv-downloader.crx

cat > updates.xml <<XML
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$ID">
    <updatecheck codebase="$URL/linkedin-recruiter-cv-downloader.crx" version="$VERSION" />
  </app>
</gupdate>
XML

git add -A && git commit -m "Release v$VERSION" && git push
echo "Published v$VERSION. Team browsers update within a few hours."
