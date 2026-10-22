# PlayCount

PlayCount pays open-source projects for what developers' coding agents actually use: each developer funds a monthly budget, and it is split among the projects their agent relied on.

## Language

### Money

**Budget**:
The fixed amount a developer commits to pay each month, split only among the projects their own agent played.
_Avoid_: Subscription, tip, donation

**Pool**:
The money PlayCount holds between collecting developers' budgets and paying projects.
_Avoid_: Wallet, escrow, balance
A developer's budget never pays for another developer's plays. PayPal payout fees come out of the pool, so a project receives its full royalty.

**Settlement**:
The monthly event that turns a period's plays into payouts to projects, in one batch.
_Avoid_: Payment run, distribution

**Royalty**:
The amount owed to one project from one settlement.
_Avoid_: Tip, share, payout (a payout is the transfer that delivers a royalty)

**Unclaimed royalty**:
A royalty owed to a project that has no payout address yet; it stays in the pool until the project is claimed.
_Avoid_: Pending payout, escrowed funds

**Rollover**:
A royalty under $1, or a budget whose agent made no plays that month, carried into the developer's next settlement instead of being paid.
_Avoid_: Carry-forward, remainder

**Ledger**:
PlayCount's record of every Play, Budget, Weighting, Royalty and payout; the Pool is derived from it, never kept as a separate balance.
_Avoid_: Database, books, account

**Period**:
The calendar month (UTC) whose plays one settlement covers, written YYYY-MM.
_Avoid_: Cycle, window, billing month

**Statement**:
A developer's per-project totals for one period: import plays, docs plays and lines written.
_Avoid_: Report, invoice, bill

**Weighting**:
The share of a developer's budget each project gets in a settlement, proposed by an AI model from the period's plays with a one-line reason and approved by the developer, or auto-approved after 7 days.
_Avoid_: Score, ranking, split ratio

### Usage

**Play**:
One instance of a developer's agent relying on a project: reading its docs or writing code that imports it. Package installs are not plays.
_Avoid_: Use, hit, call, download

**Play log**:
The record of a developer's plays (project, kind of play, lines written against it) that PlayCount receives; it never contains source code.
_Avoid_: Telemetry, usage data, transcript

**Project**:
An open-source package that can earn royalties; it has at most one payout address, and how its team splits money is outside PlayCount.
_Avoid_: Maintainer, library, dependency (a dependency is any installed package, played or not)
Only npm packages are projects for now.

**Claim**:
A maintainer proving control of a project by signing in with GitHub, having push access to the repo named in the package's npm `repository` field, and giving the project's payout address.
_Avoid_: Registration, verification, onboarding

**PlayCount key**:
The secret a Developer's capture hook sends with each batch of Plays so PlayCount knows whose Plays they are.
_Avoid_: API key, token, password

**Developer**:
A person who funds a budget and whose coding agent produces plays.
_Avoid_: User, customer, payer

**Agent**:
The coding assistant (e.g. Claude Code) working on a developer's behalf whose plays are counted.
_Avoid_: Bot, assistant
