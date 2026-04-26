# pi-autocomplete

Includes gitignored files in pi's `@` file autocomplete while skipping common dependency and cache directories by default.

## Configuration

Create `~/.pi/agent/extensions/pi-autocomplete/config.json` to override the defaults:

```json
{
  "exclude": ["node_modules", ".venv", "vendor", "target"],
  "maxResults": 100,
  "maxSuggestions": 20
}
```

- `exclude` replaces the default exclude list and is passed to `fd --exclude`.
- `.git` is always excluded.
- `maxResults` limits the `fd --no-ignore` scan.
- `maxSuggestions` limits how many gitignored results are appended to pi's built-in suggestions.
