# Agent instructions

- This repository is public. Keep it generic: don't reference private deployments, servers or modules built on top of it.
- Stick to best practices of the frameworks used; check current documentation instead of relying on memory.
- Before pinning a new dependency, check its current version on the registry (`npm view <pkg> version`). Pin exact versions.
- Write concise comments that explain current behavior, constraints or intent. Don't document refactor history.
- Tables holding per-guild data are created with `guildTable()`; tables shared by all guilds with `globalTable()`. Never create tables any other way: startup checks reject them.
- Database access in handlers goes through `ScopedDb.run()`; one `run` is one transaction.
