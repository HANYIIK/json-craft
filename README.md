# JSON Craft

Make messy JSON readable.

**English** · [简体中文](README.zh-CN.md)

A local-first desktop workspace for formatting, repairing and exploring JSON on macOS and Windows. Paste a compressed response, open a file, or drop in several files—JSON Craft formats the result automatically and keeps the original text available.

[Download the latest release](https://github.com/HANYIIK/json-craft/releases/latest) · [Report an issue](https://github.com/HANYIIK/json-craft/issues)

![JSON Craft in English: original input and formatted JSON, recursive decoding and folded array counts](resources/screenshots/overview-en.png)

## What you can do

- **Format and unescape JSON.** Read compressed JSON and unwrap encoded JSON strings. Optionally decode JSON strings inside nested objects and arrays, while leaving ordinary text and Markdown links intact.
- **Repair broken JSON with a clear audit trail.** Use `jsonrepair` to recover common syntax errors, inspect the actual edits and compare before and after in a dedicated diff view.
- **Extract a value by key.** Search every nesting level, choose the full path when a key occurs more than once, then format, copy or export just that value.
- **Navigate with context.** Search and replace, fold objects and arrays, see an array's item count while folded, and jump to parent keys using the path bar. Expand either editor to fill the app.
- **Work with multiple files.** Import or drag in several `.json` files, switch between saved entries, rename files, and confirm deletion before moving the associated file to the system Trash or Recycle Bin.
- **Keep your workflow.** Edits save automatically. Choose your import, JSON file and history folders, copy results with one click, export them, or enable automatic copying after formatting.
- **Use your preferred appearance.** Light and dark themes, system theme detection, and English or Simplified Chinese, with preferences remembered across launches.

JSON processing happens on your device. No account, upload or cloud service is required. Files use UTF-8 and may be up to **20 MiB** each.

## Download and install

Get the installer for your operating system and processor from [Releases](https://github.com/HANYIIK/json-craft/releases/latest).

| Platform                             | Installer                                                                                                                    | Alternative                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS 13+ · Apple Silicon (M-series) | [Apple Silicon DMG](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-macOS-arm64.dmg)         | [ZIP](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-macOS-arm64.zip) |
| macOS 13+ · Intel                    | [Intel DMG](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-macOS-x64.dmg)                   | [ZIP](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-macOS-x64.zip)   |
| Windows · x64                        | [Windows x64 installer](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-Windows-x64.exe)     | —                                                                                                      |
| Windows · ARM64                      | [Windows ARM64 installer](https://github.com/HANYIIK/json-craft/releases/latest/download/JSON-Craft-0.1.1-Windows-arm64.exe) | —                                                                                                      |

**macOS:** Open the DMG and drag JSON Craft into Applications, or unzip the ZIP and move the app into Applications. This release uses an ad-hoc signature and is **not notarized by Apple**. If macOS blocks the first launch, review the message in **System Settings → Privacy & Security → Open Anyway** and approve only the copy you downloaded from this repository. See [Apple's first-open guidance](https://support.apple.com/en-us/102445).

**Windows:** Run the installer and choose an installation folder. This release does **not** have a verified publisher certificate, so Windows may show an unknown-publisher or SmartScreen warning. Check the download source and file before deciding whether to proceed.

Each release includes `SHA256SUMS` so you can check the downloaded files. Release builds verify the packaged applications before publishing the complete set of installers.

## A quick workflow

1. Paste JSON into **Source**, or use **Import files** / drag-and-drop.
2. Read the automatically updated **Formatted JSON**. Turn recursive unescaping on or off depending on whether you want to expand embedded JSON strings.
3. Need only one field? Enter its key in **Extract key**. If several paths match, select the one you want.
4. Use **Copy** or **Export** beneath the result. Open **View differences** when a repair needs review.

### Extract exactly what you need

An API response can contain nested objects, arrays or JSON encoded as a string. Key extraction finds matching fields across the document and lets you work with the selected value without replacing the source.

![JSON Craft in English: extracting nested orders by key and displaying the selected JSON path](resources/screenshots/extract-en.png)

### Review every repair

The diff page highlights deletions in red and additions in green. It initially shows the lines near changes; expand hidden sections, show the full file, or jump between changes with the previous and next buttons.

![JSON Craft in English: a side-by-side repair diff with removed and added text](resources/screenshots/repair-en.png)

## Your files and data

- **Original text is auto-saved.** New inputs and edits are saved as ordinary `.json` files in the JSON file folder you choose. Incomplete or invalid JSON is also preserved as entered.
- **Results are separate.** Copy and Export use the currently displayed formatted or extracted result; they do not replace the original input automatically.
- **History restores your workspace.** The history folder stores internal records, formatting options and extraction state. The import folder controls where the file picker opens.
- **Imports avoid overwriting files.** Files imported from another folder are copied into your JSON file folder. If the folders are the same, JSON Craft works with the existing file.
- **Deletion requires confirmation.** The dialog shows the affected file path. Confirming moves that associated file to the system Trash or Recycle Bin and removes its history entry. A separate external source file is preserved when you imported a copy.

Repair can infer missing content, so review the changes before relying on repaired data. Ordinary formatting preserves number literals, duplicate keys and valid escapes; recursive unescaping intentionally turns embedded JSON strings into structured values when enabled.

### Current limitation

Extremely long, heavily escaped JSON string lines can still display incompletely in the diff view. The underlying JSON and full Copy/Export output are preserved.

## Feedback

Found a problem or have a feature request? [Open an issue](https://github.com/HANYIIK/json-craft/issues). Include your operating system, app version and a small anonymized example when possible.

Built with Electron, React, CodeMirror and [jsonrepair](https://github.com/josdejong/jsonrepair).
