# PlayCount

PlayCount pays open-source projects for what developers' coding agents actually use: each developer funds a monthly budget, and it is split among the projects their agent relied on.

## Language

### Money

**Budget**:
The fixed amount a developer commits to pay each month, split among the projects their agent used.
_Avoid_: Subscription, tip, donation

**Pool**:
The money PlayCount holds between collecting developers' budgets and paying projects.
_Avoid_: Wallet, escrow, balance

**Settlement**:
The monthly event that turns a period's plays into payouts to projects, in one batch.
_Avoid_: Payment run, distribution

**Royalty**:
The amount owed to one project from one settlement.
_Avoid_: Tip, share, payout (a payout is the transfer that delivers a royalty)

### Usage

**Play**:
One instance of a developer's agent relying on a project: reading its docs or writing code that imports it. Package installs are not plays.
_Avoid_: Use, hit, call, download

**Project**:
An open-source package that can earn royalties; it has at most one payout address, and how its team splits money is outside PlayCount.
_Avoid_: Maintainer, library, dependency (a dependency is any installed package, played or not)

**Developer**:
A person who funds a budget and whose coding agent produces plays.
_Avoid_: User, customer, payer

**Agent**:
The coding assistant (e.g. Claude Code) working on a developer's behalf whose plays are counted.
_Avoid_: Bot, assistant
