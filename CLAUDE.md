@AGENTS.md

## Claude-Specific Notes

### Verifying --live-reads mode

The "Verify `--live-reads` is on" check in AGENTS.md uses the MCP tool name `mcp__copilot-money__get_accounts`. In Claude Code, call that tool directly to confirm whether the running server is in live mode or cache mode. To enable live mode, add `--live-reads` to the `args` array of the `copilot-money` entry in `~/.claude.json`, then reload via `/mcp` or restart Claude Code.
