# Safe configuration utility

`.orchestrator/scripts/dev-config.sh` is the supported interface for reading and
writing environment files and JSON configuration without printing credentials.
Keys matching credential patterns are masked in all command output.

## JSON value types

`file set` interprets a value as JSON when it is a valid JSON literal and falls
back to a string otherwise:

```bash
.orchestrator/scripts/dev-config.sh file set config.json autoStart false
.orchestrator/scripts/dev-config.sh file set config.json modelsMax 3
.orchestrator/scripts/dev-config.sh file set config.json guard '{"enabled":true}'
.orchestrator/scripts/dev-config.sh file set config.json label router
```

These write a boolean, number, object, and string respectively. `null`, arrays,
and quoted JSON strings are also preserved. Dotted paths such as
`auth.github.clientId` continue to create or update nested objects.

Use explicit JSON quotes when text could otherwise be interpreted as a literal:

```bash
.orchestrator/scripts/dev-config.sh file set config.json label '"false"'
```

This writes the string `"false"`, not the boolean `false`.

## Safety boundary

Do not read `.env` or credential-bearing JSON directly. Use `env get/list` or
`file get/list`, which mask keys containing `TOKEN`, `SECRET`, `KEY`,
`PASSWORD`, `CREDENTIAL`, `API_KEY`, or `APIKEY`.
