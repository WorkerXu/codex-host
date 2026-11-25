# Host extension mention fixture

Minimal backend-only extension used by the mention contract tests and isolated Web verification.
It declares one `demo` source, searches three synthetic items, and expands each item to a short
readable block. Each Host expansion is appended to `host-extension-data/mention-sample/mentions.log`.

Install this directory as a `localDir` in the isolated Host and enable `mention-sample`.
