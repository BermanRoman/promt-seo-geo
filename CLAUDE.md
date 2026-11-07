@AGENTS.md

## Вход для Claude Code

Канон системы — `AGENTS.md` (подключён выше), `workflow.md`, `roles/` и `.agents/skills/`. Файлы в `.claude/` — тонкие входы: навык из `.claude/skills/<имя>/` сразу отправляет к `.agents/skills/<имя>/SKILL.md`, подагент из `.claude/agents/<имя>.md` — к `roles/<имя>.md`. Правила меняются только в каноне, не во входах.
