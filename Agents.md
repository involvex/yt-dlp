# Agents.md - AI Agent Instructions for yt-dlp

This file provides instructions and guidance for AI agents working on the yt-dlp project. It complements the existing CONTRIBUTING.md and README.md files.

## Table of Contents

- [Project Overview](#project-overview)
- [Useful Commands](#useful-commands)
- [Technologies](#technologies)
- [Best Practices and Guidelines](#best-practices-and-guidelines)

---

## Project Overview

yt-dlp is a feature-rich command-line audio/video downloader with support for thousands of sites. It is a fork of youtube-dl based on youtube-dlc.

- **Language**: Python (CPython 3.10+, PyPy 3.11+)
- **License**: Unlicense (public domain)
- **Package Manager**: hatch (uses pyproject.toml)
- **Repository**: https://github.com/yt-dlp/yt-dlp

---

## Useful Commands

### Development Setup

```bash
# Install hatch (project management tool)
pipx install hatch

# Setup development environment
hatch run setup

# Enter development shell with all dependencies
hatch shell
```

### Code Quality and Testing

```bash
# Check code formatting and linting
hatch fmt --check

# Automatically fix formatting and linting issues
hatch fmt

# Run all tests
hatch test

# Run extractor-specific tests
hatch test ExtractorName

# List all extractors
python -m yt_dlp --list-extractors
```

### Building

```bash
# Build standalone executable (PyInstaller)
python devscripts/install_deps.py --include-group pyinstaller
python devscripts/make_lazy_extractors.py
python -m bundle.pyinstaller

# Build platform-independent binary (Unix)
make
```

### Running yt-dlp

```bash
# Run from source
python -m yt_dlp [OPTIONS] URL

# Update to latest version
yt-dlp -U

# Get verbose version info
yt-dlp -vU
```

---

## Technologies

### Core Technologies

- **Python 3.10+**: Primary programming language (CPython and PyPy supported)
- **hatch**: Project management and build tool
- **ruff**: Fast Python linter and formatter
- **autopep8**: Code formatter (PEP 8 compliance)

### Key Dependencies

- **ffmpeg/ffprobe**: Required for merging video/audio and post-processing
- **yt-dlp-ejs**: Required for full YouTube support (JavaScript runtime needed)
- **curl_cffi**: For TLS fingerprint impersonation (optional but recommended)
- **brotli**: Brotli content encoding support
- **requests**: HTTP library
- **websockets**: WebSocket support
- **mutagen**: For embedding thumbnails in metadata

### JavaScript Runtimes (for yt-dlp-ejs)

yt-dlp supports multiple JavaScript runtimes, in priority order:
1. **deno** (recommended)
2. **node**
3. **quickjs**
4. **bun**

---

## Best Practices and Guidelines

### 1. Code Style and Conventions

Follow the coding conventions documented in [CONTRIBUTING.md](CONTRIBUTING.md#yt-dlp-coding-conventions):

- **Quotes**: Use single quotes for strings, double quotes for docstrings
- **Line length**: Soft limit of 100 characters (up to 120 is acceptable)
- **Regular expressions**: Keep them relaxed and flexible; avoid capturing unused groups
- **Error handling**: Use `fatal=False` for optional data extraction
- **Type conversion**: Use utility functions (`int_or_none`, `float_or_none`, `url_or_none`)

### 2. Mandatory vs Optional Metadata

Only these fields are **mandatory** for extraction:
- `id`: Media identifier
- `url` or `formats`: Media download URL(s)

All other metadata fields are **optional** and extraction should be non-fatal. Always use `.get()` or `traverse_obj()` for optional data to prevent extraction failures when data is unavailable.

### 3. Fallbacks and Robustness

- Provide multiple fallback sources for critical metadata
- Use `traverse_obj` for safe nested data extraction
- Handle missing data gracefully - extraction should never crash

### 4. Testing

- Always add at least one test case for new extractors
- Use `hatch test YourExtractor` to run extractor-specific tests
- Tests can use `md5:`, `re:`, `count:`, or specific values for validation
- Include `skip` parameter if tests cannot run automatically (e.g., requires login)

### 5. Pull Request Guidelines

- **Do not use AI-generated code** - understand and explain every line you change
- Open an issue before implementing major features
- Follow the [AI/LLM Policy](CONTRIBUTING.md#automated-contributions-ai--llm-policy)
- Run `hatch fmt --check` before submitting
- Ensure compatibility with Python 3.10+ (CPython) and PyPy 3.11+

### 6. Adding New Extractors

When adding support for a new site:

1. Create extractor in `yt_dlp/extractor/` following the template in CONTRIBUTING.md
2. Add import to `yt_dlp/extractor/_extractors.py` (class name must end with `IE`)
3. Run `hatch test YourExtractorName` to develop and validate
4. Follow all coding conventions
5. Test that the extractor works with real URLs

### 7. Project Structure

```
yt_dlp/
├── extractor/       # Site-specific extractors
├── postprocessor/  # Post-processing modules (ffmpeg, metadata, etc.)
├── networking/      # HTTP request handling
├── downloader/      # Download implementations
├── utils/          # Utility functions and helpers
└── __init__.py     # Main package entry point
```

### 8. Important Files

- **CONTRIBUTING.md**: Detailed contribution guidelines and coding conventions
- **README.md**: Full documentation of features, options, and usage
- **pyproject.toml**: Project configuration and dependencies

### 9. Version Management

- Use `devscripts/update-version.py` to update version numbers
- Version format follows semantic versioning principles
- Check `hatch version` for current version

### 10. Pre-commit Hooks

Always run `hatch run setup` after cloning to install pre-commit hooks. This ensures:
- Code is properly formatted before each commit
- Linting passes before commits are allowed
- Automatic fixes are applied where possible

---

## Additional Resources

- **Wiki**: https://github.com/yt-dlp/yt-dlp/wiki
- **FAQ**: https://github.com/yt-dlp/yt-dlp/wiki/FAQ
- **Discord**: https://discord.gg/H5MNcFW63r
- **Supported Sites**: [supportedsites.md](supportedsites.md)

---

*This file is intended for AI agents. For human contributors, please refer to CONTRIBUTING.md.*