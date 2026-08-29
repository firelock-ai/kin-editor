## Check what is actually wired

`Kin: Setup Workspace` runs `kin setup status` and shows every row it reports,
with the fix each row carries.

The banner at the top is the CLI's own verdict, not a guess made here.

- **Ready** means every check that applies on this machine is healthy.
- **Needs attention** means nothing about the install is wrong and something is
  not answering at full strength yet. First-run work still in flight reads this
  way, and so does a host below a measured cost.
- **Failing** means something about the install is wrong, or Kin cannot read the
  semantic authority here.

If your `kin` is too old to publish a verdict, the panel says so and tells you it
read the state from the rows instead.
