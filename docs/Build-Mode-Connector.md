# The Nexus Connector For Claude - Build Mode Only

Neil, 11/12/2026. A developer's own Claude can read and work their Build
Mode pins through one MCP endpoint. It reaches Build Mode and nothing else
in Nexus.

## What It Is

- Address: `<Nexus API>/build-connector/mcp` (for dev:
  `https://<the dev API host>/build-connector/mcp`).
- Who: someone with the Build Mode grant, holding a Build Token (Build Mode >
  Settings > Build Tokens > Make A Token). The token is the same one the
  terminal tools use; revoke it there and the connector stops for it.
- What it can do - six tools, on the pins YOU sent:
  `my_pins`, `get_pin`, `claim_pins`, `post_progress`, `reply` (with
  `needs_input` for a question), `complete` (records the pull request; never
  merges).
- What it cannot do: anything outside Build Mode; another person's pins;
  uploads (pictures, clips and evidence go through
  `tools/build_notes/cli.py`); a merge.
- It spends nothing of Nexus's. Claude calls Nexus on the developer's own
  Claude subscription; Nexus calls nobody. The AI switch is not involved.

## Turn It On (Neil Or Visesh, Once Per Server)

Azure > the API's app settings > add `NEXUS_BUILD_CONNECTOR` = `true` >
save (the API restarts). Without it the address answers 404, as if it were
not there. Remove the setting to turn it off again.

## Connect Claude Code (Each Developer, Once)

In a terminal, at the repo root:

```
claude mcp add --transport http nexus-build-mode <Nexus API>/build-connector/mcp --header "Authorization: Bearer <your Build Token>"
```

Then `claude mcp list` should show `nexus-build-mode` as connected, and
inside Claude Code "list my Build Mode pins" should call `my_pins`.

The token sits in your own Claude Code settings on your computer. Never
paste it into a chat, a pull request or a file in the repo.

## What Is Proven And What Is Not

- Proven (11/12/2026, locally): the official MCP client library connected,
  agreed a protocol version, listed the six tools, read a pin, and was
  refused a pin that was not its own. `backend/test_build_mode_connector.py`
  pins the switch, the token rule, the ownership rule and the tool list.
- Not tried yet: Claude Code itself against the dev server (the command
  above), and claude.ai's own connector list - that one signs in with OAuth,
  which this endpoint does not offer; it is Build Token only for now.
