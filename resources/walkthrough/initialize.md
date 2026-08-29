## Build the graph for this repository

`kin init` reads the folder you have open and writes the graph to `.kin/`,
beside your `.git`. It never writes to your `.git`.

The button on this step runs it here. Its output streams into the Kin output
channel as it goes, so you read what the CLI itself reports, including a
refusal, rather than a summary of it.

First runs are not instant, and embedding time scales with repository size.
Graph overview, entity browsing and name search work before the vectors land.

No `kin` binary yet? Install it first:

```sh
curl -fsSL https://get.kinlab.dev/install | sh
```
