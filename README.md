<div align="center">

**English** | [简体中文](README.zh-CN.md)

# JSON Craft

### Offline JSON Formatter, Repair, Diff & Log Extractor

Make messy JSON readable. Make differences clear.

A local-first desktop workspace for formatting, repairing, extracting and comparing JSON on macOS and Windows. Paste a compressed response, open a file, or drop in several files—JSON Craft formats the result automatically and keeps the original text available.

If you like JSON Craft, please give it a star [⭐](https://github.com/HANYIIK/json-craft).

<p align="center">
  <a href="https://github.com/HANYIIK/json-craft/releases/latest">
    <img src="https://img.shields.io/github/v/release/HANYIIK/json-craft?style=flat-square&amp;color=23644a&amp;label=Release&amp;logo=github&amp;logoColor=white" alt="Latest release">
  </a>
  <a href="#download-and-install">
    <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-334155?style=flat-square&amp;logo=apple&amp;logoColor=white" alt="Platforms: macOS and Windows">
  </a>
</p>

[Download the latest release](https://github.com/HANYIIK/json-craft/releases/latest) · [Report an issue](https://github.com/HANYIIK/json-craft/issues)

</div>

![JSON Craft in English: original input and formatted JSON, recursive decoding and folded array counts](resources/screenshots/overview-en.png)

## What you can do

- **Format and unescape JSON.** Read compressed JSON and unwrap encoded JSON strings. Optionally decode JSON strings inside nested objects and arrays, while leaving ordinary text and Markdown links intact.
- **Repair broken JSON with a clear audit trail.** Use `jsonrepair` to recover common syntax errors, inspect the actual edits and compare before and after in a dedicated diff view.
- **Compare two JSON documents.** Format both inputs, recursively align the second document's object keys to the first, then review the remaining differences. Array items stay in their original order, and fields unique to either document remain visible.
- **Extract JSON from logs.** Find objects, arrays and encoded JSON strings in mixed log text. Preview results in horizontally scrollable tabs, close the ones you do not need, and move the remaining results into your workspace as saved JSON files.
- **Extract a value by key.** Search every nesting level, choose the full path when a key occurs more than once, then format, copy or export just that value.
- **Navigate with context.** Search and replace, fold objects and arrays, see an array's item count while folded, and jump to parent keys using the path bar. Expand either editor to fill the app.
- **Work with multiple files.** Import or drag in several `.json` files, switch between saved entries, rename files, and confirm deletion before moving the associated file to the system Trash or Recycle Bin.
- **Keep your workflow.** Source workspace edits save automatically. Choose your import, JSON file and history folders, copy results with one click, export them, or enable automatic copying after formatting.
- **Use your preferred appearance.** Light and dark themes, system theme detection, and English or Simplified Chinese, with preferences remembered across launches.

JSON processing happens on your device. No account, upload or cloud service is required. Files use UTF-8 and may be up to **20 MiB** each.

## Download and install

Get the installer for your operating system and processor from [Releases](https://github.com/HANYIIK/json-craft/releases/latest).

| Platform                             | Installer                                                                                                                    | Alternative                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| macOS 13+ · Apple Silicon (M-series) | [Apple Silicon DMG](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-macOS-arm64.dmg)         | [ZIP](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-macOS-arm64.zip) |
| macOS 13+ · Intel                    | [Intel DMG](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-macOS-x64.dmg)                   | [ZIP](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-macOS-x64.zip)   |
| Windows · x64                        | [Windows x64 installer](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-Windows-x64.exe)     | —                                                                                                      |
| Windows · ARM64                      | [Windows ARM64 installer](https://github.com/HANYIIK/json-craft/releases/download/v0.3.0/JSON-Craft-0.3.0-Windows-arm64.exe) | —                                                                                                      |

**macOS:** Open the DMG and drag JSON Craft into Applications, or unzip the ZIP and move the app into Applications. This release uses an ad-hoc signature and is **not notarized by Apple**. If macOS blocks the first launch, review the message in **System Settings → Privacy & Security → Open Anyway** and approve only the copy you downloaded from this repository. See [Apple's first-open guidance](https://support.apple.com/en-us/102445).

**Windows:** Run the installer and choose an installation folder. This release does **not** have a verified publisher certificate, so Windows may show an unknown-publisher or SmartScreen warning. Check the download source and file before deciding whether to proceed.

Each release includes `SHA256SUMS` so you can check the downloaded files. Release builds verify the packaged applications before publishing the complete set of installers.

## A quick workflow

1. Paste JSON into **Source**, or use **Import files** / drag-and-drop.
2. Read the automatically updated **Formatted JSON**. Turn recursive unescaping on or off depending on whether you want to expand embedded JSON strings.
3. Need only one field? Enter its key in **Extract key**. If several paths match, select the one you want.
4. Use **Copy** or **Export** beneath the result. Open **View differences** when a repair needs review.

### Compare JSON without key-order noise

Open **JSON Compare** below **New input** in the sidebar. Paste or import one JSON document on each side; you can also drop two `.json` files onto the comparison page. Both inputs format automatically using your unescaping, recursive unescaping, repair and indentation choices.

![JSON Craft in English: two automatically formatted inputs in JSON Compare](resources/screenshots/comparison-inputs-en.png)

Click **Align & compare** to open the diff. At each matching object path, the second document follows the first document's key order; right-only keys follow at the end. Objects inside arrays align by index, while array items themselves are never reordered. Values, number literals and duplicate keys are preserved by key alignment.

Only the lines near differences appear by default. Jump between changes, expand hidden lines, or choose **Show full file**. Use **Back to editing** to revise your inputs and compare again; changing formatting options reprocesses the original text.

![JSON Craft in English: aligned JSON comparison with additions, deletions and collapsed unchanged lines](resources/screenshots/comparison-result-en.png)

Comparison drafts remain available when you switch pages during the current session. They are not saved to files or history and are cleared when the app closes.

### Extract JSON from logs

Open **JSON Extract** below **JSON Compare** in the sidebar. Paste logs or mixed text, then click **Extract JSON**. Objects, arrays and encoded JSON strings are detected, while ordinary log markers, Markdown links and text such as `[REDACTED]` are left alone.

**Auto-unescape**, **Recursive unescape**, **Repair JSON** and indentation control each result. Changing these options refreshes the extracted results.

![JSON Craft in English: JSON extracted from mixed logs, with horizontal result tabs and formatted preview](resources/screenshots/log-extract-en.png)

Switch between tabs to preview, copy, locate the original text or expand a result to fill the app. Scroll the tab bar horizontally when there are many results; tab close buttons and overlay scrollbars appear when you hover over their area, without reserving space or shifting the layout. Close unwanted tabs, then click **Move to workspace** to save the remaining results as ordinary `.json` files in your configured storage folder and add them to History. Results already moved are marked and will not be moved again in the same result set.

![JSON Craft in English: an extracted JSON result expanded to fill the app, with result tabs still available](resources/screenshots/log-extract-expanded-en.png)

Logs and result tabs stay in the current session. Closing a tab removes it from the pending result set; it does not delete a file that has already been saved. **Extract JSON** starts a new result set and restores closed tabs. One extraction can return up to **200 results**; if a processing limit is reached, split the remaining logs into smaller sections.

### Extract exactly what you need

An API response can contain nested objects, arrays or JSON encoded as a string. Key extraction finds matching fields across the document and lets you work with the selected value without replacing the source.

![JSON Craft in English: extracting nested orders by key and displaying the selected JSON path](resources/screenshots/extract-en.png)

### Review every repair

The diff page highlights deletions in red and additions in green. It initially shows the lines near changes; expand hidden sections, show the full file, or jump between changes with the previous and next buttons.

![JSON Craft in English: a side-by-side repair diff with removed and added text](resources/screenshots/repair-en.png)

## Your files and data

- **Original text is auto-saved.** New inputs and edits are saved as ordinary `.json` files in the JSON file folder you choose. Incomplete or invalid JSON is also preserved as entered.
- **Results are separate.** Copy and Export use the currently displayed formatted or extracted result; they do not replace the original input automatically.
- **Comparison is a separate workspace.** Importing or editing JSON in JSON Compare does not modify your source files, create history entries or auto-save comparison drafts.
- **Log results are saved when you move them.** JSON Extract keeps pasted logs and previews in the current session. **Move to workspace** creates files and History entries for open results that have not already been moved.
- **History restores your workspace.** The history folder stores internal records, formatting options and extraction state. The import folder controls where the file picker opens.
- **Imports avoid overwriting files.** Files imported from another folder are copied into your JSON file folder. If the folders are the same, JSON Craft works with the existing file.
- **Deletion requires confirmation.** The dialog shows the affected file path. Confirming moves that associated file to the system Trash or Recycle Bin and removes its history entry. A separate external source file is preserved when you imported a copy.

Repair can infer missing content, so review the changes before relying on repaired data. Ordinary formatting preserves number literals, duplicate keys and valid escapes; recursive unescaping intentionally turns embedded JSON strings into structured values when enabled.

### Large JSON files

Files up to 20 MiB are supported. The diff view renders long escaped strings as virtual display rows while preserving original content, line numbers, search, Copy and Export. If wrapping would exceed the browser's safe rendering height, it automatically switches to bounded sections with horizontal scrolling and shows a notice.

## Feedback

Found a problem or have a feature request? [Open an issue](https://github.com/HANYIIK/json-craft/issues). Include your operating system, app version and a small anonymized example when possible.

Built with Electron, React, CodeMirror and [jsonrepair](https://github.com/josdejong/jsonrepair).
