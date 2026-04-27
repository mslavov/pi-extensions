# pi-markitdown

Read non-text files (PDF, DOCX, XLSX, PPTX, etc.) as Markdown using [Microsoft's MarkItDown](https://github.com/microsoft/markitdown).

## What it does

Extends the `read` tool to automatically convert supported file types to Markdown via the MarkItDown CLI. When you `read` a PDF, Word document, spreadsheet, or other supported format, the content is converted to clean Markdown that the LLM can understand.

Converted files are cached as `.md` files in `~/.pi/markitdown-cache/`, so offset/limit navigation and headroom compression all work naturally on the converted content.

## Supported file types

| Category     | Extensions                                    |
| ------------ | --------------------------------------------- |
| Documents    | `.pdf`, `.docx`, `.doc`, `.pptx`, `.ppt`      |
| Spreadsheets | `.xlsx`, `.xls`                               |
| Rich text    | `.rtf`                                        |
| eBooks       | `.epub`                                       |
| Archives     | `.zip`                                        |
| Email        | `.msg`                                        |
| Images       | `.jpg`, `.jpeg`, `.png`, `.bmp`, `.tiff`, `.tif` |
| Audio        | `.wav`, `.mp3`                                |

> **Note:** Text-based formats like `.html`, `.htm`, `.csv`, `.json`, and `.xml` are excluded — the standard `read` tool handles them natively with no benefit from conversion. Images are also excluded from conversion since the read tool handles them natively via vision.

## Installation

The extension auto-installs `markitdown` into a dedicated Python venv (`~/.pi/markitdown-venv/`) on first use. Requires Python ≥3.10.

If `markitdown` is already available on your system PATH, the venv creation is skipped.

## Usage

Just use `read` as normal — the extension intercepts calls for supported file types and replaces the content with the Markdown conversion.

```
/markitdown    # Show status and supported file types
```

## How it works

1. **`tool_call` hook on `read`**: Checks the file extension; if supported, runs `markitdown <file>`, caches the markdown as a `.md` file in `~/.pi/markitdown-cache/`, and rewrites `event.input.path` to the cached file. The read tool then operates on plain text — offset/limit, truncation, and headroom compression all work naturally.
2. **`tool_result` hook on `read`**: Appends a footer to converted results noting the original file path.
3. **System prompt injection**: Adds a note to the system prompt explaining the enhanced `read` behavior.
4. **Auto-install**: On session start, checks if `markitdown` is available. If not, creates a Python venv and installs `markitdown` with document format extras via pip.
5. **Cache invalidation**: Cache keys include the file's mtime, so re-reading a modified file triggers a fresh conversion.
