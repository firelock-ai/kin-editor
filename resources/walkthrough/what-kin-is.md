## Software that remembers itself.

Git shows which lines changed. Kin shows what the change affects.

Kin keeps a living map of the software itself so humans and agents can
understand what every change touches. It runs beside Git and it never writes to
your `.git`.

In this editor that map becomes an entity explorer, semantic search over meaning
rather than text, trace, go-to-definition, graph-backed review and semantic
rename.

The extension does not build a second index. Every answer comes from the local
Kin runtime, over MCP when that connection is live and the `kin` CLI when it is
not.
